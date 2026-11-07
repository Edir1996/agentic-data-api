import { Hono } from 'hono';
import { z } from 'zod';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { bazaarResourceServerExtension, declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';

const DEFAULT_FACILITATOR = 'https://facilitator.payai.network';
const DEFAULT_TEST_PAY_TO = '0x0000000000000000000000000000000000000001';
const COINSPECTRUM_BASE_URL = 'https://coin-spectrum.com/api/v1';
const ATTRIBUTION = 'Data by CoinSpectrum — https://coin-spectrum.com';
const GDELT_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const OPENALEX_URL = 'https://api.openalex.org/works';
const CROSSREF_URL = 'https://api.crossref.org/works';
const WIKIDATA_URL = 'https://www.wikidata.org/w/api.php';
const API_ORIGIN = 'https://agentic-token-data-api.edirinacio1996.workers.dev';
const UPSTREAM_TIMEOUT_MS = 10_000;
const GDELT_TIMEOUT_MS = 20_000;
const LIVE_CACHE_MS = 45_000;
const ASSET_CACHE_MS = 5 * 60_000;
const MAX_ASSET_CACHE_ENTRIES = 200;
const TELEGRAM_TIMEOUT_MS = 4000;
const UNPAID_AGENT_ALERT_COOLDOWN_MS = 10 * 60_000;
const MAX_UNPAID_AGENT_ALERT_KEYS = 500;

let cachedApp;
let cachedConfigKey;
let liveCache = { expiresAt: 0, value: null, promise: null };
const assetCache = new Map();
const providerCache = new Map();
const unpaidAgentAlerts = new Map();

const envSchema = z.object({
  X402_NETWORK: z.enum(['eip155:84532', 'eip155:8453']).default('eip155:8453'),
  X402_FACILITATOR_URL: z.string().url().default(DEFAULT_FACILITATOR),
  X402_PRICE_USD: z.string().regex(/^\d+(\.\d{1,6})?$/).refine((value) => Number(value) > 0).default('0.003'),
  X402_PAY_TO: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  OPENALEX_API_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
});

const assetQuerySchema = z.object({
  slug: z.string().trim().toLowerCase().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  symbol: z.string().trim().toUpperCase().min(1).max(20).regex(/^[A-Z0-9._-]+$/).optional(),
}).refine((value) => Boolean(value.slug) !== Boolean(value.symbol), {
  message: 'Provide exactly one of slug or symbol.',
  path: ['slug'],
});

const searchSchema = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});
const wikidataSearchSchema = searchSchema.extend({ language: z.string().trim().regex(/^[a-z]{2,3}$/i).default('en') });

class UpstreamError extends Error {
  constructor(code, message, status = undefined) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = status;
  }
}

function jsonError(c, status, error, message, details = undefined, retry = undefined) {
  return c.json({ error, message, ...(details ? { details } : {}), ...(retry ? { retry } : {}) }, status);
}

function querySummary(query = {}) {
  const entries = Object.entries(query).filter(([, value]) => value !== undefined && value !== null && String(value).length);
  return entries.length
    ? entries.map(([key, value]) => `${key}=${String(value).replace(/[\r\n\t]/g, ' ').slice(0, 100)}`).join(', ')
    : 'sem parâmetros';
}

async function sendTelegramNotification(env, { query, route = '/v1/token', resultStatus, unpaidAgent = null }) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return { ok: false, error: 'TELEGRAM_SECRETS_MISSING' };
  }

  const text = [
    unpaidAgent ? 'Agente de IA detectado — acesso não pago' : 'Agente acessou a API paga',
    `Rota: GET ${route}`,
    `Consulta: ${querySummary(query)}`,
    ...(unpaidAgent ? [`Identificação: ${unpaidAgent.name}`, `User-Agent: ${unpaidAgent.userAgent}`] : []),
    `Resultado: HTTP ${resultStatus}`,
    unpaidAgent
      ? `Pagamento não enviado/confirmado; preço solicitado: ${env.X402_PRICE_USD} USDC na Base`
      : `Pagamento: ${env.X402_PRICE_USD} USDC na Base`,
    `Horário: ${new Date().toISOString()}`,
  ].join('\n');

  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok !== true) {
      return {
        ok: false,
        status: response.status,
        error: typeof result?.description === 'string' ? result.description : 'TELEGRAM_API_REJECTED_MESSAGE',
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.name ?? 'TELEGRAM_REQUEST_FAILED' };
  }
}

