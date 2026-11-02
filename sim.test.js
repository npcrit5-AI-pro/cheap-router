const assert = require('assert');
const { refreshModels, rank, HACKER_IDS, HACKER_INFO, hackerSet } = require('./router');
const { targets, equalTargets, Usage, order, FIXED, MAX } = require('./alloc');
const PROMPTS = ['hi there!', 'Fix this python function: def f(x): return x+', 'Solve 3x+7=22 step by step', 'Write a short poem about autumn', 'what time zone is Berlin in?', 'Refactor this SQL query to use a join', 'Prove that sqrt(2) is irrational', 'Brainstorm 5 slogans for a coffee shop'];
function run(models, n = 10000) {
  const tgt = targets(models), u = new Usage(null), picks = [];
  const plans = PROMPTS.map((p) => rank(p, models)); // fit is fixed per prompt; cache
  let codeHits = 0, codeN = 0;
  for (let i = 0; i < n; i++) {
    const k = (i * 7 + Math.floor(i / 8)) % PROMPTS.length; // deterministic mix
    const pick = order(plans[k].ranked, tgt, u)[0];
    u.record(pick.id); picks.push(pick.id);
    if (plans[k].cat === 'code') { codeN++; if (/code|coder/i.test(pick.id)) codeHits++; }
  }
  return { u, picks, tgt, codeRate: codeHits / codeN };
}
(async () => {
  const { models, all } = await refreshModels(true);
  for (const id of Object.keys(FIXED)) assert(models.some((m) => m.id === id), `${id} must be eligible`);
  const a = run(models), b = run(models);
  assert.deepStrictEqual(a.picks, b.picks, 'runs must be identical');
  const sum = Object.values(a.tgt).reduce((x, y) => x + y, 0); assert(Math.abs(sum - 1) < 1e-9, 'targets sum to 1');
  const c = a.u.share('meta/muse-spark-1.3-contributor'), h = a.u.share('anthropic/claude-haiku-5.5');
  const others = models.filter((m) => !(m.id in FIXED)).map((m) => [m.id, a.u.share(m.id), a.tgt[m.id]]).sort((x, y) => y[1] - x[1]);
  console.log(`models ${models.length}; contributor ${(c * 100).toFixed(2)}%, haiku ${(h * 100).toFixed(2)}%, max other ${others[0][0]} ${(others[0][1] * 100).toFixed(2)}% (target ${(others[0][2] * 100).toFixed(2)}%), min other ${(others.at(-1)[1] * 100).toFixed(3)}%, others used ${others.filter((o) => o[1] > 0).length}/${others.length}`);
  console.log(`code prompts routed to code-named models: ${(a.codeRate * 100).toFixed(1)}% (vs ~${(others.filter(o=>/code|coder/i.test(o[0])).reduce((s,o)=>s+o[2],0)*100).toFixed(1)}% of total target)`);
  assert(Math.abs(c - 0.5) < 0.01, 'contributor ~50%'); assert(Math.abs(h - 0.1) < 0.01, 'haiku ~10%');
  for (const [id, s] of others) assert(s <= MAX + 1e-9, `${id} over 8%`);
  console.log('sim test OK');
  // Hacker mode: the same deficit-weighted ordering over exactly the three
  // models with equal targets must converge to ~1/3 each. Prefer the live
  // list; fall back to synthetic models (from HACKER_INFO) if OpenRouter
  // doesn't currently list all three.
  let hmodels = hackerSet(all && all.length ? all : models);
  if (hmodels.length < 3) hmodels = HACKER_IDS.map((id) => ({ id, name: id, context_length: HACKER_INFO[id].ctx, pricing: { prompt: String(HACKER_INFO[id].prompt), completion: String(HACKER_INFO[id].completion) }, supported_parameters: ['tools'], architecture: { output_modalities: ['text'] } }));
  assert.strictEqual(hmodels.length, 3, 'hacker pool is exactly three models');
  function hrun(n = 1200) {
    const tgt = equalTargets(hmodels), u = new Usage(null), picks = [];
    const plans = PROMPTS.map((p) => rank(p, hmodels));
    for (let i = 0; i < n; i++) {
      const k = (i * 7 + Math.floor(i / 8)) % PROMPTS.length; // deterministic mix
      const pick = order(plans[k].ranked, tgt, u)[0];
      assert(HACKER_IDS.includes(pick.id), 'hacker pick stays within the three');
      u.record(pick.id); picks.push(pick.id);
    }
    return { u, picks, tgt };
  }
  const h1 = hrun(), h2 = hrun();
  assert.deepStrictEqual(h1.picks, h2.picks, 'hacker runs must be identical');
  const hsum = Object.values(h1.tgt).reduce((x, y) => x + y, 0); assert(Math.abs(hsum - 1) < 1e-9, 'hacker targets sum to 1');
  const hshares = HACKER_IDS.map((id) => [id, h1.u.share(id)]);
  console.log('hacker shares: ' + hshares.map(([id, s]) => `${id} ${(s * 100).toFixed(2)}%`).join(', '));
  for (const [id, s] of hshares) assert(Math.abs(s - 1 / 3) < 0.03, `${id} ~33.3% (got ${(s * 100).toFixed(2)}%)`);
  // A missing/unknown model id is handled without throwing: two remain and
  // their targets still sum to 1.
  const hpartial = hmodels.filter((m) => m.id !== HACKER_IDS[0]);
  const hpt = equalTargets(hpartial);
  assert(Math.abs(Object.values(hpt).reduce((a, b) => a + b, 0) - 1) < 1e-9, 'partial hacker targets sum to 1');
  order(rank(PROMPTS[0], hpartial).ranked, hpt, new Usage(null)); // must not throw
  // Normal mode is unaffected: the stock FIXED 50/10 split is intact after the hacker runs.
  const nt = targets(models);
  assert(Math.abs(nt['meta/muse-spark-1.3-contributor'] - 0.5) < 1e-12 && Math.abs(nt['anthropic/claude-haiku-5.5'] - 0.1) < 1e-12, 'normal FIXED split intact after hacker runs');
  // Hacker pool stays exactly the three ids: no Magnum, ever.
  assert.strictEqual(HACKER_IDS.length, 3, 'three-model hacker pool');
  assert(!HACKER_IDS.some((id) => /magnum/i.test(id)), 'no magnum in hacker pool');
  console.log('hacker sim OK');
})().catch((e) => { console.error(e.message); process.exit(1); });
