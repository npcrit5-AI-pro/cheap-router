const http = require('http'), fs = require('fs'), path = require('path');
const { refreshModels, rank, hackerSet, HACKER_IDS, HACKER_INFO } = require('./router');
const { targets, equalTargets, Usage, order } = require('./alloc');
const { APIS, find, executeApi, toTool, publicCatalog } = require('./apis');

// tiny .env loader (never logs values)
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
} } catch {}
let KEY = process.env.OPENROUTER_API_KEY || '';
let MODE = 'cheap'; // routing mode: 'cheap' or 'hacker'. In-memory only, never written to .env.
let WEBAPIS = false; // free-web-APIs tools toggle. Also in-memory only.
const modeState = () => ({ mode: MODE, hacker: MODE === 'hacker', webApis: WEBAPIS });
// Parse POST /api/mode bodies. New shape {mode:'cheap'|'hacker', webApis:bool};
// the old {hacker:bool} shape still works (only when mode is absent, so it
// can't clobber an explicit mode). Unknown values are ignored, never throw.
function parseModeBody(b) {
  b = b && typeof b === 'object' ? b : {};
  let mode = null, webApis = null;
  if (b.mode === 'cheap' || b.mode === 'hacker') mode = b.mode;
  else if (b.hacker === true || b.hacker === 1 || b.hacker === 'true') mode = 'hacker';
  else if (b.hacker === false || b.hacker === 0 || b.hacker === 'false') mode = 'cheap';
  const w = b.webApis !== undefined ? b.webApis : b.webapis;
  if (w === true || w === 1 || w === 'true') webApis = true;
  else if (w === false || w === 0 || w === 'false') webApis = false;
  return { mode, webApis };
}
const usage = new Usage(process.env.USAGE_FILE || path.join(__dirname, 'usage.json'));
const pct = (x) => (x * 100).toFixed(3) + '%';
// "$prompt/$completion per M tokens" with enough precision for sub-cent prices
const perMTok = (x) => '$' + String(Number((Number(x) * 1e6).toPrecision(4)));
const pricePerM = (m) => `${perMTok(m.pricing.prompt)}/${perMTok(m.pricing.completion)} per M`;
// Candidate pool + share targets for a routing mode. The pool is derived from
// the mode passed in (per request), never from ambient state: a hacker-mode
// request builds candidates ONLY from HACKER_IDS via hackerSet(), so cheap
// models can never leak in, and the MAX_TRIES fallback loop in chat() walks
// this same list. `mode` defaults to the global only for callers that omit it.
function poolFor(c, mode = MODE) {
  if (mode !== 'hacker') return { models: c.models, tgt: targets(c.models), hacker: false };
  const three = hackerSet(c.all && c.all.length ? c.all : c.models);
  return { models: three, tgt: equalTargets(three), hacker: true };
}
// Effective routing for one request body: client-sent mode wins; the globals
// are only the fallback for older clients/curl that omit mode.
function requestMode(b) {
  const p = parseModeBody(b);
  return { mode: p.mode || MODE, webApis: p.webApis !== null ? p.webApis : WEBAPIS };
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

const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
const orHeaders = () => ({ Authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'X-Title': 'cheap-router' });
async function complete(model, messages, tools) {
  const r = await fetch(OR_URL, { method: 'POST', headers: orHeaders(),
    body: JSON.stringify(tools ? { model, messages, tools, tool_choice: 'auto' } : { model, messages }) });
  const j = await r.json().catch(() => ({}));
  return { r, j };
}
// One plain completion, no tools.
async function plainAnswer(cand, messages) {
  const { r, j } = await complete(cand.id, messages, null);
  const text = j.choices?.[0]?.message?.content;
  if (r.ok && text) return { ok: true, text, apis: [] };
  return { ok: false, error: `${r.status} ${j.error?.message || 'empty reply'}`, unauthorized: r.status === 401 };
}
// Tool-calling chat: pass the web-API catalog as functions, execute calls
// server-side, feed results back, up to 4 tool rounds, then a final answer.
// If the model can't do tools, fall back to a plain answer (never a 500).
async function chatWithTools(cand, messages, tools) {
  const conv = messages.map((m) => ({ role: m.role, content: m.content ?? '' }));
  const seen = new Map();
  for (let round = 0; round < 4; round++) {
    const { r, j } = await complete(cand.id, conv, tools);
    const msg = j.choices?.[0]?.message, calls = msg?.tool_calls;
    if (!r.ok) {
      if (round === 0 && /tool/i.test(j?.error?.message || '')) return plainAnswer(cand, messages);
      return { ok: false, error: `${r.status} ${j.error?.message || 'empty reply'}`, unauthorized: r.status === 401 };
    }
    if (!calls?.length) {
      if (msg?.content) return { ok: true, text: msg.content, apis: [...seen.values()] };
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

async function chat(messages, mode, webApis) {
  const c = await refreshModels();
  const { models, tgt, hacker } = poolFor(c, mode);
  if (!models.length) throw new Error(hacker ? 'No hacker models listed by OpenRouter right now' : 'No eligible models');
  const last = messages[messages.length - 1]?.content || '';
  const plan = rank(String(last), models);
  const cands = order(plan.ranked, tgt, usage);
  const byId = new Map(models.map((m) => [m.id, m]));
  const tools = webApis ? APIS.map(toTool) : null;
  const attempts = [];
  for (const cand of cands.slice(0, MAX_TRIES)) {
    try {
      const out = tools ? await chatWithTools(cand, messages, tools) : await plainAnswer(cand, messages);
      if (out.ok) { usage.record(cand.id); // count only on success
        const price = pricePerM(byId.get(cand.id) || { pricing: HACKER_INFO[cand.id] || { prompt: NaN, completion: NaN } });
        const modeNote = (hacker ? 'hacker mode (uncensored pool, equal 1/3 shares); ' : '') + (webApis ? `free web apis on (${out.apis.length} used); ` : '');
        return { reply: out.text, model: cand.id, category: plan.cat, mode, hacker, webApis, apis: out.apis, price, why: `${modeNote}${plan.why}; picked ${cand.id}: ${cand.why}; fit ${cand.fit.toFixed(2)} × deficit ${cand.deficit.toFixed(2)}; target ${pct(cand.target)}, actual before ${pct(cand.actual)} (now ${pct(usage.share(cand.id))})`, attempts }; }
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
      return send(res, 200, { total: usage.total(), hacker, rows: Object.keys(tgt).sort((a, b) => tgt[b] - tgt[a] || (a < b ? -1 : 1)).map((id) => ({ id, target: tgt[id], actual: usage.share(id), count: usage.counts[id] || 0, price: models.some((m) => m.id === id) ? pricePerM(models.find((m) => m.id === id)) : undefined })) });
    }
    if (req.url === '/api/status') return send(res, 200, { hasKey: !!KEY, ...modeState(), apiCount: APIS.length });
    if (req.url === '/api/mode') {
      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
      const parsed = parseModeBody(await body(req));
      if (parsed.mode) MODE = parsed.mode;
      if (parsed.webApis !== null) WEBAPIS = parsed.webApis;
      return send(res, 200, modeState()); // same-origin + JSON protections apply (checked above for all POSTs); in-memory only
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
      return send(res, 200, { alwaysAllow: require('./router').ALWAYS_ALLOW, cap: c.cap, count: c.models.length, models: c.models.map((m) => ({ id: m.id, prompt: m.pricing.prompt, completion: m.pricing.completion, ctx: m.context_length })), hacker: HACKER, hackerIds: HACKER_IDS, hackerInfo: HACKER_INFO });
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
      const { mode } = requestMode(b); // dry run honors the requested mode but doesn't move the global
      const { models, tgt, hacker } = poolFor(c, mode);
      const p = rank(String(b.prompt || ''), models); return send(res, 200, { cat: p.cat, why: p.why, mode, hacker, top: order(p.ranked, tgt, usage).slice(0, 5) });
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      if (!KEY) return send(res, 400, { error: 'No OpenRouter API key set' });
      const b = await body(req);
      const { mode, webApis } = requestMode(b); // route THIS request by what the client sent...
      MODE = mode; WEBAPIS = webApis; // ...and sync the global so /api/status keeps reporting something sensible
      return send(res, 200, await chat(b.messages || [], mode, webApis));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 502, { error: scrub(e.message), attempts: e.attempts, mode: e.mode !== undefined ? e.mode : MODE, hacker: e.hacker !== undefined ? e.hacker : MODE === 'hacker', webApis: WEBAPIS }); }
});

if (require.main === module) server.listen(PORT, HOST, () => console.log(`cheap-router on http://${HOST}:${PORT} (key ${KEY ? 'loaded' : 'not set'})`));
module.exports = { parseModeBody, requestMode, poolFor };