function scheduleTelegramNotification(c, env, query, route = '/v1/token') {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const notification = sendTelegramNotification(env, { query, route, resultStatus: c.res.status }).then((result) => {
    if (!result.ok) console.error(JSON.stringify({ event: 'telegram_notification_failed', ...result }));
  });
  if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(notification);
  else void notification;
}

const AI_AGENT_USER_AGENTS = [
  ['OpenAI GPTBot', /gptbot/i],
  ['OpenAI OAI-SearchBot', /oai-searchbot/i],
  ['OpenAI ChatGPT-User', /chatgpt-user/i],
  ['Anthropic ClaudeBot', /claudebot|claude-user|anthropic-ai/i],
  ['Perplexity', /perplexitybot|perplexity-user/i],
  ['Google AI crawler', /google-extended|googleother/i],
  ['Meta AI crawler', /meta-externalagent/i],
  ['Amazonbot', /amazonbot/i],
  ['Applebot AI', /applebot-extended/i],
  ['Bytespider', /bytespider/i],
  ['Cohere AI crawler', /cohere-ai/i],
  ['Mistral AI crawler', /mistralai-user/i],
  ['x402 client/agent', /x402|\bagent\b/i],
];

function identifyAIAgent(userAgent) {
  if (!userAgent) return null;
  const match = AI_AGENT_USER_AGENTS.find(([, pattern]) => pattern.test(userAgent));
  if (!match) return null;
  return { name: match[0], userAgent: userAgent.slice(0, 180) };
}

function shouldSendUnpaidAgentAlert(key, now = Date.now()) {
  for (const [existingKey, expiresAt] of unpaidAgentAlerts) {
    if (expiresAt <= now) unpaidAgentAlerts.delete(existingKey);
  }
  const previousExpiry = unpaidAgentAlerts.get(key);
  if (previousExpiry && previousExpiry > now) return false;
  if (unpaidAgentAlerts.size >= MAX_UNPAID_AGENT_ALERT_KEYS) {
    const oldestKey = unpaidAgentAlerts.keys().next().value;
    if (oldestKey !== undefined) unpaidAgentAlerts.delete(oldestKey);
  }
  unpaidAgentAlerts.set(key, now + UNPAID_AGENT_ALERT_COOLDOWN_MS);
  return true;
}

function scheduleUnpaidAgentNotification(env, executionContext, query, route, agent) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const notification = sendTelegramNotification(env, { query, route, resultStatus: 402, unpaidAgent: agent }).then((result) => {
    if (!result.ok) console.error(JSON.stringify({ event: 'telegram_unpaid_agent_notification_failed', ...result }));
  });
  if (executionContext?.waitUntil) executionContext.waitUntil(notification);
  else void notification;
}

