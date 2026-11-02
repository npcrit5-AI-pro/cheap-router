# cheap-router

A tiny chat app that only uses OpenRouter models priced at or below **Claude Haiku 5.5**, plus free models. A small heuristic router picks the model for each prompt.

## Setup
Requires Node 18+. There are no npm dependencies.
```bash
cp .env.example .env   # put OPENROUTER_API_KEY=... in it (or export the env var)
npm start              # http://localhost:3000  (PORT env to change)
npm test               # checks the price filter + shows sample routing
```
You can also paste the key into the field on the page. By default it is kept only in server memory. Tick **remember** to write it to `.env` in the app folder so it survives restarts. The key is never sent back to the browser. `.env` is gitignored.

## Your key stays local
- The OpenRouter key lives **only on your machine**: in the `OPENROUTER_API_KEY` environment variable, in a local `.env` file (gitignored), or in the server's memory.
- The key is sent only to `openrouter.ai`. It is never returned to the browser, never logged, and never committed.
- Don't commit `.env` or `usage.json`. Both are in `.gitignore`.

## Security defaults
- **Network binding.** The server binds to **127.0.0.1** by default. Set `HOST` to change this, but exposing it to a network lets anyone there spend your key.
- **Allowed hosts.** Requests whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]` are refused. This blocks DNS rebinding.
- **Same-origin POSTs only.** POST endpoints (`/api/key`, `/api/chat`, `/api/route`, `/api/mode`, `/api/apis/call`) accept only `application/json` requests, which forces a CORS preflight that the server never approves. Any foreign `Origin` or a cross-site `Sec-Fetch-Site` is also refused, so other websites can't set or save your key or spend your credits.
- **No file serving.** The server returns one fixed file, `public/index.html`. It does not serve arbitrary paths, so path traversal is not possible.
- **Error scrubbing.** URLs, long hex ids and anything that looks like a key are removed from upstream error text before it reaches the UI.

## Eligible models
At startup the server fetches `https://openrouter.ai/api/v1/models` and caches the list for 1 hour; `/api/models?refresh` forces a refetch. The price cap is `anthropic/claude-haiku-5.5`'s prompt and completion prices. If that model is missing, the newest Claude Haiku is used instead. A model is eligible when both of its prices are at or under the cap, or when it is free. Batch endpoints, variable-price routers and non-text models are excluded.

### Price exceptions and preferred models
`ALWAYS_ALLOW` in `router.js` is a list of model ids that are always eligible, even above the price cap. It is currently empty. `STRONG` gives preferred models a +60 boost for certain categories. Right now `meta/muse-spark-1.3-contributor` is boosted for reasoning and creative prompts.

## Router (router.js)
1. **Classify** the last user message. The first match wins:
   - **code**: code keywords or syntax
   - **reasoning**: math or logic keywords, arithmetic, or prompts over 1500 chars
   - **creative**: writing keywords
   - **chat**: everything else
2. **Score** every eligible model:
   - +30 if its name hints at the category (e.g. `coder`, `r1`/`reason`, `flash`/`mini`)
   - +25 if it supports `reasoning` (reasoning prompts)
   - +10 if it supports `tools` (code prompts)
   - free: +40 for chat, +10 otherwise
   - a small bonus for larger context
   - a penalty that grows with price
   - models whose context can't fit the prompt are dropped
3. **Call** the top model. On an error or rate limit, try the next one (up to 4).
4. The UI shows the model that answered, the category, the reasons it was picked, and any fallbacks.

## Usage shares (alloc.js)
Over time, the app aims for these shares of all answered prompts:
- **`meta/muse-spark-1.3-contributor`: 50%**
- **`anthropic/claude-haiku-5.5`: 10%.** It is priced exactly at the cap, so it is eligible.
- **Every other eligible model** gets a slice of the remaining 40%. The slice is proportional to a quality score: +context length, +free, +reasoning support, +tools support. Each slice is clamped to [0.001%, 8%] and the rest is renormalized.

Selection is **deterministic** and never random. It works like weighted fair queueing:
- Each model has a `deficit = target × (N+1) − count`, the number of picks it is owed. N is the total number of successful answers.
- The `fit` (from the router score, normalized to 1–2) is multiplied by the deficit, and the highest product wins.
- Ties go to the model id in alphabetical order.
- Because the deficits always sum to 1 and fit is bounded, actual shares converge on the targets. Task fit still tilts each choice, so code prompts go to code models when those models are owed picks.
- If the pick fails, the next one in the same order is tried.
- Usage is counted **only on success**, in `usage.json`. Set `USAGE_FILE` to use another path. This file is gitignored.

