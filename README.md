# Agentic Data API on Cloudflare Workers

Cloudflare Worker using Hono and x402 v2. Paid routes return compact metadata from CoinSpectrum, GDELT, OpenAlex, Crossref and Wikidata.

## Live configuration

- Network: Base mainnet (`eip155:8453`), USDC.
- Facilitator: PayAI (`https://facilitator.payai.network`).
- Recipient: public EVM wallet configured in `X402_PAY_TO`.
- Current price: `$0.003` (0.003 USDC) per call; the live `PAYMENT-REQUIRED` challenge is authoritative.
- OpenAlex works without an API key at a lower anonymous budget. An optional free key can be created at OpenAlex and saved with `npx wrangler secret put OPENALEX_API_KEY` to increase its budget; this project does not require it.

## Paid endpoints

| Endpoint | Data | Query |
| --- | --- | --- |
| `GET /v1/token?slug=bitcoin` | CoinSpectrum structured token snapshot and available live metrics | Exactly one of `slug` or `symbol` |
| `GET /v1/token?symbol=BTC` | CoinSpectrum live ticker metrics; duplicate tickers can be ambiguous | `symbol` |
| `GET /v1/news/search?q=climate%20policy&limit=5` | GDELT article metadata and source links (no article text) | `q` required, `limit` 1–10 (default 5) |
| `GET /v1/research/search?q=large%20language%20models&limit=5` | OpenAlex and Crossref bibliographic records (no abstracts/full text) | `q` required, `limit` 1–10 (default 5) |
| `GET /v1/entities/search?q=Marie%20Curie&language=en&limit=5` | Wikidata entity IDs, labels, descriptions and canonical links | `q` required, language defaults to `en`, `limit` 1–10 |

All paid routes use the same configured x402 price. Invalid query parameters return explanatory JSON HTTP 400 before payment is requested. Provider errors include machine-readable error codes, provider status when available, and retry guidance. Scholarly search can return partial results if either OpenAlex or Crossref is unavailable.

## x402 client flow

1. Request a route normally.
2. On HTTP 402, read `PAYMENT-REQUIRED`. The compatibility header `X-402-Payment-Required` mirrors it.
3. Use an x402 v2 client supporting exact EVM payments on Base to sign the challenge.
4. Retry the identical URL with `PAYMENT-SIGNATURE` (compatibility alias `x-402-payment-proof` is accepted).
5. Parse the returned JSON. Do not hard-code price or recipient; use the live challenge.

Example to inspect the challenge without sending funds:

```powershell
curl.exe -i "https://agentic-token-data-api.edirinacio1996.workers.dev/v1/news/search?q=climate%20policy&limit=3"
```

The first response should be HTTP 402 and include payment headers. A 402 is only a payment challenge, not a completed transaction. `/healthz` is free.

## Data license and attribution

- CoinSpectrum: CC BY 4.0. Keep response attribution. Live metrics update about every 60 seconds; asset snapshots about every 6 hours. See <https://coin-spectrum.com/api/>.
- GDELT: commercial reuse is free under project terms with attribution. We return metadata and links, not article contents. See <https://gdeltproject.org/about.html>.
- OpenAlex: CC0. See <https://help.openalex.org/api/>.
- Crossref: bibliographic facts are generally not subject to copyright; Crossref-generated data is CC0. Abstracts may be copyrighted and are omitted. See <https://www.crossref.org/documentation/retrieve-metadata/rest-api/>.
- Wikidata structured data: CC0; credit is appreciated. See <https://www.wikidata.org/wiki/Wikidata:Licensing>.

Source coverage, freshness and completeness vary. GDELT metadata does not grant rights to reuse the underlying linked article. The API is informational; it does not guarantee source accuracy.

## Telegram access alerts

After a payment settles and a paid endpoint is reached, the Worker can send Telegram notifications. It also sends HTTP 402 alerts for requests whose User-Agent matches a known AI crawler or x402 client. This is a heuristic: User-Agents can be spoofed or omitted. Alerts are throttled per detected agent, route and query for 10 minutes per warm Worker isolate. They include route, sanitized query parameters, status, price and time, never a payment signature or wallet secret.

Secrets are managed with `npx wrangler secret put TELEGRAM_BOT_TOKEN` and `npx wrangler secret put TELEGRAM_CHAT_ID`. Never commit bot tokens, wallet recovery phrases, or private keys.

## Discovery

- OpenAPI 3.1: `/openapi.yaml`
- Agent instructions: `/llms.txt`
- AI plugin manifest: `/ai-plugin.json`
- Robots: `/robots.txt`
- Sitemap: `/sitemap.xml`
- x402 Bazaar discovery declaration is included on each paid route.

Discovery files help compatible clients find and understand the service, but do not guarantee catalog indexing or traffic.

## Local development and deployment

Requirements: Node.js 20+.

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npm run dev
npx wrangler login
npm run deploy
```

Worker URL: <https://agentic-token-data-api.edirinacio1996.workers.dev>.

`X402_PAY_TO` is a public receiving address; the Worker does not need its private key. Never put a recovery phrase or private key in Cloudflare or this project.