async function fetchCoinSpectrumJson(path) {
  let response;
  try {
    response = await fetch(`${COINSPECTRUM_BASE_URL}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new UpstreamError(
      timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_REQUEST_FAILED',
      timedOut ? `CoinSpectrum exceeded the ${UPSTREAM_TIMEOUT_MS / 1000} second timeout.` : 'The request to CoinSpectrum failed.',
    );
  }

  if (response.status === 404) throw new UpstreamError('ASSET_NOT_FOUND', 'CoinSpectrum has no asset matching this slug.', 404);
  if (response.status === 429) throw new UpstreamError('UPSTREAM_RATE_LIMITED', 'CoinSpectrum rate limit was reached.', 429);
  if (!response.ok) throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'CoinSpectrum returned an unsuccessful response.', response.status);

  try {
    return await response.json();
  } catch {
    throw new UpstreamError('UPSTREAM_INVALID_JSON', 'CoinSpectrum returned malformed JSON.');
  }
}

async function fetchLiveData() {
  if (liveCache.value && Date.now() < liveCache.expiresAt) return liveCache.value;
  if (liveCache.promise) return liveCache.promise;

  liveCache.promise = fetchCoinSpectrumJson('/live.json')
    .then((value) => {
      if (!value || typeof value.assets !== 'object' || !value.assets) {
        throw new UpstreamError('UPSTREAM_INVALID_SCHEMA', 'CoinSpectrum live data is missing the assets map.');
      }
      liveCache = { value, expiresAt: Date.now() + LIVE_CACHE_MS, promise: null };
      return value;
    })
    .catch((error) => {
      liveCache.promise = null;
      throw error;
    });
  return liveCache.promise;
}

async function fetchAsset(slug) {
  const cached = assetCache.get(slug);
  if (cached && Date.now() < cached.expiresAt) {
    assetCache.delete(slug);
    assetCache.set(slug, cached);
    return cached.value;
  }

  const value = await fetchCoinSpectrumJson(`/assets/${encodeURIComponent(slug)}.json`);
  if (!value?.asset || value.asset.slug !== slug) {
    throw new UpstreamError('UPSTREAM_INVALID_SCHEMA', 'CoinSpectrum asset response does not match the requested slug.');
  }
  assetCache.set(slug, { value, expiresAt: Date.now() + ASSET_CACHE_MS });
  if (assetCache.size > MAX_ASSET_CACHE_ENTRIES) assetCache.delete(assetCache.keys().next().value);
  return value;
}

async function fetchProviderJson(url, provider, headers = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new UpstreamError(
      timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_REQUEST_FAILED',
      `${provider} ${timedOut ? `exceeded the ${timeoutMs / 1000} second timeout` : 'could not be reached'}.`,
    );
  }
  if (response.status === 429) throw new UpstreamError('UPSTREAM_RATE_LIMITED', `${provider} rate limit was reached.`, 429);
  if (!response.ok) throw new UpstreamError('UPSTREAM_UNAVAILABLE', `${provider} returned HTTP ${response.status}.`, response.status);
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    if (/limit\s+(?:requests\s+)?to\s+one every 5 seconds/i.test(body)) {
      throw new UpstreamError('UPSTREAM_RATE_LIMITED', `${provider} asks clients to limit requests to one every 5 seconds.`, 429);
    }
    throw new UpstreamError('UPSTREAM_INVALID_JSON', `${provider} returned malformed JSON.`);
  }
}

async function cachedProviderResult(key, ttlMs, load) {
  const cached = providerCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.promise;
  const promise = load();
  providerCache.set(key, { expiresAt: Date.now() + ttlMs, promise });
  if (providerCache.size > 150) providerCache.delete(providerCache.keys().next().value);
  try { return await promise; }
  catch (error) { providerCache.delete(key); throw error; }
}

function providerError(error) {
  return {
    code: error instanceof UpstreamError ? error.code : 'UPSTREAM_REQUEST_FAILED',
    message: error?.message ?? 'Provider request failed.',
    ...(error?.status ? { status: error.status } : {}),
  };
}

async function searchGdelt({ q, limit }) {
  const cacheKey = `gdelt:${q.toLocaleLowerCase()}:${limit}`;
  return cachedProviderResult(cacheKey, 5 * 60_000, async () => {
  const url = new URL(GDELT_URL);
  url.search = new URLSearchParams({ query: q, mode: 'ArtList', format: 'json', maxrecords: String(limit), sort: 'DateDesc' });
  const data = await fetchProviderJson(url, 'GDELT', {}, GDELT_TIMEOUT_MS);
  if (data?.error || !Array.isArray(data?.articles)) {
    throw new UpstreamError('UPSTREAM_INVALID_SCHEMA', 'GDELT returned an error or an unexpected response schema.');
  }
  const articles = Array.isArray(data?.articles) ? data.articles : [];
  return {
    schemaVersion: '1.0.0', source: 'GDELT DOC 2.0', license: 'Free commercial reuse with attribution under GDELT terms',
    attribution: 'GDELT Project — https://www.gdeltproject.org/', retrievedAt: new Date().toISOString(), query: q,
    count: articles.length,
    results: articles.map((item) => ({
      title: item.title ?? null,
      url: item.url ?? null,
      domain: item.domain ?? null,
      publishedAt: item.seendate ?? null,
      language: item.language ?? null,
      sourceCountry: item.sourcecountry ?? null,
    })),
    caveat: 'Returns article metadata and links, not article text. Verify source rights before fetching or republishing linked content.',
  };
  });
}

function mapOpenAlexWork(work) {
  return {
    id: work.id ?? null,
    doi: work.doi ?? null,
    title: work.title ?? null,
    publicationYear: work.publication_year ?? null,
    type: work.type ?? null,
    citedByCount: work.cited_by_count ?? null,
    authors: (work.authorships ?? []).slice(0, 12).map((entry) => entry.author?.display_name).filter(Boolean),
    venue: work.primary_location?.source?.display_name ?? null,
    landingPage: work.primary_location?.landing_page_url ?? work.doi ?? null,
    isOpenAccess: work.open_access?.is_oa ?? null,
  };
}

function crossrefYear(record) {
  const dateParts = record?.published?.['date-parts']?.[0] ?? record?.['published-print']?.['date-parts']?.[0] ?? record?.['published-online']?.['date-parts']?.[0];
  return Array.isArray(dateParts) && Number.isInteger(dateParts[0]) ? dateParts[0] : null;
}

function mapCrossrefWork(work) {
  const title = Array.isArray(work.title) ? work.title[0] : null;
  const authors = (work.author ?? []).slice(0, 12).map((author) => [author.given, author.family].filter(Boolean).join(' ')).filter(Boolean);
  return {
    doi: work.DOI ? `https://doi.org/${work.DOI}` : null,
    title: title ?? null,
    publicationYear: crossrefYear(work),
    type: work.type ?? null,
    citedByCount: work['is-referenced-by-count'] ?? null,
    authors,
    venue: Array.isArray(work['container-title']) ? work['container-title'][0] : null,
    landingPage: work.URL ?? null,
  };
}

async function searchScholarship({ q, limit }, env) {
  const cacheKey = `scholarship:${q.toLocaleLowerCase()}:${limit}`;
  return cachedProviderResult(cacheKey, 5 * 60_000, async () => {
  const openAlexUrl = new URL(OPENALEX_URL);
  openAlexUrl.searchParams.set('search', q);
  openAlexUrl.searchParams.set('per-page', String(limit));
  openAlexUrl.searchParams.set('select', 'id,doi,title,publication_year,type,cited_by_count,authorships,primary_location,open_access');
  if (env.OPENALEX_API_KEY) openAlexUrl.searchParams.set('api_key', env.OPENALEX_API_KEY);

  const crossrefUrl = new URL(CROSSREF_URL);
  crossrefUrl.searchParams.set('query.bibliographic', q);
  crossrefUrl.searchParams.set('rows', String(limit));
  crossrefUrl.searchParams.set('select', 'DOI,title,author,published,published-print,published-online,container-title,type,URL,is-referenced-by-count');

  const [openAlexResult, crossrefResult] = await Promise.allSettled([
    fetchProviderJson(openAlexUrl, 'OpenAlex').then((data) => {
      if (!Array.isArray(data?.results)) throw new UpstreamError('UPSTREAM_INVALID_SCHEMA', 'OpenAlex response did not include a results array.');
      return data;
    }),
    fetchProviderJson(crossrefUrl, 'Crossref', { agent: `AgenticTokenDataAPI/1.0 (${API_ORIGIN})` }).then((data) => {
      if (!Array.isArray(data?.message?.items)) throw new UpstreamError('UPSTREAM_INVALID_SCHEMA', 'Crossref response did not include a works array.');
      return data;
    }),
  ]);
  const openAlexWorks = openAlexResult.status === 'fulfilled' && Array.isArray(openAlexResult.value?.results)
    ? openAlexResult.value.results.map(mapOpenAlexWork) : [];
  const crossrefWorks = crossrefResult.status === 'fulfilled' && Array.isArray(crossrefResult.value?.message?.items)
    ? crossrefResult.value.message.items.map(mapCrossrefWork) : [];
  if (openAlexResult.status === 'rejected' && crossrefResult.status === 'rejected') {
    throw new UpstreamError('ALL_PROVIDERS_UNAVAILABLE', 'Both OpenAlex and Crossref failed. Retry with exponential backoff.');
  }
  return {
    schemaVersion: '1.0.0', source: ['OpenAlex', 'Crossref'], retrievedAt: new Date().toISOString(), query: q,
    results: { openAlex: openAlexWorks, crossref: crossrefWorks },
    providers: {
      openAlex: { status: openAlexResult.status === 'fulfilled' ? 'ok' : 'unavailable', license: 'CC0', attribution: 'OpenAlex — https://openalex.org/', ...(openAlexResult.status === 'rejected' ? { error: providerError(openAlexResult.reason) } : {}) },
      crossref: { status: crossrefResult.status === 'fulfilled' ? 'ok' : 'unavailable', license: 'Bibliographic facts are generally not copyrightable; Crossref-generated data is CC0', attribution: 'Crossref — https://www.crossref.org/', ...(crossrefResult.status === 'rejected' ? { error: providerError(crossrefResult.reason) } : {}) },
    },
    caveat: 'Only bibliographic metadata is returned; abstracts and article full text are omitted because they may be copyrighted. Provider coverage and metadata quality vary.',
  };
  });
}

async function searchWikidata({ q, limit, language }) {
  const cacheKey = `wikidata:${language}:${q.toLocaleLowerCase()}:${limit}`;
  return cachedProviderResult(cacheKey, 10 * 60_000, async () => {
  const url = new URL(WIKIDATA_URL);
  url.search = new URLSearchParams({ action: 'wbsearchentities', search: q, language, uselang: language, format: 'json', limit: String(limit) });
  const data = await fetchProviderJson(url, 'Wikidata', {
    'user-agent': `AgenticTokenDataAPI/1.0 (${API_ORIGIN})`,
  });
  if (data?.error || !Array.isArray(data?.search)) {
    throw new UpstreamError('UPSTREAM_INVALID_SCHEMA', 'Wikidata returned an error or an unexpected response schema.');
  }
  const entities = Array.isArray(data?.search) ? data.search : [];
  return {
    schemaVersion: '1.0.0', source: 'Wikidata Entity Search', license: 'CC0 1.0',
    attribution: 'Wikidata — https://www.wikidata.org/ (credit appreciated)', retrievedAt: new Date().toISOString(), query: q, language,
    count: entities.length,
    results: entities.map((item) => ({
      id: item.id ?? null,
      label: item.label ?? null,
      description: item.description ?? null,
      url: item.concepturi ?? (item.id ? `https://www.wikidata.org/wiki/${encodeURIComponent(item.id)}` : null),
      match: item.match?.text ?? null,
    })),
  };
  });
}

function validateSearchRoute(schema, route, example, inputSchema) {
  return async (c, next) => {
    const parsed = schema.safeParse(c.req.query());
    if (!parsed.success) {
      return jsonError(c, 400, 'INVALID_QUERY', `Invalid query for ${route}.`,
        parsed.error.issues.map(({ path, message }) => ({ field: path.join('.'), message })),
        `Provide ${example}. No payment was requested for this invalid input.`);
    }
    c.set('searchQuery', parsed.data);
    await next();
  };
}

function discovery(input, inputSchema, outputExample) {
  return declareDiscoveryExtension({ input, inputSchema, output: { example: outputExample } });
}

function upstreamJsonError(c, error, provider) {
  if (error instanceof UpstreamError) {
    const status = error.code === 'UPSTREAM_RATE_LIMITED' ? 503 : 502;
    if (error.code === 'UPSTREAM_RATE_LIMITED') c.header('Retry-After', '5');
    return c.json({ error: error.code, message: error.message, provider, ...(error.status ? { providerStatus: error.status } : {}), retry: 'Retry with exponential backoff. The request was paid only if settlement succeeded; inspect your x402 receipt.' }, status);
  }
  console.error(JSON.stringify({ event: 'provider_error', provider, message: error?.message ?? 'unknown' }));
  return jsonError(c, 500, 'INTERNAL_ERROR', `The ${provider} query could not be completed.`, undefined, 'Retry later with exponential backoff.');
}

function shapeSnapshot({ asset, live, retrievedAt }) {
  const ticker = asset.symbol?.toUpperCase() ?? null;
  const liveQuote = ticker ? live?.assets?.[ticker] ?? null : null;

  return {
    schemaVersion: '2.0.0',
    source: 'CoinSpectrum',
    license: 'CC BY 4.0',
    attribution: ATTRIBUTION,
    retrievedAt: new Date().toISOString(),
    asset: {
      slug: asset.slug ?? null,
      symbol: ticker,
      name: asset.name ?? null,
      category: asset.category ?? null,
      rank: asset.rank ?? null,
      priceUsd: asset.price_usd ?? null,
      marketCapUsd: asset.market_cap_usd ?? null,
      volumeUsd24h: asset.volume_24h_usd ?? null,
      changePercent24h: asset.change_pct_24h ?? null,
      supply: asset.supply ?? null,
      chains: asset.chains ?? null,
    },
    liveMarket: liveQuote ? {
      matchBasis: 'ticker_symbol',
      priceUsd: liveQuote.price_usd ?? null,
      aggregation: liveQuote.method ?? live.aggregation ?? null,
      venues: liveQuote.sources_consulted ?? [],
      venueCount: liveQuote.venue_count ?? null,
      volumeUsd24h: liveQuote.volume_usd_24h ?? null,
      futuresVolumeUsd24h: liveQuote.futures_volume_usd_24h ?? null,
      openInterestUsd: liveQuote.open_interest_usd ?? null,
      turnover: liveQuote.turnover ?? null,
      turnover30d: liveQuote.turnover_30d ?? null,
    } : null,
    dataFreshness: {
      assetSnapshotAt: retrievedAt ?? null,
      assetSnapshotCadence: 'CoinSpectrum structured asset data refreshes about every 6 hours.',
      liveMarketAt: liveQuote ? live.generated_at : null,
      liveMarketCadence: liveQuote ? 'CoinSpectrum live market data refreshes about every 60 seconds; matched by ticker symbol.' : 'No live-market entry was available for this ticker.',
    },
    caveat: 'Informational market data only. Ticker-level live quotes can be ambiguous for assets with duplicate symbols. Not financial advice.',
  };
}

function buildApp(env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid Worker configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const config = parsed.data;

  if (config.X402_NETWORK === 'eip155:8453' && config.X402_PAY_TO === DEFAULT_TEST_PAY_TO) {
    throw new Error('Set X402_PAY_TO to a wallet address you control before enabling Base mainnet.');
  }

  const facilitator = new HTTPFacilitatorClient({ url: config.X402_FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitator)
    .register(config.X402_NETWORK, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);
  let resourceInitialization;

  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok', paymentNetwork: config.X402_NETWORK }));

  app.use('/v1/token', async (c, next) => {
    const parsedQuery = assetQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) {
      return jsonError(
        c,
        400,
        'INVALID_QUERY',
        'Provide exactly one CoinSpectrum asset slug or ticker symbol.',
        parsedQuery.error.issues.map(({ path, message }) => ({ field: path.join('.'), message })),
        'Use ?slug=bitcoin or ?symbol=BTC. No payment was requested for this invalid input.',
      );
    }
    c.set('assetQuery', parsedQuery.data);
    await next();
  });

  app.use('/v1/news/search', validateSearchRoute(searchSchema, '/v1/news/search', '?q=climate%20policy&limit=5', {
    type: 'object', required: ['q'], properties: { q: { type: 'string', minLength: 2, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 } },
  }));
  app.use('/v1/research/search', validateSearchRoute(searchSchema, '/v1/research/search', '?q=large%20language%20models&limit=5', {
    type: 'object', required: ['q'], properties: { q: { type: 'string', minLength: 2, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 } },
  }));
  app.use('/v1/entities/search', validateSearchRoute(wikidataSearchSchema, '/v1/entities/search', '?q=Marie%20Curie&language=en&limit=5', {
    type: 'object', required: ['q'], properties: { q: { type: 'string', minLength: 2, maxLength: 200 }, language: { type: 'string', default: 'en' }, limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 } },
  }));

  app.use('/v1/*', async (c, next) => {
    try {
      if (!resourceInitialization) resourceInitialization = resourceServer.initialize();
      await resourceInitialization;
    } catch (error) {
      resourceInitialization = null;
      console.error(JSON.stringify({ event: 'facilitator_initialization_failed', message: error?.message ?? 'unknown' }));
      return c.json({
        error: 'FACILITATOR_UNAVAILABLE',
        message: 'The x402 facilitator could not initialize or confirm support for Base mainnet USDC.',
        retry: 'Retry shortly. No payment was requested.',
      }, 503);
    }
    await next();
  });

  app.use(
    paymentMiddleware(
      {
        'GET /v1/token': {
          accepts: [{
            scheme: 'exact',
            price: `$${config.X402_PRICE_USD}`,
            network: config.X402_NETWORK,
            payTo: config.X402_PAY_TO,
          }],
          description: 'CoinSpectrum token snapshot with structured asset data and optional ticker-level live market metrics.',
          mimeType: 'application/json',
          serviceName: 'Agentic Data API',
          tags: ['crypto', 'market-data', 'x402', 'ai-agents'],
          extensions: {
            ...declareDiscoveryExtension({
              input: { slug: 'bitcoin' },
              inputSchema: {
                type: 'object',
                properties: {
                  slug: { type: 'string', description: 'CoinSpectrum asset slug, for example bitcoin or ethereum.' },
                  symbol: { type: 'string', description: 'Ticker symbol for live market data, for example BTC or ETH; can be ambiguous.' },
                },
                oneOf: [{ required: ['slug'] }, { required: ['symbol'] }],
              },
              output: {
                example: {
                  schemaVersion: '2.0.0',
                  source: 'CoinSpectrum',
                  license: 'CC BY 4.0',
                  attribution: ATTRIBUTION,
                  asset: { slug: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', priceUsd: 65000 },
                  liveMarket: { matchBasis: 'ticker_symbol', priceUsd: 65010, venueCount: 20 },
                },
              },
            }),
          },
        },
        'GET /v1/news/search': {
          accepts: [{ scheme: 'exact', price: `$${config.X402_PRICE_USD}`, network: config.X402_NETWORK, payTo: config.X402_PAY_TO }],
          description: 'Compact recent news article metadata and links from GDELT DOC 2.0. Article text is not included.',
          mimeType: 'application/json',
          serviceName: 'Agentic Data API',
          tags: ['news', 'gdelt', 'global-events', 'x402', 'ai-agents'],
          extensions: { ...discovery({ q: 'climate policy', limit: 5 }, { type: 'object', required: ['q'], properties: { q: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } } }, { source: 'GDELT DOC 2.0', results: [{ title: 'Example headline', url: 'https://example.org/story', publishedAt: '20261107120000' }] }) },
        },
        'GET /v1/research/search': {
          accepts: [{ scheme: 'exact', price: `$${config.X402_PRICE_USD}`, network: config.X402_NETWORK, payTo: config.X402_PAY_TO }],
          description: 'Search bibliographic metadata across OpenAlex and Crossref. Abstracts and full text are omitted.',
          mimeType: 'application/json',
          serviceName: 'Agentic Data API',
          tags: ['research', 'science', 'scholarly-metadata', 'openalex', 'crossref', 'x402', 'ai-agents'],
          extensions: { ...discovery({ q: 'large language models', limit: 5 }, { type: 'object', required: ['q'], properties: { q: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } } }, { source: ['OpenAlex', 'Crossref'], results: { openAlex: [{ title: 'Example paper', doi: 'https://doi.org/10.0000/example' }], crossref: [] } }) },
        },
        'GET /v1/entities/search': {
          accepts: [{ scheme: 'exact', price: `$${config.X402_PRICE_USD}`, network: config.X402_NETWORK, payTo: config.X402_PAY_TO }],
          description: 'Search Wikidata labels and descriptions and return entity identifiers and canonical URLs.',
          mimeType: 'application/json',
          serviceName: 'Agentic Data API',
          tags: ['wikidata', 'entities', 'knowledge-graph', 'open-data', 'x402', 'ai-agents'],
          extensions: { ...discovery({ q: 'Marie Curie', language: 'en', limit: 5 }, { type: 'object', required: ['q'], properties: { q: { type: 'string' }, language: { type: 'string', default: 'en' }, limit: { type: 'integer', minimum: 1, maximum: 10 } } }, { source: 'Wikidata Entity Search', results: [{ id: 'Q7186', label: 'Marie Curie', description: 'Polish and naturalized-French physicist and chemist' }] }) },
        },
      },
      resourceServer,
      undefined,
      undefined,
      false,
    ),
  );

  // Reaching this middleware means x402 accepted and settled the payment.
  // Send the alert in the background so Telegram latency cannot slow delivery.
  app.use('/v1/token', async (c, next) => {
    await next();
    scheduleTelegramNotification(c, env, c.get('assetQuery'));
  });

  for (const [route, source] of [['/v1/news/search', 'gdelt'], ['/v1/research/search', 'scholarship'], ['/v1/entities/search', 'wikidata']]) {
    app.use(route, async (c, next) => {
      await next();
      scheduleTelegramNotification(c, env, c.get('searchQuery'), route);
    });
  }

  app.get('/v1/token', async (c) => {
    const { slug, symbol } = c.get('assetQuery');
    try {
      const live = await fetchLiveData();

      if (symbol) {
        const liveQuote = live.assets[symbol];
        if (!liveQuote) {
          return c.json({
            error: 'SYMBOL_NOT_FOUND',
            message: 'CoinSpectrum live data has no market entry for this symbol.',
            symbol,
            attribution: ATTRIBUTION,
            retry: 'Check the ticker spelling or use a supported CoinSpectrum asset slug.',
          }, 404);
        }
        return c.json(shapeSnapshot({
          asset: { symbol, name: null, category: null, price_usd: liveQuote.price_usd },
          live,
          retrievedAt: null,
        }));
      }

      const sourceAsset = await fetchAsset(slug);
      return c.json(shapeSnapshot({ asset: sourceAsset.asset, live, retrievedAt: sourceAsset.generated_at }));
    } catch (error) {
      if (error instanceof UpstreamError) {
        if (error.code === 'ASSET_NOT_FOUND') {
          return c.json({
            error: error.code,
            message: error.message,
            slug,
            attribution: ATTRIBUTION,
            retry: 'Check the slug at https://coin-spectrum.com/api/ and retry.',
          }, 404);
        }
        const status = error.code === 'UPSTREAM_RATE_LIMITED' ? 503 : 502;
        return c.json({
          error: error.code,
          message: error.message,
          ...(error.status ? { providerStatus: error.status } : {}),
          retry: 'Retry with exponential backoff. Preserve the same query parameters.',
        }, status);
      }
      console.error(JSON.stringify({ event: 'coinspectrum_error', message: error?.message ?? 'unknown' }));
      return jsonError(c, 500, 'INTERNAL_ERROR', 'The server could not complete the request.', undefined, 'Retry later with exponential backoff.');
    }
  });

  app.get('/v1/news/search', async (c) => {
    try { return c.json(await searchGdelt(c.get('searchQuery'))); }
    catch (error) { return upstreamJsonError(c, error, 'GDELT'); }
  });

  app.get('/v1/research/search', async (c) => {
    try { return c.json(await searchScholarship(c.get('searchQuery'), env)); }
    catch (error) { return upstreamJsonError(c, error, 'OpenAlex/Crossref'); }
  });

  app.get('/v1/entities/search', async (c) => {
    try { return c.json(await searchWikidata(c.get('searchQuery'))); }
    catch (error) { return upstreamJsonError(c, error, 'Wikidata'); }
  });

  app.notFound((c) => jsonError(c, 404, 'NOT_FOUND', 'No API route matches this path.'));
  app.onError((error, c) => {
    console.error(JSON.stringify({ event: 'unhandled_error', message: error?.message ?? 'unknown' }));
    return jsonError(c, 500, 'INTERNAL_ERROR', 'The server could not complete the request.', undefined, 'Retry later with exponential backoff.');
  });
  return app;
}