The UI shows the target and actual share for each pick, plus a collapsible table of every model's shares.

`npm test` runs the price-filter test and `sim.test.js`. The sim test runs 10,000 mixed prompts twice. It checks that Contributor is about 50% and Haiku about 10%, every other model is at or under 8%, and both runs make identical picks.

## Modes
The page shows four routing-mode radio cards plus two independent toggle cards:
- **Cheap Router** (default) — routes across the normal price-capped pool.
- **Hacker Mode** — the three uncensored models at equal ~1/3 shares; ignores the price cap. See below.
- **Speed Run** — same pools as above, but ordered by measured speed: the request goes to whichever model in the chosen pool has the fastest recent median reply time. A small pool selector on the card picks the cheap pool or the hacker pool. See below.
- **Council of Three** — asks all three hacker models at once and shows every answer side by side. See below.
- **Free Web APIs** — independent on/off toggle that stacks on top of any routing mode except Council: when on, the model can call a toolbox of free keyless web APIs for live data. See below.
- **Budget Guard** — independent spend-cap toggle that works alongside any routing mode: a dollar ceiling; past 80% only free models answer, at 100% requests stop. See below.

The four routing modes are mutually exclusive (radio group); the two toggles are separate on/offs. All choices last for the browser session only (kept in `sessionStorage`, ceiling also in `localStorage`, plus server memory via `POST /api/mode`; never written to `.env`). Every chat request carries its own `mode`/`webApis`/`speedPool`/budget fields, so the server routes each request by what the client sent — the globals are only the fallback for clients that omit them, and each chat re-syncs them, so `/api/status` keeps reporting the values actually used. On load and after every send the page compares itself against `/api/status` and, on any mismatch, adopts the server's values with a one-line warning instead of displaying a stale mode. Every reply is tagged with the mode that routed it, and the UI raises a red `OUT-OF-POOL MODEL` badge if a hacker-pool reply ever names a model outside the hacker list.

## Hacker mode
When on, the router ignores the price cap (and `ALWAYS_ALLOW`) and routes every prompt to exactly three uncensored/open models. Classification and scoring are unchanged, so task fit still tilts each pick within the three, and the same deterministic deficit-weighted allocation from `alloc.js` is used — but with equal targets (1/3 each) instead of the normal 50/10 split, so over time each of the three answers about a third of prompts. If a model fails, the next candidate is tried, staying within the three.

The three models (exact OpenRouter ids, prices per million tokens):
- `z-ai/glm-5.3-flash` — $0.0285/$0.0923 per M, 1M ctx
- `cognitivecomputations/dolphin-mistral-24b-venice-edition` — $0.2/$0.9 per M, 128k ctx
- `mistralai/mistral-nemo` — $0.029/$0.03 per M, 131k ctx

Note: these are third-party uncensored models whose output is not moderated by this router. You are responsible for what you send them and what you do with their replies.

In hacker mode the server also prepends a system prompt (shown in full under the mode boxes via a collapsible "system prompt" section, hacker mode only) that tells the model to be direct: answer the question first, skip lectures, warnings, moralizing, crisis-line boilerplate and unasked-for "safe alternatives", and treat controversial-but-legal subjects as fair game. The carve-out is explicit and narrow: requests for instructions or assistance related to weapons, explosives, or causing real-world harm to people or property are still refused.

## Speed Run
Speed Run is a latency-priority ordering layered on an existing pool, not a fourth model set: it picks within the cheap pool or the hacker pool (card selector), reusing that pool's candidates, targets and guarantees — including the hacker system prompt when running inside the hacker pool. The server keeps a small in-memory rolling record per model id (last 10 successful reply latencies; failures are never recorded) and orders candidates by median, fastest first. With no measurements yet it falls back to the normal deficit-weighted order, so the first requests behave sensibly and each success produces a measurement; models with no data yet are tried last. Share bookkeeping is untouched — every success still counts, so the shares view stays meaningful. Median latencies are exposed on `GET /api/latency` (and per-row in `GET /api/shares`) and shown under the Speed Run card. Caveats: latencies live in server memory only (a restart wipes them), and "fastest" means fastest to answer, not best — a quick bad answer still wins.

