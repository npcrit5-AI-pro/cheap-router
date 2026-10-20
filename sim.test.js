const assert = require('assert');
const { refreshModels, rank } = require('./router');
const { targets, Usage, order, FIXED, MAX } = require('./alloc');
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
  const { models } = await refreshModels(true);
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
})().catch((e) => { console.error(e.message); process.exit(1); });
