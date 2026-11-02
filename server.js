const http = require('http'), fs = require('fs'), path = require('path');
const { refreshModels, rank, hackerSet, HACKER_IDS, HACKER_INFO } = require('./router');
const { targets, equalTargets, Usage, order } = require('./alloc');
const { APIS, find, executeApi, toTool, publicCatalog } = require('./apis');

// tiny .env loader (never logs values)
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
} } catch {}
let KEY = process.env.OPENROUTER_API_KEY || '';
let MODE = 'cheap'; // routing mode: 'cheap', 'hacker', 'speed' or 'council'. In-memory only, never written to .env.
let WEBAPIS = false; // free-web-APIs tools toggle. Also in-memory only.
let SPEEDPOOL = 'cheap'; // which pool Speed Run orders by latency: 'cheap' or 'hacker'.
const GUARD = { on: false, ceiling: 0 }; // budget guard: dollar ceiling + toggle, in-memory only.
const SPEND = { total: 0 }; // estimated cumulative spend in dollars, in-memory; reset via /api/budget.
const modeState = () => ({ mode: MODE, hacker: MODE === 'hacker', webApis: WEBAPIS, speedPool: SPEEDPOOL, guard: guardStatus() });
// Parse POST /api/mode (and per-request /api/chat) bodies. New shape
// {mode:'cheap'|'hacker'|'speed'|'council', webApis, speedPool, budgetOn,
// budgetCeiling}; the old {hacker:bool} shape still works (only when mode is
// absent, so it can't clobber an explicit mode). Unknown values are ignored,
// never throw. Absent fields come back null so callers can fall back to globals.
function parseModeBody(b) {
  b = b && typeof b === 'object' ? b : {};
  let mode = null, webApis = null, speedPool = null, budgetOn = null, budgetCeiling = null;
  if (b.mode === 'cheap' || b.mode === 'hacker' || b.mode === 'speed' || b.mode === 'council') mode = b.mode;
  else if (b.hacker === true || b.hacker === 1 || b.hacker === 'true') mode = 'hacker';
  else if (b.hacker === false || b.hacker === 0 || b.hacker === 'false') mode = 'cheap';
  const w = b.webApis !== undefined ? b.webApis : b.webapis;
  if (w === true || w === 1 || w === 'true') webApis = true;
  else if (w === false || w === 0 || w === 'false') webApis = false;
  if (b.speedPool === 'cheap' || b.speedPool === 'hacker') speedPool = b.speedPool;
  else if (b.spool === 'cheap' || b.spool === 'hacker') speedPool = b.spool;
  const bo = b.budgetOn !== undefined ? b.budgetOn : b.budget?.on;
  if (bo === true || bo === 1 || bo === 'true') budgetOn = true;
  else if (bo === false || bo === 0 || bo === 'false') budgetOn = false;
  const bcRaw = b.budgetCeiling !== undefined ? b.budgetCeiling : b.budget?.ceiling;
  const bc = Number(bcRaw);
  if (bcRaw !== undefined && bcRaw !== null && bcRaw !== '' && Number.isFinite(bc) && bc >= 0) budgetCeiling = bc;
  return { mode, webApis, speedPool, budgetOn, budgetCeiling };
}
const usage = new Usage(process.env.USAGE_FILE || path.join(__dirname, 'usage.json'));
// Rolling server-side latency record per model id: last N successful reply
// times in ms. Failures are never recorded. Cold models (no data) report null.
const LATN = 10, LAT = new Map();
function recordLatency(id, ms) {
  if (!id || !Number.isFinite(ms) || ms < 0) return;
  const a = LAT.get(id) || []; a.push(ms); if (a.length > LATN) a.shift(); LAT.set(id, a);
}
function medianLatency(id) {
  const a = LAT.get(id); if (!a || !a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function latencySnapshot() {
  const o = {}; for (const [id, a] of LAT) o[id] = { n: a.length, medianMs: medianLatency(id) }; return o;
}
// Speed Run ordering layered on deficit order: with no measurements at all it
// returns the deficit order untouched (cold start behaves sensibly and every
// attempt produces a measurement); otherwise measured models sort by median
// ascending and unmeasured models sink last, deficit order as tiebreak.
function speedOrder(cands, medFn = medianLatency) {
  if (!cands.some((c) => medFn(c.id) != null)) return cands;
  const pos = new Map(cands.map((c, i) => [c.id, i]));
  return [...cands].sort((a, b) => {
    const la = medFn(a.id), lb = medFn(b.id);
    return (la == null ? Infinity : la) - (lb == null ? Infinity : lb) || pos.get(a.id) - pos.get(b.id);
  });
}
// Spend + budget guard. Cost comes from OpenRouter's reported `usage` and the
// model's per-token prices — never estimated from character counts. Models
// without prices or requests without usage add $0 (documented, not guessed).
function costOf(model, u) {
  if (!model || !u) return 0;
  const p = Number(model.pricing?.prompt), q = Number(model.pricing?.completion);
  if (!Number.isFinite(p) || !Number.isFinite(q)) return 0;
  return (Number(u.prompt_tokens) || 0) * p + (Number(u.completion_tokens) || 0) * q;
}
const money = (x) => '$' + Number(x).toPrecision(3);
const isFreeModel = (m) => !!m && +m.pricing.prompt === 0 && +m.pricing.completion === 0;
// Tri-state guard: 'ok' below 80% of ceiling, 'engaged' (free models only) at
// 80–100%, 'refused' at 100%. Off or a non-positive ceiling means 'ok' always.
function guardStatus(spend = SPEND.total, ceiling = GUARD.ceiling, on = GUARD.on) {
  const ratio = on && ceiling > 0 ? spend / ceiling : 0;
  return { on: !!on, ceiling: +ceiling || 0, spend, ratio,
    state: !on || !(ceiling > 0) ? 'ok' : ratio >= 1 ? 'refused' : ratio >= 0.8 ? 'engaged' : 'ok' };
}
const budgetRefusal = (g) => Object.assign(
  new Error(`Budget guard: ${money(g.spend)} of ${money(g.ceiling)} ceiling spent — raise the ceiling or reset spend to continue`), { status: 402 });
const pct = (x) => (x * 100).toFixed(3) + '%';
// "$prompt/$completion per M tokens" with enough precision for sub-cent prices
const perMTok = (x) => '$' + String(Number((Number(x) * 1e6).toPrecision(4)));
const pricePerM = (m) => `${perMTok(m.pricing.prompt)}/${perMTok(m.pricing.completion)} per M`;
// Candidate pool + share targets for a routing mode. The pool is derived from
// the mode passed in (per request), never from ambient state: a hacker-mode
// request builds candidates ONLY from HACKER_IDS via hackerSet(), so cheap
// models can never leak in, and the MAX_TRIES fallback loop in chat() walks
// this same list. 'speed' layers latency ordering on an existing pool —
// speedPool 'hacker' reuses the exact hacker pool (hacker:true, with the
// hacker system prompt), anything else reuses the cheap pool. 'council' fans
// out over the hacker pool. `mode` defaults to the global only for callers
// that omit it.
function poolFor(c, mode = MODE, speedPool = SPEEDPOOL) {
  if (mode === 'speed') return { ...poolFor(c, speedPool === 'hacker' ? 'hacker' : 'cheap'), speed: true };
  if (mode === 'council') return { ...poolFor(c, 'hacker'), council: true };
  if (mode !== 'hacker') return { models: c.models, tgt: targets(c.models), hacker: false };
  const three = hackerSet(c.all && c.all.length ? c.all : c.models);
  return { models: three, tgt: equalTargets(three), hacker: true };
}
// Effective routing for one request body: client-sent values win; the globals
// are only the fallback for older clients/curl that omit them.
function requestMode(b) {
  const p = parseModeBody(b);
  return { mode: p.mode || MODE, webApis: p.webApis !== null ? p.webApis : WEBAPIS,
    speedPool: p.speedPool || SPEEDPOOL,
    budgetOn: p.budgetOn !== null ? p.budgetOn : GUARD.on,
    budgetCeiling: p.budgetCeiling !== null ? p.budgetCeiling : GUARD.ceiling };
}
const PORT = process.env.PORT || 3000, MAX_TRIES = 4;
const HOST = process.env.HOST || '127.0.0.1'; // localhost only by default; set HOST=0.0.0.0 at your own risk
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostOk = (h) => !!h && LOCAL_HOSTS.has(String(h).replace(/:\d+$/, '').toLowerCase()); // blocks DNS rebinding
// Same-origin check for POSTs: Origin (if sent) must equal http://<Host>, and body must be JSON
// (application/json forces a CORS preflight, which this server never approves).
function sameOrigin(req) {
  const o = req.headers.origin, h = req.headers.host;
  if (o && o !== `http://${h}`) return false;
  const sfs = req.headers['sec-fetch-site']; if (sfs && !['same-origin', 'none'].includes(sfs)) return false;
  return /^application\/json\b/i.test(req.headers['content-type'] || '');
}
// Strip URLs, long hex ids and anything key-like from upstream error text before returning it.
const scrub = (t) => String(t).replace(/https?:\/\/\S+/g, '[url]').replace(/\b[a-f0-9]{24,}\b/gi, '[id]').replace(/sk-[\w-]+/g, '[key]').slice(0, 200);

const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); });

