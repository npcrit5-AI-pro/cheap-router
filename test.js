const { refreshModels, rank, ALWAYS_ALLOW } = require('./router');
(async () => {
  const { cap, models } = await refreshModels(true);
  const bad = models.filter((m) => { const p=+m.pricing.prompt,c=+m.pricing.completion; if (ALWAYS_ALLOW.includes(m.id)) return false; return !(p===0&&c===0) && (p>cap.prompt||c>cap.completion); });
  console.log('cap', cap.id, cap.prompt*1e6, cap.completion*1e6, 'eligible', models.length, 'free', models.filter(m=>+m.pricing.prompt===0&&+m.pricing.completion===0).length, 'violations', bad.length);
  for (const p of ['hi there!', 'Fix this python function: def f(x): return x+', 'Solve 3x+7=22 step by step', 'Write a short poem about autumn'])
    { const r = rank(p, models); console.log(r.cat, '->', r.ranked[0].id, '|', r.ranked[0].why); }
  const missing = ALWAYS_ALLOW.filter((id) => !models.some((m) => m.id === id)); console.log('always-allowed present:', ALWAYS_ALLOW.filter(id=>!missing.includes(id)), 'missing:', missing);
  if (bad.length || missing.length) process.exit(1);
})();
