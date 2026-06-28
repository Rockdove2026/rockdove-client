/**
 * candidate_filter.js — per-total pricing gate (v9)
 * --------------------------------------------------------------------------
 * v8 treats every price as per-head: it compares raw p.price to the ceiling.
 * v9 honours budget_per: in 'total' mode the ceiling is the WHOLE-BRIEF budget,
 * so the comparison is (price × headcount) vs ceiling.
 *
 * eff(p) = budget_per==='total' ? price*headcount : price   (== price when head)
 *
 * T_head / T_omit are regression guards (must PASS on v8 AND v9 — proves the
 * change is behaviour-preserving for per-head and for callers that omit the
 * field). T_total is the fix: RED on v8, GREEN on v9.
 */
import { buildCandidates } from "./candidate_filter.js";

// Same catalogue throughout. In TOTAL mode at headcount 10 the effective prices
// are ×10:  19 000 / 21 000 / 23 000 / 30 000 / 90 000.
const CAT = [
  { id: 1, name: "Alpha",   price: 1900, tags: [] },  // eff@10 = 19 000  → under 20 000
  { id: 2, name: "Bravo",   price: 2100, tags: [] },  // eff@10 = 21 000  → over, tier 1
  { id: 3, name: "Charlie", price: 2300, tags: [] },  // eff@10 = 23 000  → over, tier 1 (within gap)
  { id: 4, name: "Delta",   price: 3000, tags: [] },  // eff@10 = 30 000  → over, tier 2
  { id: 5, name: "Echo",    price: 9000, tags: [] },  // eff@10 = 90 000  → over, tier 3 → EXCLUDED (default 2 tiers)
];
const ids = (r) => r.map((p) => p.id);
const has = (r, id) => ids(r).includes(id);

const results = [];
let section = "";
const sec = (s) => (section = s);
function test(id, desc, fn) {
  try { fn(); results.push({ section, id, desc, ok: true }); }
  catch (e) { results.push({ section, id, desc, ok: false, err: e.message }); }
}
function assert(c, m) { if (!c) throw new Error(m || "assertion failed"); }

sec("regression — per-head unchanged");
test("T_head", "per=head, ceiling 20000 → every price ≤ ceiling is under; Echo(9000) included", () => {
  const r = buildCandidates(CAT, { budget_ceiling: 20000, headcount: 10, budget_per: "head" });
  assert(has(r, 1) && has(r, 5), "all five prices are ≤ 20000 per-unit → all under → all shown");
});
test("T_omit", "budget_per omitted → defaults to head (no accidental total mode)", () => {
  const r = buildCandidates(CAT, { budget_ceiling: 20000, headcount: 10 }); // no budget_per
  assert(has(r, 5), "Echo(9000) stays under when per is absent (back-compat with v8 callers)");
});

sec("fix — per-total honours headcount");
test("T_total", "per=total, hc 10, ceiling 20000 → Echo(eff 90k) EXCLUDED; Alpha under; Bravo over-but-shown", () => {
  const r = buildCandidates(CAT, { budget_ceiling: 20000, headcount: 10, budget_per: "total" });
  assert(has(r, 1), "Alpha eff 19000 ≤ 20000 → under, shown");
  assert(has(r, 2), "Bravo eff 21000 → over within tier 1, shown");
  assert(!has(r, 5), "Echo eff 90000 → tier 3 over (beyond default 2) → EXCLUDED");
});
test("T_single", "per=total, hc 1 → behaves as a per-piece ceiling (single gift)", () => {
  const r = buildCandidates(CAT, { budget_ceiling: 20000, headcount: 1, budget_per: "total" });
  assert(has(r, 1) && has(r, 5), "at hc 1, eff = price → a ₹9,000 piece fits a ₹20,000 single-gift budget");
});

let cur = "";
for (const r of results) {
  if (r.section !== cur) { cur = r.section; console.log(`\n── ${cur} ──`); }
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.id}  ${r.desc}${r.ok ? "" : "  →  " + r.err}`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`\n${"═".repeat(60)}\nTOTAL: ${pass} pass / ${results.length - pass} fail`);
console.log(`Expectation: T_head/T_omit/T_single GREEN on v8; T_total RED on v8 → GREEN on v9.`);
process.exit(0);