// System prompt prepended to the upstream conversation in hacker mode only
// (cheap mode sends the messages untouched). It steers toward directness and
// against reflexive refusal, with an explicit narrow carve-out: weapons,
// explosives and real-world harm are still refused. It never asks the model
// to ignore its safety training or to roleplay as an AI without limits.
const HACKER_SYSTEM = 'You are answering in an unfiltered chat mode for a capable adult. Be direct: answer the actual question first and skip any preamble, lecture, warning, or disclaimer. Do not moralize, do not hedge with excessive qualifiers, and do not append crisis-line boilerplate or offer "safe alternatives" unless the user asks for them. Adult fiction, dark themes, unsympathetic characters, profanity, fictional violence, drugs, politics, religion, security research, and other controversial-but-legal subjects are all fair game — discuss them plainly and without moral judgment. If a request is genuinely ambiguous, ask one short clarifying question instead of refusing. One boundary stays firm: refuse requests for instructions or assistance related to weapons, explosives, or causing real-world harm to people or property. Refuse those briefly and without a lecture.';
// Prefix the hacker system prompt for hacker-mode requests only. Returns the
// original array untouched for cheap mode, and never stacks a second system
// message onto a conversation that already has one.
function withHackerSystem(messages, mode) {
  if (mode !== 'hacker' || messages.some((m) => m && m.role === 'system')) return messages;
  return [{ role: 'system', content: HACKER_SYSTEM }, ...messages];
}
const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
const orHeaders = () => ({ Authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'X-Title': 'cheap-router' });
async function complete(model, messages, tools) {
  const r = await fetch(OR_URL, { method: 'POST', headers: orHeaders(),
    body: JSON.stringify(tools ? { model, messages, tools, tool_choice: 'auto' } : { model, messages }) });
  const j = await r.json().catch(() => ({}));
  return { r, j };
}
// One plain completion, no tools. Usage (token counts) passes through for
// spend accounting; when OpenRouter omits it the cost is $0, not estimated.
async function plainAnswer(cand, messages) {
  const { r, j } = await complete(cand.id, messages, null);
  const text = j.choices?.[0]?.message?.content;
  if (r.ok && text) return { ok: true, text, apis: [], usage: j.usage };
  return { ok: false, error: `${r.status} ${j.error?.message || 'empty reply'}`, unauthorized: r.status === 401 };
}
// Tool-calling chat: pass the web-API catalog as functions, execute calls
// server-side, feed results back, up to 4 tool rounds, then a final answer.
// If the model can't do tools, fall back to a plain answer (never a 500).
async function chatWithTools(cand, messages, tools) {
  const conv = messages.map((m) => ({ role: m.role, content: m.content ?? '' }));
  const seen = new Map(); let lastUsage;
  for (let round = 0; round < 4; round++) {
    const { r, j } = await complete(cand.id, conv, tools);
    lastUsage = j.usage;
    const msg = j.choices?.[0]?.message, calls = msg?.tool_calls;
    if (!r.ok) {
      if (round === 0 && /tool/i.test(j?.error?.message || '')) return plainAnswer(cand, messages);
      return { ok: false, error: `${r.status} ${j.error?.message || 'empty reply'}`, unauthorized: r.status === 401 };
    }
    if (!calls?.length) {
      if (msg?.content) return { ok: true, text: msg.content, apis: [...seen.values()], usage: lastUsage };
      return { ok: false, error: 'empty reply' };
    }
    conv.push({ role: 'assistant', content: msg.content || '', tool_calls: calls.map((t) => ({ id: t.id, type: 'function', function: { name: t.function?.name, arguments: t.function?.arguments } })) });
    for (const t of calls.slice(0, 8)) {
      const entry = find(t.function?.name);
      let args = {}; try { args = JSON.parse(t.function?.arguments || '{}'); } catch {}
      if (!entry) conv.push({ role: 'tool', tool_call_id: t.id, content: JSON.stringify({ ok: false, error: 'unknown tool' }) });
      else {
        const res = await executeApi(entry, args && typeof args === 'object' ? args : {});
        if (!seen.has(entry.id)) seen.set(entry.id, { id: entry.id, name: entry.name });
        conv.push({ role: 'tool', tool_call_id: t.id, content: JSON.stringify(res.ok ? res.data : { ok: false, error: res.error }).slice(0, 4000) });
      }
    }
  }
  return plainAnswer(cand, conv); // tool rounds used up: final answer on the gathered context
}

