/**
 * conversation_state.js — budget parsing (Phase 5.1 + 5.2)
 * ---------------------------------------------------------------------------
 * 5.1  "not more than / no more than / must not exceed X" is a CEILING.
 *      v9 reads the "more than X" inside it as a FLOOR — inverted budget.
 * 5.2  Indian units: "1.5 lakh" = 150,000; "1 crore" = 10,000,000 (over cap,
 *      rejected by the existing 300..1,000,000 range, same as any huge number).
 *
 * R_* are regression guards (must pass on the CURRENT file — prove the fix
 * doesn't break existing floor/ceiling reads). F_* are the fixes: RED now,
 * GREEN after.
 */
import { createConversationState, parseUserMessage, toCandidateFilters } from "./conversation_state.js";

const results = [];
let section = "";
const sec = (s) => (section = s);

function budgets(text) {
  const state = createConversationState();
  parseUserMessage(state, text);
  const f = toCandidateFilters(state);
  return { ceiling: f.budget_ceiling, floor: f.budget_floor };
}

function check(name, text, want) {
  const got = budgets(text);
  const ok = got.ceiling === want.ceiling && got.floor === want.floor;
  results.push({ section, name, ok, want, got, text });
}

/* ── Regression guards: current behaviour that must survive the fix ── */
sec("R: existing floors");
check("R1 'more than 2000' is a floor",
  "gifts for 50 people, more than 2000 each", { ceiling: null, floor: 2000 });
check("R2 '5000 and above' is a floor",
  "corporate gifts, 5000 and above per head", { ceiling: null, floor: 5000 });
check("R3 'no less than 4000' is a floor",
  "for 20 people, no less than 4000 each", { ceiling: null, floor: 4000 });
check("R4 'at least 3000' is a floor",
  "diwali gifts, at least 3000 per person", { ceiling: null, floor: 3000 });

sec("R: existing ceilings");
check("R5 'under 3000' is a ceiling",
  "gifts for the team, under 3000 each", { ceiling: 3000, floor: null });
check("R6 'budget is 2500' is a ceiling",
  "budget is 2500 per head for 30 people", { ceiling: 2500, floor: null });
check("R7 band 'above 3000, under 8000'",
  "something above 3,000, under 8,000 per head", { ceiling: 8000, floor: 3000 });

/* ── F: Phase 5.1 — negated comparisons are ceilings ── */
sec("F: 5.1 negated maxima");
check("F1 'not more than 2000 each' → ceiling 2000",
  "gifts for 50 people, not more than 2000 each", { ceiling: 2000, floor: null });
check("F2 'no more than 3500 per head' → ceiling 3500",
  "hampers, no more than 3500 per head", { ceiling: 3500, floor: null });
check("F3 'should not exceed 2500' → ceiling 2500",
  "the budget should not exceed 2500 each", { ceiling: 2500, floor: null });
check("F4 'not over 4000' → ceiling 4000",
  "for 10 clients, not over 4000 per gift", { ceiling: 4000, floor: null });
check("F5 'shouldn't go above 3000' → ceiling 3000",
  "gifts that shouldn't go above 3000 each", { ceiling: 3000, floor: null });

/* ── F: Phase 5.2 — lakh / crore units ── */
sec("F: 5.2 Indian units");
check("F6 '1.5 lakh total' → 150000",
  "one gift, budget 1.5 lakh total", { ceiling: 150000, floor: null });
check("F7 '2 lakhs' with budget keyword → 200000",
  "budget of 2 lakhs for the whole event", { ceiling: 200000, floor: null });
check("F8 'under 1 lac' → 100000",
  "keep it under 1 lac total", { ceiling: 100000, floor: null });
check("F9 floor 'above 1 lakh' → floor 100000",
  "premium gift, above 1 lakh", { ceiling: null, floor: 100000 });
check("F10 exact audit input '1.5 lakh total' → 150000",
  "single gift, 1.5 lakh total", { ceiling: 150000, floor: null });
check("F11 bare 'N in total' → ceiling",
  "one hamper, 20,000 in total", { ceiling: 20000, floor: null });

/* ── report ── */
let pass = 0, fail = 0, lastSec = "";
for (const r of results) {
  if (r.section !== lastSec) { console.log("\n== " + r.section + " =="); lastSec = r.section; }
  if (r.ok) { pass++; console.log("  PASS", r.name); }
  else {
    fail++;
    console.log("  FAIL", r.name);
    console.log("        text:", JSON.stringify(r.text));
    console.log("        want:", JSON.stringify(r.want), " got:", JSON.stringify(r.got));
  }
}
console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
