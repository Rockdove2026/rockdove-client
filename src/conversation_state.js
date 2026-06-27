// conversation_state.js  (v8 — open budget: "regardless of price" clears the ceiling)
// ─────────────────────────────────────────────────────────────────────────────
// The client-owned accumulator. Split ownership:
//   • HARD constraints (budget, edible, fragile, weight) — client-owned. Parsed
//     from each user message, applied THIS turn, sticky until the user lifts them.
//     The model may ADD a hard constraint but can never silently DROP one.
//   • The SOFT lean (premium / cheaper / lighter) — advisory. The user's words set
//     it, and the model may RAISE it to "premium" (see mergeModelFilters) to close
//     phrasing gaps the regex misses, but never force "cheaper".
//
// Fixes in this version:
//   #1  mergeModelFilters now accepts the model's premium_requested as an advisory
//       bump, so "can you go higher / something nicer" widens the pool even when the
//       regex doesn't catch the phrasing.
//   #4  Broader negation ("don't", "won't", "skip", "leave out"); bare "light"
//       ("keep it light"); "special" removed from premium triggers (killed the
//       "nothing special" false-positive); on a conflict in one message, the
//       NEGATION wins (safer — keeps the constraint).
// ─────────────────────────────────────────────────────────────────────────────

// Shared negation prefix used by the hard-constraint setters.
const NEG = "(?:no|not|don'?t|does\\s?n'?t|do\\s?n'?t|won'?t|can'?t|cannot|nothing|avoid|without|skip|exclude|leave\\s+out|free\\s+of|non[-\\s]?)";
// Allow a few common filler words between the negation and the constraint word
// ("don't WANT ANYTHING edible") without matching unrelated clauses ("no problem, edible").
const NEG_FILL = "(?:\\s+(?:want|wants|need|needs|like|anything|any|some|something|to|be|too|really|it|them|a|the|have|having))*";

export function createConversationState() {
  return {
    budget_ceiling: null,   // INR per gift
    headcount: null,        // number of recipients
    exclude_edible: false,
    exclude_fragile: false,
    lightweight: false,     // travel / under ~400g
    lean: "balanced",       // balanced | premium | cheaper | light
  };
}