## Council of Three
Council mode fans your question out to all three hacker models at once (`Promise.allSettled`) and shows every answer in its own labeled block — model, price per M, latency and cost each — side by side (stacked on narrow screens). Answers are never merged or summarized; disagreement is the point. One success is enough for a reply; if one model errors, the other blocks still show with the failure named and its reason kept. All three get the hacker-mode system prompt, and out-of-pool answers are structurally impossible (the fan-out list is built from the hacker pool, and each block is still pool-checked in the UI). Cost is roughly 3× a single answer: every reply shows the summed total, computed from each response's reported token usage and that model's per-M prices. Council gives plain answers only — the web-API tool loop is deliberately not fanned out, so Free Web APIs has no effect here. Each success feeds the same latency record Speed Run reads, and each counts toward shares.

## Budget Guard
Budget Guard is an independent toggle (stacks with any routing mode) that sets a dollar ceiling. The server keeps a running spend estimate — computed from each response's reported `usage` token counts times that model's per-M prices, summed across every mode including Council's triple answers. Responses without usage add $0 (documented, never guessed from character counts). At 80% of the ceiling the server restricts routing to free-tier / zero-price models and marks replies `BUDGET GUARD`; if the active pool has no free models it proceeds with the full pool but still marked, so the state is never hidden. At 100% new requests are refused with HTTP 402 and a plain message naming spend vs ceiling. The card shows spend / ceiling with a bar (amber when engaged, red when refusing) and a reset-spend button; the ceiling persists in `localStorage`, spend lives in server memory with the reset button (a server restart also zeroes it). Guard state is visible in `GET /api/status` (`guard: {on, ceiling, spend, ratio, state}` where state is `ok`/`engaged`/`refused`). Caveat: spend is an estimate — providers that omit `usage` contribute $0, so treat the ceiling as approximate, not audited billing.

## Free Web APIs
When the Free Web APIs box is on, the chat passes a catalog of free, public, keyless HTTPS APIs to the model as callable tools (OpenAI-compatible function calling via OpenRouter): weather, country data, crypto prices, exchange rates, geocoding, IP info, DNS, dictionaries, jokes, ISS position, recipes, books and library catalogs, public-domain texts, preprints, holidays, web search, instant answers, page reading and more. The model may call tools for up to 4 rounds (call → result fed back → continue) before answering. Replies list which APIs were used as small chips under the answer. If the picked model does not support tools, the chat falls back to a plain answer.

The catalog lives in `apis.js` (id, name, category, model-facing description, URL template, declared params, and a result mapper that keeps responses small). `npm run apis` (`apis.check.js`) live-verifies every entry with sample params and reports status, latency and mapper output — run it when touching the catalog. It is separate from `npm test` precisely so the test suite never needs the network for this.

Security: tools execute server-side only, behind `POST /api/apis/call`. Only URLs generated from the catalog template can be fetched, the host must match that entry, HTTPS only, never a caller-supplied URL — treat the allowlist as a security boundary. Calls have an 8s timeout and a ~200KB response cap, accept JSON or text only, and failures come back as a clean error object, never a throw.

Search and reading tools: `marginalia-search` (independent non-commercial web index; strong on obscure/old-web content, weak on news), `ddg-instant` (DuckDuckGo instant answers — a topic summary for encyclopedic lookups, explicitly not a ranked search and often empty), and `jina-reader` (fetches one user-supplied page URL as text, first ~8000 chars). The reader embeds the target as a single encoded path segment (`{url+}`) and vets it first: only `http(s)`, no credentials, no localhost/private/link-local/reserved hosts (including numeric-IP tricks, which the URL parser normalizes before checking) — and the catalog host check still applies on top, so only `https://r.jina.ai/<encoded target>` is ever requested.

## API
`GET /api/models`, `POST /api/route {prompt, mode?, speedPool?}` (dry run, honors the requested mode/speed pool), `POST /api/chat {messages, mode, webApis, speedPool?, budgetOn?, budgetCeiling?}` (absent fields fall back to the server's current values), `POST /api/key {key}`, `POST /api/mode {mode, webApis, speedPool?, budgetOn?, budgetCeiling?}` (`mode` is `cheap`/`hacker`/`speed`/`council`; the old `{hacker:bool}` body still works), `GET /api/status` (also reports `speedPool`, `apiCount`, and `guard`), `GET /api/latency` (median reply ms per model), `POST /api/budget {on?, ceiling?}` or `{resetSpend:true}`, `GET /api/apis` (catalog metadata), `POST /api/apis/call {id, params}`, `GET /api/shares` (rows also carry `latencyMs`).
