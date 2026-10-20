const http = require('http'), fs = require('fs'), path = require('path');
const { refreshModels, rank } = require('./router');
const { targets, Usage, order } = require('./alloc');

// tiny .env loader (never logs values)
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
} } catch {}
let KEY = process.env.OPENROUTER_API_KEY || '';
const usage = new Usage(process.env.USAGE_FILE || path.join(__dirname, 'usage.json'));
const pct = (x) => (x * 100).toFixed(3) + '%';
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

async function chat(messages) {
  const { models } = await refreshModels();
  const last = messages[messages.length - 1]?.content || '';
  const plan = rank(String(last), models);
  const cands = order(plan.ranked, targets(models), usage);
  const attempts = [];
  for (const cand of cands.slice(0, MAX_TRIES)) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'X-Title': 'cheap-router' },
        body: JSON.stringify({ model: cand.id, messages }),
      });
      const j = await r.json().catch(() => ({}));
      const text = j.choices?.[0]?.message?.content;
      if (r.ok && text) { usage.record(cand.id); // count only on success
        return { reply: text, model: cand.id, category: plan.cat, why: `${plan.why}; picked ${cand.id}: ${cand.why}; fit ${cand.fit.toFixed(2)} × deficit ${cand.deficit.toFixed(2)}; target ${pct(cand.target)}, actual before ${pct(cand.actual)} (now ${pct(usage.share(cand.id))})`, attempts }; }
      attempts.push({ model: cand.id, error: scrub(`${r.status} ${j.error?.message || 'empty reply'}`) });
      if (r.status === 401) break;
    } catch (e) { attempts.push({ model: cand.id, error: scrub(e.message) }); }
  }
  throw Object.assign(new Error('All candidate models failed'), { attempts, category: plan.cat });
}

http.createServer(async (req, res) => {
  try {
    if (!hostOk(req.headers.host)) return send(res, 421, { error: 'bad host' });
    if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, { error: 'cross-origin request refused' });
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html'))
      { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' }); return res.end(fs.readFileSync(path.join(__dirname, 'public/index.html'))); } // single fixed file: no path traversal
    if (req.url === '/api/shares') {
      const { models } = await refreshModels(); const t = targets(models);
      return send(res, 200, { total: usage.total(), rows: Object.keys(t).sort((a, b) => t[b] - t[a] || (a < b ? -1 : 1)).map((id) => ({ id, target: t[id], actual: usage.share(id), count: usage.counts[id] || 0 })) });
    }
    if (req.url === '/api/status') return send(res, 200, { hasKey: !!KEY });
    if (req.url.startsWith('/api/models')) {
      const c = await refreshModels(req.url.includes('refresh'));
      return send(res, 200, { alwaysAllow: require('./router').ALWAYS_ALLOW, cap: c.cap, count: c.models.length, models: c.models.map((m) => ({ id: m.id, prompt: m.pricing.prompt, completion: m.pricing.completion, ctx: m.context_length })) });
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
      const { prompt } = await body(req); const { models } = await refreshModels();
      const p = rank(String(prompt || ''), models); return send(res, 200, { cat: p.cat, why: p.why, top: order(p.ranked, targets(models), usage).slice(0, 5) });
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      if (!KEY) return send(res, 400, { error: 'No OpenRouter API key set' });
      const { messages } = await body(req);
      return send(res, 200, await chat(messages || []));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 502, { error: scrub(e.message), attempts: e.attempts }); }
}).listen(PORT, HOST, () => console.log(`cheap-router on http://${HOST}:${PORT} (key ${KEY ? 'loaded' : 'not set'})`));
