// Live verification for the apis.js catalog. Calls every entry with its example
// params and reports status, latency and whether the mapper produced usable
// output. Run with `npm run apis`. This is intentionally separate from
// `npm test` so the test suite never depends on the network.
const { APIS, find, executeApi } = require('./apis');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = process.argv[2]; // optional: check a single id
(async () => {
  const list = only ? [find(only)].filter(Boolean) : APIS;
  if (!list.length) { console.error('unknown api id:', only); process.exit(2); }
  let pass = 0; const failed = [];
  for (const e of list) {
    const t0 = Date.now();
    const res = await executeApi(e, e.example, { timeoutMs: 15000 });
    const ms = Date.now() - t0;
    const s = JSON.stringify(res.ok ? res.data : res.error);
    const usable = res.ok && s.length > 20 && !/^\{"available":false\}$/.test(s);
    if (usable) { pass++; console.log(`PASS ${e.id} ${ms}ms :: ${s.slice(0, 160)}`); }
    else { failed.push(e.id); console.log(`FAIL ${e.id} ${ms}ms :: ${s.slice(0, 200)}`); }
    await sleep(300); // be polite to free tiers
  }
  console.log(`\n${pass} passed, ${failed.length} failed out of ${list.length}`);
  if (failed.length) console.log('failed:', failed.join(', '));
})();
