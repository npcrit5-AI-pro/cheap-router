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
- **Same-origin POSTs only.** POST endpoints (`/api/key`, `/api/chat`, `/api/route`) accept only `application/json` requests, which forces a CORS preflight that the server never approves. Any foreign `Origin` or a cross-site `Sec-Fetch-Site` is also refused, so other websites can't set or save your key or spend your credits.
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

## API
`GET /api/models`, `POST /api/route {prompt}` (dry run), `POST /api/chat {messages}`, `POST /api/key {key}`, `GET /api/shares`.