// Council of Three: every model in the hacker pool answers the same question
// at once (Promise.allSettled), plain answers only — no tool-calling loop fan
// out. All three get the hacker system prompt. Disagreement is the point, so
// answers are returned side by side, never merged. One success is enough for a
// reply; total loss throws with per-model errors.
const councilMessages = (messages) => withHackerSystem(messages, 'hacker');
// Pure shaping of normalized council results [{id, ok, text, ms, usage,
// error}]; lookup(id) returns the model (for price/cost). Side effects
// (latency/spend/share bookkeeping) stay in councilChat so this is testable.
function shapeCouncil(norm, lookup) {
  const answers = [], failures = [];
  let cost = 0;
  for (const r of norm) {
    if (r.ok) {
      const m = lookup(r.id), mc = costOf(m, r.usage);
      cost += mc;
      answers.push({ model: r.id, text: r.text, ms: r.ms, cost: mc, price: m ? pricePerM(m) : 'unknown price' });
    } else failures.push({ model: r.id, error: scrub(r.error || 'failed') });
  }
  return { answers, failures, cost };
}
async function councilChat(messages) {
  const g = guardStatus();
  if (g.state === 'refused') throw budgetRefusal(g);
  const c = await refreshModels();
  const { models } = poolFor(c, 'council'); // exactly the hacker pool: out-of-pool answers are structurally impossible
  if (!models.length) throw new Error('No hacker models listed by OpenRouter right now');
  let fanout = models, guardNote = '';
  if (g.state === 'engaged') {
    const free = models.filter(isFreeModel);
    if (free.length) { fanout = free; guardNote = 'budget guard engaged: free models only; '; }
    else throw Object.assign(new Error('Budget guard engaged and no free model is in the hacker pool — raise the ceiling or turn the guard off'), { status: 402 });
  }
  const upstream = councilMessages(messages), byId = new Map(models.map((m) => [m.id, m]));
  const t0 = Date.now();
  const settled = await Promise.allSettled(fanout.map(async (m) => {
    const s0 = Date.now();
    const out = await plainAnswer(m, upstream);
    if (!out.ok) throw new Error(out.error);
    return { id: m.id, text: out.text, ms: Date.now() - s0, usage: out.usage };
  }));
  const norm = settled.map((s, i) => s.status === 'fulfilled'
    ? { ...s.value, ok: true }
    : { id: fanout[i].id, ok: false, error: s.reason?.message || String(s.reason) });
  const { answers, failures, cost } = shapeCouncil(norm, (id) => byId.get(id));
  for (const a of answers) { recordLatency(a.model, a.ms); usage.record(a.model); }
  SPEND.total += cost; // one running total across every mode
  if (!answers.length) throw Object.assign(new Error('All three council models failed'),
    { attempts: failures.map((f) => ({ model: f.model, error: f.error })), mode: 'council', hacker: true });
  return { mode: 'council', hacker: true, answers, failures, cost, ms: Date.now() - t0, apis: [],
    price: money(cost) + ' total',
    guard: g.state === 'engaged' ? 'engaged' : undefined,
    why: `${guardNote}council of ${fanout.length}: ` + answers.map((a) => `${a.model} ${(a.ms / 1000).toFixed(1)}s`).join(', ') +
      (failures.length ? `; failed: ${failures.map((f) => `${f.model} (${f.error})`).join(', ')}` : '') +
      '; plain answers, web-api tools skipped' };
}

