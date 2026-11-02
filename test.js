const { refreshModels, rank, ALWAYS_ALLOW, HACKER_IDS, HACKER_INFO, hackerSet } = require('./router');
const { equalTargets } = require('./alloc');
const assert = require('assert');
(async () => {
  const { cap, models } = await refreshModels(true);
  const bad = models.filter((m) => { const p=+m.pricing.prompt,c=+m.pricing.completion; if (ALWAYS_ALLOW.includes(m.id)) return false; return !(p===0&&c===0) && (p>cap.prompt||c>cap.completion); });
  console.log('cap', cap.id, cap.prompt*1e6, cap.completion*1e6, 'eligible', models.length, 'free', models.filter(m=>+m.pricing.prompt===0&&+m.pricing.completion===0).length, 'violations', bad.length);
  for (const p of ['hi there!', 'Fix this python function: def f(x): return x+', 'Solve 3x+7=22 step by step', 'Write a short poem about autumn'])
    { const r = rank(p, models); console.log(r.cat, '->', r.ranked[0].id, '|', r.ranked[0].why); }
  const missing = ALWAYS_ALLOW.filter((id) => !models.some((m) => m.id === id)); console.log('always-allowed present:', ALWAYS_ALLOW.filter(id=>!missing.includes(id)), 'missing:', missing);
  // Hacker mode: candidate set is exactly the four ids (synthetic list, so no
  // network dependence), with equal 0.25 targets. Missing/unknown ids are
  // skipped/ignored without throwing.
  const synthAll = [
    ...HACKER_IDS.map((id) => ({ id, name: id, context_length: HACKER_INFO[id].ctx, pricing: { prompt: String(HACKER_INFO[id].prompt), completion: String(HACKER_INFO[id].completion) }, supported_parameters: [], architecture: { output_modalities: ['text'] } })),
    { id: 'some/other-model', name: 'other', context_length: 8192, pricing: { prompt: '0', completion: '0' }, supported_parameters: [], architecture: { output_modalities: ['text'] } },
    { id: 'anthropic/claude-haiku-5.5', name: 'haiku', context_length: 200000, pricing: { prompt: '0.000001', completion: '0.000005' }, supported_parameters: [], architecture: { output_modalities: ['text'] } },
  ];
  const four = hackerSet(synthAll);
  assert.deepStrictEqual(four.map((m) => m.id), HACKER_IDS, 'hacker set is exactly the four ids in order');
  const t4 = equalTargets(four);
  for (const id of HACKER_IDS) assert(Math.abs(t4[id] - 0.25) < 1e-12, `${id} target is 0.25`);
  const partial = hackerSet(synthAll.filter((m) => m.id !== HACKER_IDS[2]).concat([{ id: 'unknown/ghost-model' }]));
  assert.strictEqual(partial.length, 3, 'missing id skipped, unknown id ignored');
  assert(Math.abs(Object.values(equalTargets(partial)).reduce((a, b) => a + b, 0) - 1) < 1e-12, 'partial hacker targets still sum to 1');
  const hr = rank('Fix this python function: def f(x): return x+', four);
  assert.strictEqual(hr.ranked.length, 4, 'all four hacker models fit a normal prompt');
  assert(hr.ranked.every((r) => HACKER_IDS.includes(r.id)), 'hacker ranking stays within the four');
  console.log('hacker set OK:', four.map((m) => m.id).join(', '));
  if (bad.length || missing.length) process.exit(1);
})();
