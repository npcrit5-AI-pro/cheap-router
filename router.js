// Model list + routing heuristic (no deps)
const CAP_ID = 'anthropic/claude-haiku-5.5';
// Price exceptions: ids always eligible even if above the cap (currently none)
const ALWAYS_ALLOW = [];
// Preference boosts: strong picks per category (must still be eligible)
const STRONG = { 'meta/muse-spark-1.3-contributor': ['reasoning', 'creative'] };
let cache = { at: 0, cap: null, models: [] };

const num = (x) => (x === undefined || x === null || x === '' ? NaN : Number(x));
const isFree = (m) => num(m.pricing?.prompt) === 0 && num(m.pricing?.completion) === 0;

async function refreshModels(force = false) {
  if (!force && cache.models.length && Date.now() - cache.at < 3600e3) return cache;
  const r = await fetch('https://openrouter.ai/api/v1/models');
  if (!r.ok) throw new Error('model list fetch failed: ' + r.status);
  const all = (await r.json()).data;
  cache = { at: Date.now(), ...filterEligible(all) };
  return cache;
}

function filterEligible(all) {
  let cap = all.find((m) => m.id === CAP_ID);
  let capNote = 'Claude Haiku 5.5';
  if (!cap) { // fallback: newest Claude Haiku
    cap = all.filter((m) => /claude.*haiku/i.test(m.id) && !m.id.includes(':') && !m.id.startsWith('~'))
      .sort((a, b) => (b.created || 0) - (a.created || 0))[0];
    capNote = cap ? `${cap.id} (Haiku 5.5 not listed)` : 'none';
  }
  if (!cap) throw new Error('No Claude Haiku found for price cap');
  const cp = num(cap.pricing.prompt), cc = num(cap.pricing.completion);
  const models = all.filter((m) => {
    const p = num(m.pricing?.prompt), c = num(m.pricing?.completion);
    if (ALWAYS_ALLOW.includes(m.id)) return true;
    if (!(p >= 0 && c >= 0)) return false; // skip negative/variable (e.g. openrouter/auto)
    if (m.id.endsWith(':batch')) return false; // batch endpoints aren't for chat
    if (!(m.architecture?.output_modalities || ['text']).includes('text')) return false;
    return isFree(m) || (p <= cp && c <= cc);
  });
  return { cap: { id: cap.id, note: capNote, prompt: cp, completion: cc }, models };
}

const KW = {
  code: /\b(code|function|bug|error|stack ?trace|python|javascript|typescript|java|rust|golang|sql|regex|api|compile|refactor|class|debug|html|css|bash|script)\b|```|=>|\bdef\b|;\s*$/im,
  reasoning: /\b(prove|proof|solve|calculate|equation|math|integral|derivative|probability|logic|step by step|why|explain|analy[sz]e|compare|reason|puzzle)\b|\d+\s*[-+*/^]\s*\d+/i,
  creative: /\b(write|story|poem|lyrics|song|essay|creative|imagine|fiction|character|haiku|slogan|tagline|brainstorm)\b/i,
};

function classify(prompt) {
  const len = prompt.length;
  if (KW.code.test(prompt)) return { cat: 'code', why: 'code keywords/syntax detected' };
  if (KW.reasoning.test(prompt)) return { cat: 'reasoning', why: 'math/reasoning keywords detected' };
  if (KW.creative.test(prompt)) return { cat: 'creative', why: 'creative-writing keywords detected' };
  if (len > 1500) return { cat: 'reasoning', why: `long prompt (${len} chars), treating as analysis` };
  return { cat: 'chat', why: `short general prompt (${len} chars)` };
}

const HINTS = {
  code: /coder|code|devstral|codestral|qwen.*coder|deepseek/i,
  reasoning: /r1|reason|think|math|qwq|deepseek|o\d|magistral/i,
  creative: /llama|mistral|gemma|hermes|muse|creative|claude|gpt/i,
  chat: /flash|mini|small|lite|haiku|gemma|llama|instant/i,
};

function score(m, cat, promptTokens) {
  const ctx = m.context_length || 0;
  if (ctx && ctx < promptTokens * 2 + 1024) return -Infinity; // won't fit
  const params = m.supported_parameters || [];
  const price = num(m.pricing.prompt) + num(m.pricing.completion);
  let s = 0, why = [];
  if (ALWAYS_ALLOW.includes(m.id)) why.push('price exception (ALWAYS_ALLOW, above Haiku cap)');
  if (STRONG[m.id]?.includes(cat)) { s += 60; why.push(`strong pick for ${cat}`); }
  if (HINTS[cat].test(m.id + ' ' + m.name)) { s += 30; why.push(`name fits "${cat}"`); }
  if (cat === 'reasoning' && params.includes('reasoning')) { s += 25; why.push('supports reasoning'); }
  if (cat === 'code' && params.includes('tools')) { s += 10; why.push('supports tools'); }
  if (isFree(m)) { s += cat === 'chat' ? 40 : 10; why.push('free'); }
  s += Math.min(20, Math.log2(Math.max(ctx, 1) / 4096) * 3); // bigger context a bit better
  if (!ALWAYS_ALLOW.includes(m.id)) s -= price * 1e6 * 5; // cheaper is better ($/M tokens)
  if (ctx) why.push(`${Math.round(ctx / 1000)}k ctx`);
  why.push(price === 0 ? '$0' : `$${(num(m.pricing.prompt) * 1e6).toFixed(2)}/$${(num(m.pricing.completion) * 1e6).toFixed(2)} per M`);
  return { s, why };
}

function rank(prompt, models) {
  const c = classify(prompt);
  const tok = Math.ceil(prompt.length / 4);
  const ranked = models.map((m) => ({ m, r: score(m, c.cat, tok) }))
    .filter((x) => x.r !== -Infinity)
    .sort((a, b) => b.r.s - a.r.s)
    .map((x) => ({ id: x.m.id, name: x.m.name, score: x.r.s, why: x.r.why.join(', ') }));
  return { ...c, ranked };
}

module.exports = { ALWAYS_ALLOW, refreshModels, filterEligible, classify, rank };
