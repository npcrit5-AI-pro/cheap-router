const { refreshModels, rank, ALWAYS_ALLOW, HACKER_IDS, HACKER_INFO, hackerSet } = require('./router');
const { equalTargets, Usage, order } = require('./alloc');
const { parseModeBody, requestMode, poolFor, withHackerSystem, HACKER_SYSTEM,
  speedOrder, medianLatency, latencySnapshot, costOf, guardStatus, isFreeModel,
  councilMessages, shapeCouncil } = require('./server');
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
  assert.deepStrictEqual(requestMode({}), { mode: 'cheap', webApis: false, speedPool: 'cheap', budgetOn: false, budgetCeiling: 0 }, 'omitted mode falls back to global default');
  assert.deepStrictEqual(requestMode({ mode: 'hacker', webApis: true }), { mode: 'hacker', webApis: true, speedPool: 'cheap', budgetOn: false, budgetCeiling: 0 });
  assert.deepStrictEqual(requestMode({ mode: 'speed', speedPool: 'hacker' }), { mode: 'speed', webApis: false, speedPool: 'hacker', budgetOn: false, budgetCeiling: 0 });
  assert.deepStrictEqual(requestMode({ mode: 'council', budgetOn: true, budgetCeiling: 5 }), { mode: 'council', webApis: false, speedPool: 'cheap', budgetOn: true, budgetCeiling: 5 });
  assert.deepStrictEqual(requestMode({ mode: 'evil', webApis: 'x' }), { mode: 'cheap', webApis: false, speedPool: 'cheap', budgetOn: false, budgetCeiling: 0 }, 'unknown values fall back');
  console.log('hacker pool guarantee OK');
  // Hacker system prompt: prepended as the first message for hacker-mode
  // requests only; cheap mode sends messages untouched; never doubled up.
  const convo = [{ role: 'user', content: 'hi' }];
  const hw = withHackerSystem(convo, 'hacker');
  assert.strictEqual(hw[0].role, 'system', 'system message goes first');
  assert.strictEqual(hw[0].content, HACKER_SYSTEM, 'uses the repo constant verbatim');
  assert.strictEqual(hw.length, convo.length + 1, 'nothing else added or removed');
  assert.deepStrictEqual(withHackerSystem(convo, 'cheap'), convo, 'cheap mode untouched');
  assert.strictEqual(withHackerSystem([{ role: 'system', content: 'mine' }, ...convo], 'hacker').length, convo.length + 1, 'existing system message kept, no duplicate');
  assert(/weapon/i.test(HACKER_SYSTEM) && /explosive/i.test(HACKER_SYSTEM), 'weapons/explosives carve-out present');
  assert(/real-world harm/i.test(HACKER_SYSTEM), 'real-world-harm carve-out present');
  assert(!/without limits|ignore.{0,20}safety|disregard.{0,20}saf/i.test(HACKER_SYSTEM), 'no ignore-your-training language');
  console.log('hacker system prompt OK');
  // Mode bodies: new {mode, webApis, speedPool, budgetOn, budgetCeiling} shape
  // plus backward-compatible {hacker}. Absent fields come back null.
  const EMPTY = { mode: null, webApis: null, speedPool: null, budgetOn: null, budgetCeiling: null };
  assert.deepStrictEqual(parseModeBody({ hacker: true }), { ...EMPTY, mode: 'hacker' });
  assert.deepStrictEqual(parseModeBody({ hacker: false }), { ...EMPTY, mode: 'cheap' });
  assert.deepStrictEqual(parseModeBody({ hacker: 1 }), { ...EMPTY, mode: 'hacker' }, 'legacy numeric flag');
  assert.deepStrictEqual(parseModeBody({ mode: 'hacker', webApis: true }), { ...EMPTY, mode: 'hacker', webApis: true });
  assert.deepStrictEqual(parseModeBody({ mode: 'cheap', webApis: false }), { ...EMPTY, mode: 'cheap', webApis: false });
  assert.deepStrictEqual(parseModeBody({}), EMPTY);
  assert.deepStrictEqual(parseModeBody({ mode: 'evil', webApis: 'maybe' }), EMPTY);
  assert.deepStrictEqual(parseModeBody({ mode: 'cheap', hacker: true }), { ...EMPTY, mode: 'cheap' }, 'explicit mode wins over legacy hacker flag');
  assert.deepStrictEqual(parseModeBody({ mode: 'speed', speedPool: 'hacker' }), { ...EMPTY, mode: 'speed', speedPool: 'hacker' });
  assert.deepStrictEqual(parseModeBody({ mode: 'speed', speedPool: 'evil' }), { ...EMPTY, mode: 'speed' }, 'bad pool ignored');
  assert.deepStrictEqual(parseModeBody({ mode: 'council' }), { ...EMPTY, mode: 'council' });
  assert.deepStrictEqual(parseModeBody({ budgetOn: true, budgetCeiling: 5 }), { ...EMPTY, budgetOn: true, budgetCeiling: 5 });
  assert.deepStrictEqual(parseModeBody({ budget: { on: 1, ceiling: '2.5' } }), { ...EMPTY, budgetOn: true, budgetCeiling: 2.5 }, 'nested budget shape');
  assert.deepStrictEqual(parseModeBody({ budgetCeiling: -3 }), EMPTY, 'negative ceiling ignored');
  assert.deepStrictEqual(parseModeBody({ budgetCeiling: 'lots' }), EMPTY, 'non-numeric ceiling ignored');
  console.log('mode bodies OK');
  // Speed Run: a latency ordering layered on an existing pool, never a new
  // pool. speed+hacker reuses exactly the three ids (with the hacker flag, so
  // the pool guarantee and system prompt follow it); anything else reuses
  // the cheap pool.
  const spoolH = poolFor({ models: synthAll, all: synthAll }, 'speed', 'hacker');
  assert(spoolH.speed === true && spoolH.hacker === true, 'speed+hacker keeps the hacker flag');
  assert.deepStrictEqual(spoolH.models.map((m) => m.id), HACKER_IDS, 'speed+hacker pool is exactly the three ids');
  const spoolC = poolFor({ models: synthAll, all: synthAll }, 'speed', 'cheap');
  assert(spoolC.speed === true && spoolC.hacker === false && spoolC.models.length > HACKER_IDS.length, 'speed+cheap reuses the cheap pool');
  const spoolD = poolFor({ models: synthAll, all: synthAll }, 'speed', 'evil');
  assert(spoolD.hacker === false, 'bad speedPool falls back to cheap');
  const cnpool = poolFor({ models: synthAll, all: synthAll }, 'council');
  assert(cnpool.council === true && cnpool.hacker === true, 'council flagged as hacker pool');
  assert.deepStrictEqual(cnpool.models.map((m) => m.id), HACKER_IDS, 'council fans out over exactly the three ids');
  // speedOrder with synthetic latencies (injected, so no global state or network).
  const fake = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const med = (id) => ({ a: 200, b: 50, c: 100 }[id] ?? null);
  assert.deepStrictEqual(speedOrder(fake, med).map((x) => x.id), ['b', 'c', 'a'], 'fastest median first');
  assert.deepStrictEqual(speedOrder(fake, () => null), fake, 'cold start keeps deficit order untouched');
  assert.deepStrictEqual(speedOrder(fake, (id) => (id === 'c' ? 10 : null)).map((x) => x.id), ['c', 'a', 'b'], 'unmeasured sink last, deficit order breaks ties');
  assert.strictEqual(medianLatency('never/seen'), null, 'cold models report null');
  assert.deepStrictEqual(latencySnapshot(), {}, 'fresh process has no measurements');
  console.log('speed run ordering OK');
  // Council shaping: a partial failure keeps the survivors, names the failed
  // model with its reason, and totals the cost. All three get the hacker prompt.
  const cu = councilMessages(convo);
  assert.strictEqual(cu[0].role, 'system', 'council prepends system first');
  assert.strictEqual(cu[0].content, HACKER_SYSTEM, 'council uses the hacker prompt verbatim');
  const clookup = () => ({ pricing: { prompt: '0.000001', completion: '0.000002' } });
  const shaped = shapeCouncil([
    { id: 'm1', ok: true, text: 'yes', ms: 1200, usage: { prompt_tokens: 1000, completion_tokens: 500 } },
    { id: 'm2', ok: false, error: '429 rate limited' },
    { id: 'm3', ok: true, text: 'no', ms: 800, usage: { prompt_tokens: 1000, completion_tokens: 100 } },
  ], clookup);
  assert.strictEqual(shaped.answers.length, 2, 'two survivors shown');
  assert.strictEqual(shaped.failures.length, 1, 'one failure noted');
  assert.strictEqual(shaped.failures[0].model, 'm2', 'failure names its model');
  assert(/429/.test(shaped.failures[0].error), 'failure keeps the reason');
  const expectCost = (1000 * 1e-6 + 500 * 2e-6) + (1000 * 1e-6 + 100 * 2e-6);
  assert(Math.abs(shaped.cost - expectCost) < 1e-12, 'total cost is the sum of the answers');
  assert.strictEqual(shapeCouncil([{ id: 'm1', ok: false, error: 'x' }], clookup).answers.length, 0, 'total loss yields no answers');
  console.log('council shaping OK');
  // Budget guard: tri-state from spend vs ceiling; cost from usage, never chars.
  assert.strictEqual(guardStatus(5, 10, true).state, 'ok');
  assert.strictEqual(guardStatus(8, 10, true).state, 'engaged', 'trips at 80%');
  assert.strictEqual(guardStatus(9.99, 10, true).state, 'engaged');
  assert.strictEqual(guardStatus(10, 10, true).state, 'refused', 'refuses at 100%');
  assert.strictEqual(guardStatus(11, 10, true).state, 'refused');
  assert.strictEqual(guardStatus(50, 10, false).state, 'ok', 'off means off');
  assert.strictEqual(guardStatus(50, 0, true).state, 'ok', 'no ceiling means off');
  assert.strictEqual(guardStatus(1, 10, true).spend, 1, 'spend passes through');
  assert.strictEqual(costOf({ pricing: { prompt: '0.000001', completion: '0.000002' } }, { prompt_tokens: 2000, completion_tokens: 500 }), 2000e-6 + 500 * 2e-6);
  assert.strictEqual(costOf({ pricing: { prompt: '0', completion: '0' } }, { prompt_tokens: 99999, completion_tokens: 99999 }), 0, 'free models cost nothing');
  assert.strictEqual(costOf({ pricing: { prompt: '0.000001', completion: '0.000002' } }, undefined), 0, 'missing usage is $0, never estimated');
  assert(isFreeModel({ pricing: { prompt: '0', completion: '0' } }) === true, 'zero-price detected');
  assert(isFreeModel({ pricing: { prompt: '0.000001', completion: '0' } }) === false, 'half-free is not free');
  console.log('budget guard OK');
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
