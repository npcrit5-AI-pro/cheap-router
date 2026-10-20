// Deterministic share allocation (deficit-weighted fair queueing). No randomness.
const fs = require('fs');
const FIXED = { 'meta/muse-spark-1.3-contributor': 0.5, 'anthropic/claude-haiku-5.5': 0.1 };
const MIN = 0.00001, MAX = 0.08;

// Static quality used to split the remaining share among other models.
function quality(m) {
  const ctx = m.context_length || 4096, p = m.supported_parameters || [];
  const free = +m.pricing.prompt === 0 && +m.pricing.completion === 0;
  return 1 + Math.max(0, Math.log2(ctx / 4096)) / 4 + (free ? 0.5 : 0) + (p.includes('reasoning') ? 0.3 : 0) + (p.includes('tools') ? 0.3 : 0);
}

function targets(models) {
  const t = {}, others = models.filter((m) => !(m.id in FIXED));
  let fixedSum = 0;
  for (const id in FIXED) if (models.some((m) => m.id === id)) { t[id] = FIXED[id]; fixedSum += FIXED[id]; }
  const rest = 1 - fixedSum;
  // clamp to [MIN, MAX] and renormalize (water-filling; repeat until stable)
  const q = Object.fromEntries(others.map((m) => [m.id, quality(m)]));
  let free = others.map((m) => m.id), budget = rest;
  for (let i = 0; i < 50 && free.length; i++) {
    const sum = free.reduce((a, id) => a + q[id], 0);
    const capped = free.filter((id) => (budget * q[id]) / sum > MAX), floored = free.filter((id) => (budget * q[id]) / sum < MIN);
    if (!capped.length && !floored.length) { for (const id of free) t[id] = (budget * q[id]) / sum; free = []; break; }
    for (const id of capped) t[id] = MAX; for (const id of floored) t[id] = MIN;
    budget -= capped.length * MAX + floored.length * MIN;
    free = free.filter((id) => !capped.includes(id) && !floored.includes(id));
  }
  return t;
}

class Usage {
  constructor(file) { this.file = file; this.counts = {}; if (file) try { this.counts = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} }
  total() { return Object.values(this.counts).reduce((a, b) => a + b, 0); }
  share(id) { const n = this.total(); return n ? (this.counts[id] || 0) / n : 0; }
  record(id) { this.counts[id] = (this.counts[id] || 0) + 1; if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.counts, null, 1)); }
}

// ranked: models from router.rank (fit score per model). Returns ordered candidates.
// deficit = target*(N+1) - count  (picks owed); its sum over models is always 1 > 0.
// fit is normalized to [1,2] so task fit tilts the choice but shares still converge.
function order(ranked, tgt, usage) {
  const N = usage.total();
  const sc = ranked.map((r) => r.score), lo = Math.min(...sc), hi = Math.max(...sc);
  return ranked.map((r) => {
    const fit = 1 + (hi > lo ? (r.score - lo) / (hi - lo) : 0);
    const target = tgt[r.id] || 0, deficit = target * (N + 1) - (usage.counts[r.id] || 0);
    const prio = deficit > 0 ? fit * deficit : deficit / fit; // over-served models go last
    return { ...r, fit, target, actual: usage.share(r.id), deficit, prio };
  }).sort((a, b) => b.prio - a.prio || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

module.exports = { targets, Usage, order, FIXED, MIN, MAX };
