const { refreshModels, rank, ALWAYS_ALLOW, HACKER_IDS, HACKER_INFO, hackerSet } = require('./router');
const { equalTargets, Usage, order } = require('./alloc');
const { parseModeBody, requestMode, poolFor } = require('./server');
const { APIS, find, buildUrl, toTool, publicCatalog } = require('./apis');
const assert = require('assert');
(async () => {
  const { cap, models } = await refreshModels(true);
  const bad = models.filter((m) => { const p=+m.pricing.prompt,c=+m.pricing.completion; if (ALWAYS_ALLOW.includes(m.id)) return false; return !(p===0&&c===0) && (p>cap.prompt||c>cap.completion); });
  console.log('cap', cap.id, cap.prompt*1e6, cap.completion*1e6, 'eligible', models.length, 'free', models.filter(m=>+m.pricing.prompt===0&&+m.pricing.completion===0).length, 'violations', bad.length);
  for (const p of ['hi there!', 'Fix this python function: def f(x): return x+', 'Solve 3x+7=22 step by step', 'Write a short poem about autumn'])
    { const r = rank(p, models); console.log(r.cat, '->', r.ranked[0].id, '|', r.ranked[0].why); }
  const missing = ALWAYS_ALLOW.filter((id) => !models.some((m) => m.id === id)); console.log('always-allowed present:', ALWAYS_ALLOW.filter(id=>!missing.includes(id)), 'missing:', missing);
  // Hacker mode: candidate set is exactly the three ids (synthetic list, so no
  // network dependence), with equal 1/3 targets. Missing/unknown ids are
  // skipped/ignored without throwing.
  const synthAll = [
    ...HACKER_IDS.map((id) => ({ id, name: id, context_length: HACKER_INFO[id].ctx, pricing: { prompt: String(HACKER_INFO[id].prompt), completion: String(HACKER_INFO[id].completion) }, supported_parameters: [], architecture: { output_modalities: ['text'] } })),
    { id: 'some/other-model', name: 'other', context_length: 8192, pricing: { prompt: '0', completion: '0' }, supported_parameters: [], architecture: { output_modalities: ['text'] } },
    { id: 'anthropic/claude-haiku-5.5', name: 'haiku', context_length: 200000, pricing: { prompt: '0.000001', completion: '0.000005' }, supported_parameters: [], architecture: { output_modalities: ['text'] } },
  ];
  const three = hackerSet(synthAll);
  assert.deepStrictEqual(three.map((m) => m.id), HACKER_IDS, 'hacker set is exactly the three ids in order');
  const t3 = equalTargets(three);
  for (const id of HACKER_IDS) assert(Math.abs(t3[id] - 1 / 3) < 1e-12, `${id} target is 1/3`);
  const partial = hackerSet(synthAll.filter((m) => m.id !== HACKER_IDS[1]).concat([{ id: 'unknown/ghost-model' }]));
  assert.strictEqual(partial.length, 2, 'missing id skipped, unknown id ignored');
  assert(Math.abs(Object.values(equalTargets(partial)).reduce((a, b) => a + b, 0) - 1) < 1e-12, 'partial hacker targets still sum to 1');
  const hr = rank('Fix this python function: def f(x): return x+', three);
  assert.strictEqual(hr.ranked.length, 3, 'all three hacker models fit a normal prompt');
  assert(hr.ranked.every((r) => HACKER_IDS.includes(r.id)), 'hacker ranking stays within the three');
  // Hard guarantee: a hacker-mode request can only ever be answered from the
  // hacker pool. poolFor + rank + order over a list stuffed with cheap-mode
  // decoys must yield ONLY hacker ids — every fallback candidate, not just
  // the first pick. Cheap mode still sees the full list.
  const hpool = poolFor({ models: synthAll, all: synthAll }, 'hacker');
  assert(hpool.hacker === true, 'hacker flag set');
  assert.deepStrictEqual(hpool.models.map((m) => m.id), HACKER_IDS, 'hacker pool built only from HACKER_IDS');
  const hplan = rank('Fix this python function: def f(x): return x+', hpool.models);
  assert(hplan.ranked.length === HACKER_IDS.length, 'no cheap model leaks into hacker ranking');
  const hfallbacks = order(hplan.ranked, hpool.tgt, new Usage(null));
  assert.strictEqual(hfallbacks.length, HACKER_IDS.length, 'fallback list is exactly the pool');
  assert(hfallbacks.every((r) => HACKER_IDS.includes(r.id)), 'every fallback candidate is a hacker model');
  const cpool = poolFor({ models: synthAll, all: synthAll }, 'cheap');
  assert(cpool.hacker === false && cpool.models.length > HACKER_IDS.length, 'cheap pool unaffected');
  // Per-request routing resolves client-sent mode first, globals are fallback.
  assert.deepStrictEqual(requestMode({}), { mode: 'cheap', webApis: false }, 'omitted mode falls back to global default');
  assert.deepStrictEqual(requestMode({ mode: 'hacker', webApis: true }), { mode: 'hacker', webApis: true });
  assert.deepStrictEqual(requestMode({ mode: 'evil', webApis: 'x' }), { mode: 'cheap', webApis: false }, 'unknown values fall back');
  console.log('hacker pool guarantee OK');
  // Mode bodies: new {mode, webApis} shape plus backward-compatible {hacker}.
  assert.deepStrictEqual(parseModeBody({ hacker: true }), { mode: 'hacker', webApis: null });
  assert.deepStrictEqual(parseModeBody({ hacker: false }), { mode: 'cheap', webApis: null });
  assert.deepStrictEqual(parseModeBody({ mode: 'hacker', webApis: true }), { mode: 'hacker', webApis: true });
  assert.deepStrictEqual(parseModeBody({ mode: 'cheap', webApis: false }), { mode: 'cheap', webApis: false });
  assert.deepStrictEqual(parseModeBody({}), { mode: null, webApis: null });
  assert.deepStrictEqual(parseModeBody({ mode: 'evil', webApis: 'maybe' }), { mode: null, webApis: null });
  assert.deepStrictEqual(parseModeBody({ mode: 'cheap', hacker: true }), { mode: 'cheap', webApis: null }, 'explicit mode wins over legacy hacker flag');
  console.log('mode bodies OK');
  // Hacker pool stays exactly the three ids, no Magnum.
  assert.deepStrictEqual(HACKER_IDS, ['z-ai/glm-5.3-flash', 'cognitivecomputations/dolphin-mistral-24b-venice-edition', 'mistralai/mistral-nemo']);
  // Web-API catalog shape (offline: structure only, live checks are `npm run apis`).
  assert(APIS.length >= 70 && APIS.length <= 90, `roughly 75 apis (got ${APIS.length})`);
  assert.strictEqual(new Set(APIS.map((e) => e.id)).size, APIS.length, 'api ids unique');
  for (const e of APIS) {
    assert(/^[a-z0-9-]{1,64}$/.test(e.id), `bad tool id ${e.id}`);
    assert(e.name && e.category && e.description, `metadata missing for ${e.id}`);
    assert(e.url.startsWith('https://'), `not https: ${e.id}`);
    assert(!/(api[_-]?key|apikey|secret|password|token)/i.test(e.url), `key-like param in ${e.id}`);
    assert(typeof e.map === 'function', `no mapper for ${e.id}`);
    assert(e.params && typeof e.params === 'object', `no params for ${e.id}`);
    const u = new URL(buildUrl(e, e.example || {}));
    assert(u.protocol === 'https:' && u.host === e.host, `url escapes allowlist for ${e.id}`);
    const t = toTool(e);
    assert(t.type === 'function' && /^[a-zA-Z0-9_-]{1,64}$/.test(t.function.name) && t.function.parameters.type === 'object', `bad tool schema for ${e.id}`);
  }
  assert(!find('nope/not-real'), 'unknown api id returns undefined');
  const pub = publicCatalog();
  assert.strictEqual(pub.length, APIS.length, 'public catalog covers every entry');
  assert(pub.every((e) => e.id && e.name && e.category && e.description && e.params && !('map' in e) && !('url' in e)), 'public catalog is metadata only');
  console.log(`web-api catalog OK: ${APIS.length} entries`);
  if (bad.length || missing.length) process.exit(1);
})();