async function chat(messages, mode, webApis, speedPool = SPEEDPOOL) {
  if (mode === 'council') return councilChat(messages);
  const g = guardStatus();
  if (g.state === 'refused') throw budgetRefusal(g);
  const c = await refreshModels();
  const pool = poolFor(c, mode, speedPool);
  const { models, tgt, hacker } = pool;
  if (!models.length) throw new Error(hacker ? 'No hacker models listed by OpenRouter right now' : 'No eligible models');
  const last = messages[messages.length - 1]?.content || '';
  const plan = rank(String(last), models);
  let cands = order(plan.ranked, tgt, usage);
  if (pool.speed) cands = speedOrder(cands);
  const byId = new Map(models.map((m) => [m.id, m]));
  const tools = webApis ? APIS.map(toTool) : null;
  const upstream = withHackerSystem(messages, hacker ? 'hacker' : 'cheap');
  let candsEff = cands, guardNote = '';
  if (g.state === 'engaged') {
    const free = cands.filter((cd) => isFreeModel(byId.get(cd.id)));
    if (free.length) { candsEff = free; guardNote = 'budget guard engaged: free models only; '; }
  }
  const attempts = [];
  for (const cand of candsEff.slice(0, MAX_TRIES)) {
    try {
      const t0 = Date.now();
      const out = tools ? await chatWithTools(cand, upstream, tools) : await plainAnswer(cand, upstream);
      if (out.ok) { usage.record(cand.id); // count only on success, so shares stay meaningful
        const ms = Date.now() - t0;
        recordLatency(cand.id, ms);
        const cost = costOf(byId.get(cand.id), out.usage);
        SPEND.total += cost;
        const price = pricePerM(byId.get(cand.id) || { pricing: HACKER_INFO[cand.id] || { prompt: NaN, completion: NaN } });
        const modeNote = (hacker ? 'hacker pool (uncensored, equal 1/3 shares); ' : '') + (pool.speed ? 'speed run (fastest recent median first); ' : '') + guardNote + (webApis ? `free web apis on (${out.apis.length} used); ` : '');
        return { reply: out.text, model: cand.id, category: plan.cat, mode, hacker, speed: !!pool.speed, webApis, apis: out.apis, price, ms, cost, guard: g.state === 'engaged' ? 'engaged' : undefined, why: `${modeNote}${plan.why}; picked ${cand.id}: ${cand.why}; fit ${cand.fit.toFixed(2)} × deficit ${cand.deficit.toFixed(2)}; target ${pct(cand.target)}, actual before ${pct(cand.actual)} (now ${pct(usage.share(cand.id))})`, attempts }; }
      attempts.push({ model: cand.id, error: scrub(out.error) });
      if (out.unauthorized) break;
    } catch (e) { attempts.push({ model: cand.id, error: scrub(e.message) }); }
  }
  throw Object.assign(new Error('All candidate models failed'), { attempts, category: plan.cat, mode, hacker });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req.headers.host)) return send(res, 421, { error: 'bad host' });
    if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, { error: 'cross-origin request refused' });
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html'))
      { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' }); return res.end(fs.readFileSync(path.join(__dirname, 'public/index.html'))); } // single fixed file: no path traversal
    if (req.url === '/api/shares') {
      const c = await refreshModels(); const { models, tgt, hacker } = poolFor(c);
      return send(res, 200, { total: usage.total(), hacker, rows: Object.keys(tgt).sort((a, b) => tgt[b] - tgt[a] || (a < b ? -1 : 1)).map((id) => ({ id, target: tgt[id], actual: usage.share(id), count: usage.counts[id] || 0, latencyMs: medianLatency(id), price: models.some((m) => m.id === id) ? pricePerM(models.find((m) => m.id === id)) : undefined })) });
    }
    if (req.url === '/api/status') return send(res, 200, { hasKey: !!KEY, ...modeState(), apiCount: APIS.length });
    if (req.url === '/api/mode') {
      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
      const parsed = parseModeBody(await body(req));
      if (parsed.mode) MODE = parsed.mode;
      if (parsed.webApis !== null) WEBAPIS = parsed.webApis;
      if (parsed.speedPool) SPEEDPOOL = parsed.speedPool;
      if (parsed.budgetOn !== null) GUARD.on = parsed.budgetOn;
      if (parsed.budgetCeiling !== null) GUARD.ceiling = parsed.budgetCeiling;
      return send(res, 200, modeState()); // same-origin + JSON protections apply (checked above for all POSTs); in-memory only
    }
    if (req.url === '/api/latency') // measured median reply latency per model (ms), server-side rolling record
      return send(res, 200, { latency: latencySnapshot() });
    if (req.method === 'POST' && req.url === '/api/budget') {
      const b = await body(req);
      if (b && b.resetSpend) SPEND.total = 0;
      else {
        const parsed = parseModeBody(b);
        if (parsed.budgetOn !== null) GUARD.on = parsed.budgetOn;
        if (parsed.budgetCeiling !== null) GUARD.ceiling = parsed.budgetCeiling;
      }
      return send(res, 200, { guard: guardStatus() });
    }
    if (req.url === '/api/apis') // public catalog metadata only: no fetch logic, no secrets
      return send(res, 200, { count: APIS.length, apis: publicCatalog() });
    if (req.method === 'POST' && req.url === '/api/apis/call') {
      const { id, params } = await body(req);
      const entry = find(String(id || ''));
      if (!entry) return send(res, 400, { ok: false, error: 'unknown api id' });
      const out = await executeApi(entry, params && typeof params === 'object' ? params : {});
      return send(res, out.ok ? 200 : 502, out);
    }
    if (req.url.startsWith('/api/models')) {
      const c = await refreshModels(req.url.includes('refresh'));
      return send(res, 200, { alwaysAllow: require('./router').ALWAYS_ALLOW, cap: c.cap, count: c.models.length, models: c.models.map((m) => ({ id: m.id, prompt: m.pricing.prompt, completion: m.pricing.completion, ctx: m.context_length })), hacker: MODE === 'hacker', hackerIds: HACKER_IDS, hackerInfo: HACKER_INFO, hackerSystem: HACKER_SYSTEM });
    }
    if (req.method === 'POST' && req.url === '/api/key') {
      const { key, save } = await body(req); KEY = String(key || '').replace(/[\r\n]/g, '').trim();
      if (save && KEY) { // persist to .env (never echoed back)
        const f = path.join(__dirname, '.env'); let lines = [];
        try { lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l && !/^\s*OPENROUTER_API_KEY\s*=/.test(l)); } catch {}
        lines.push('OPENROUTER_API_KEY=' + KEY); fs.writeFileSync(f, lines.join('\n') + '\n', { mode: 0o600 });
      }
      return send(res, 200, { hasKey: !!KEY, saved: !!(save && KEY) });
    }
    if (req.method === 'POST' && req.url === '/api/route') {
      const b = await body(req); const c = await refreshModels();
      const { mode, speedPool } = requestMode(b); // dry run honors the requested mode but doesn't move the globals
      const pool = poolFor(c, mode, speedPool);
      const p = rank(String(b.prompt || ''), pool.models);
      const top = pool.speed ? speedOrder(order(p.ranked, pool.tgt, usage)) : order(p.ranked, pool.tgt, usage);
      return send(res, 200, { cat: p.cat, why: p.why, mode, hacker: pool.hacker, speed: !!pool.speed, top: top.slice(0, 5) });
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      if (!KEY) return send(res, 400, { error: 'No OpenRouter API key set' });
      const b = await body(req);
      const { mode, webApis, speedPool, budgetOn, budgetCeiling } = requestMode(b); // route THIS request by what the client sent...
      MODE = mode; WEBAPIS = webApis; SPEEDPOOL = speedPool; GUARD.on = budgetOn; GUARD.ceiling = budgetCeiling; // ...and sync the globals so /api/status keeps reporting something sensible
      return send(res, 200, await chat(b.messages || [], mode, webApis, speedPool));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, e.status || 502, { error: scrub(e.message), attempts: e.attempts, mode: e.mode !== undefined ? e.mode : MODE, hacker: e.hacker !== undefined ? e.hacker : MODE === 'hacker', webApis: WEBAPIS }); }
});

if (require.main === module) server.listen(PORT, HOST, () => console.log(`cheap-router on http://${HOST}:${PORT} (key ${KEY ? 'loaded' : 'not set'})`));
module.exports = { parseModeBody, requestMode, poolFor, withHackerSystem, HACKER_SYSTEM,
  speedOrder, recordLatency, medianLatency, latencySnapshot, costOf, guardStatus, isFreeModel,
  councilMessages, shapeCouncil };