// Parse the LATEST user message and update sticky hard constraints + lean.
export function parseUserMessage(state, text) {
  const t = (text || "").toLowerCase();

  // ── Budget ceiling ─────────────────────────────────────────────────────
  let m =
    t.match(/(?:₹|rs\.?\s*|inr\s*)\s*(\d[\d,]{2,})/) ||
    t.match(/(?:under|around|within|upto|up to|max|budget(?:\s*(?:is|of|=|:))?)\s*₹?\s*(\d[\d,]{2,})/) ||
    t.match(/(\d[\d,]{2,})\s*(?:each|per\s*(?:head|person|gift|piece)|pp|budget)/);
  if (m) {
    const val = parseInt(m[1].replace(/,/g, ""), 10);
    if (val >= 300 && val <= 1000000) state.budget_ceiling = val;
  } else {
    const k = t.match(/(\d+(?:\.\d+)?)\s*k\b/);
    if (k && /(budget|each|under|around|within|per|head|person)/.test(t)) {
      const val = Math.round(parseFloat(k[1]) * 1000);
      if (val >= 300 && val <= 1000000) state.budget_ceiling = val;
    }
  }

  // ── Open budget — client removes the ceiling ("no budget", "regardless of
  // price", "money no object"). Clears any stale ceiling so premium pieces stop
  // being filtered out. Without this, an earlier low budget keeps capping results
  // even after the client says price is no object.
  if (/\bno\s+budget\b/.test(t)
      || /\bregardless\s+of\s+(?:price|cost|budget)\b/.test(t)
      || /\b(?:price|cost|money)\s+(?:is\s+)?no\s+object\b/.test(t)
      || /\bno\s+(?:budget\s+)?(?:limit|ceiling|cap|max(?:imum)?)\b/.test(t)
      || /\bany\s+price\b/.test(t)
      || /\bwhatever\s+it\s+costs\b/.test(t)) {
    state.budget_ceiling = null;
  }

  // ── Headcount ──────────────────────────────────────────────────────────
  const q = t.match(/(\d[\d,]{0,5})\s*(?:senior|junior|people|persons?|recipients?|guests?|employees?|clients?|bankers?|staff|heads?|colleagues?|team|members?|gifts?|boxes?|sets?|pieces?|orders?|items?|baskets?|kits?|bottles?|jars?|tins?|hampers?|units?|pax)/);
  if (q) {
    const val = parseInt(q[1].replace(/,/g, ""), 10);
    if (val >= 1 && val <= 1000000) state.headcount = val;
  }

  // ── Single-gift signal — a one-off gift must NOT inherit an earlier event's
  // headcount. After "50 for Diwali", "a single gift for a client's wedding"
  // should price at qty 1, not 50. Only explicit singular phrasing resets it, so
  // a per-head "one gift each for 100 clients" (headcount 100) is left untouched.
  if (/\b(?:a\s+)?single\s+(?:gift|piece|item|present|hamper|box)\b/.test(t)
      || /\bjust\s+one\b/.test(t)
      || /\bonly\s+one\b/.test(t)
      || /\bone[\s-]off\b/.test(t)) {
    state.headcount = 1;
  }

  // ── Edible — negation wins on conflict ───────────────────────────────────
  const edibleNeg = new RegExp(`${NEG}${NEG_FILL}\\s+(edible|food|consum\\w*|eat\\w*|sweets?|chocolate|snack|gourmet|perishable)`).test(t)
    || /\bnon[-\s]?edible\b/.test(t);
  const edibleOk = /(edible|food|sweets?|chocolate|consumable)s?\s*(?:is|are|'?s)?\s*(fine|ok|okay|good|allowed|welcome|alright)/.test(t)
    || /(allow|include|happy with|open to|fine with)\s*(edible|food|sweets?|chocolate|consumable)/.test(t);
  if (edibleNeg) state.exclude_edible = true;
  else if (edibleOk) state.exclude_edible = false;

  // ── Fragile — negation wins on conflict ──────────────────────────────────
  const fragileNeg = new RegExp(`${NEG}${NEG_FILL}\\s+(fragile|breakable|glass|ceramic|delicate)`).test(t);
  const fragileOk = /(fragile|breakable|glass|ceramic)\s*(?:is|are|'?s)?\s*(fine|ok|okay|allowed|welcome)/.test(t);
  if (fragileNeg) state.exclude_fragile = true;
  else if (fragileOk) state.exclude_fragile = false;

  // ── Lightweight / travel — negation wins on conflict ─────────────────────
  const lightSet =
    (/(travel|carry[-\s]?on|flight|flying|\bfly\b|lightweight|portable|hand luggage|cabin|packs?\s*flat)/.test(t) && !/delight/.test(t))
    || new RegExp(`${NEG}${NEG_FILL}\\s+(heavy|bulky)`).test(t)
    || /\btoo\s*(heavy|bulky)\b/.test(t)
    || /(keep|stay|pack|make)\s*(?:it|them\s*)?\blight\b/.test(t);   // "keep it light"
  const lightOk =
    /(weight|heavy|bulky|size)\s*(?:is|are|'?s)?\s*(fine|ok|okay|no issue|not a (problem|concern))/.test(t)
    || /(can be|happy with)\s*(heavy|heavier|bulky|larger)/.test(t);
  if (lightSet) state.lightweight = true;
  else if (lightOk) state.lightweight = false;

  // ── Lean (directional; persists until changed) ───────────────────────────
  // Note: "special" intentionally NOT a premium trigger ("nothing special",
  // "special occasion" are too ambiguous). The model can still raise premium.
  if (/(premium|upmarket|luxur\w*|high[-\s]?end|finer|nicer|fancier|dressier|more expensive|impressive|statement piece|go(?:ing)?\s+higher|push (?:the )?budget|top[-\s]?tier|nicest|something nicer)/.test(t)) {
    state.lean = "premium";
  } else if (/(cheap\w*|budget[-\s]?friendly|affordable|less expensive|economical|save money|lower[-\s]?priced|keep costs?)/.test(t)) {
    state.lean = "cheaper";
  } else if (/(keep (it )?under budget|within budget|stick to budget|back under|respect the budget)/.test(t)) {
    state.lean = "balanced";
  } else if (state.lightweight && state.lean === "balanced") {
    state.lean = "light";
  }

  return state;
}

// Merge the model's advisory filters — never letting them DROP a hard constraint.
export function mergeModelFilters(state, modelFilters = {}) {
  // Budget: like headcount, trust the model's per-turn read of the CURRENT brief so a
  // stale ceiling can be corrected. "13000 for a couple" doesn't match the budget regex
  // (no Rs./budget marker), and an earlier "around Rs.2,500 each" would otherwise stay
  // stuck and hide every premium piece. The model understands the new figure; let it
  // raise or lower the ceiling. (One-turn lag: corrects the NEXT turn's candidates.)
  if (typeof modelFilters.budget_ceiling === "number" && modelFilters.budget_ceiling > 0) {
    state.budget_ceiling = modelFilters.budget_ceiling;
  }

  // Model can signal the client removed the ceiling ("show the best, price no object").
  // This must run AFTER the numeric set above so an open budget always wins this turn.
  if (modelFilters.budget_open === true) state.budget_ceiling = null;
  // Headcount: trust the model's per-turn read of the CURRENT brief, even to LOWER a
  // stale count. The model understands phrasing the regex can't enumerate ("a couple",
  // "a gift for my friend", "just her") and, seeing the whole history, holds an event's
  // count steady across turns - changing it only when the brief genuinely shifts (e.g.
  // from a 100-gift event to a single wedding gift). This is what a one-way accumulator
  // structurally couldn't do. (One-turn lag: it corrects the NEXT turn's pricing.)
  if (typeof modelFilters.headcount === "number" && modelFilters.headcount >= 1) {
    state.headcount = modelFilters.headcount;
  }
  // Model TRUE may ADD a hard constraint; model FALSE is ignored (only the user's
  // own words turn one off).
  if (modelFilters.exclude_edible === true)  state.exclude_edible = true;
  if (modelFilters.exclude_fragile === true) state.exclude_fragile = true;
  if (modelFilters.lightweight === true)     state.lightweight = true;

  // #1 fix — soft lean: the model MAY raise "premium" (closes phrasing gaps the
  // regex misses, e.g. "can you go higher?"), but never downgrades to cheaper.
  if (modelFilters.premium_requested === true && state.lean !== "cheaper") {
    state.lean = "premium";
  }
  return state;
}

// Shape the accumulator into the filters object buildCandidates expects.
export function toCandidateFilters(state) {
  return {
    budget_ceiling: state.budget_ceiling,
    headcount: state.headcount,
    exclude_edible: state.exclude_edible,
    exclude_fragile: state.exclude_fragile,
    lightweight: state.lightweight,
    premium_requested: state.lean === "premium",
    lean: state.lean,
  };
}