function getApp(env) {
  const key = [env.X402_NETWORK, env.X402_FACILITATOR_URL, env.X402_PRICE_USD, env.X402_PAY_TO, env.OPENALEX_API_KEY ?? ''].join('|');
  if (!cachedApp || cachedConfigKey !== key) {
    cachedApp = buildApp(env);
    cachedConfigKey = key;
  }
  return cachedApp;
}

export default {
  async fetch(request, env, executionContext) {
    const requestUrl = new URL(request.url);
    if (
      requestUrl.pathname === '/v1/token' &&
      (!env.X402_PAY_TO || env.X402_PAY_TO.toLowerCase() === DEFAULT_TEST_PAY_TO.toLowerCase())
    ) {
      return new Response(JSON.stringify({
        error: 'PAYMENT_RECIPIENT_NOT_CONFIGURED',
        message: 'The API owner must configure a wallet address they control before paid requests are enabled.',
        required: { variable: 'X402_PAY_TO', network: env.X402_NETWORK ?? 'eip155:84532' },
        retry: 'Contact the API operator or retry after the receiving wallet is configured. No payment was requested.',
      }), {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    const headers = new Headers(request.headers);
    const legacyProof = headers.get('x-402-payment-proof');
    const normalizedRequest = legacyProof && !headers.has('payment-signature')
      ? (() => {
          headers.set('payment-signature', legacyProof);
          return new Request(request, { headers });
        })()
      : request;
    const response = await getApp(env).fetch(normalizedRequest, env, executionContext);

    const required = response.headers.get('PAYMENT-REQUIRED');
    if (response.status !== 402 || !required) return response;

    const unpaidAgent = identifyAIAgent(request.headers.get('user-agent') ?? '');
    if (unpaidAgent) {
      const query = {};
      for (const key of ['slug', 'symbol', 'q', 'language', 'limit']) {
        const value = requestUrl.searchParams.get(key)?.trim();
        if (value) query[key] = value.slice(0, 100);
      }
      const selector = querySummary(query);
      const alertKey = `${unpaidAgent.name}|${requestUrl.pathname}|${selector}`;
      if (shouldSendUnpaidAgentAlert(alertKey)) {
        scheduleUnpaidAgentNotification(env, executionContext, query, requestUrl.pathname, unpaidAgent);
      }
    }

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('X-402-Payment-Required', required);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
};

