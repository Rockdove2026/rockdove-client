// conversation_state.js  (v9 — per-brief state model)
// ─────────────────────────────────────────────────────────────────────────────
// Refactor of v8: the flat global accumulator becomes a set of BRIEFS, exactly one
// ACTIVE at a time. v8's extraction (budget/headcount/open/edible/fragile/light/lean)
// is preserved verbatim and now writes into the ACTIVE brief's business object.
//
// Shape:
//   { active_brief_id, briefs: { [id]: Brief }, saved: [] }
//   Brief = { id, type:'event'|'single-gift'|'unassigned', label, status,
//             recipient?, createdAt, topicTokens?,
//             business: { headcount, budget:{ceiling,per:'head'|'total',open},
//                         exclude_edible, exclude_fragile, lightweight, lean },
//             retrieval: { sticky:{[id]:turnsLeft}, shown:[], dismissed:[] } }
//
// Ownership unchanged from v8: hard constraints client-owned & sticky; soft lean
// advisory; model may ADD/RAISE, never silently DROP. saved is conversation-global.
// ─────────────────────────────────────────────────────────────────────────────

const NEG = "(?:no|not|don'?t|does\\s?n'?t|do\\s?n'?t|won'?t|can'?t|cannot|nothing|avoid|without|skip|exclude|leave\\s+out|free\\s+of|non[-\\s]?)";
const NEG_FILL = "(?:\\s+(?:want|wants|need|needs|like|anything|any|some|something|to|be|too|really|it|them|a|the|have|having))*";

let _seq = 0;
const generateBriefId = () => "brief_" + (Date.now().toString(36)) + "_" + (_seq++).toString(36);

function emptyBusiness() {
  return {
    headcount: null,
    budget: { ceiling: null, per: "head", open: false },
    exclude_edible: false,
    exclude_fragile: false,
    lightweight: false,
    lean: "balanced",
  };
}
function newBrief(type = "unassigned", label = "New brief") {
  return {
    id: generateBriefId(),
    type,
    label,
    status: "active",
    recipient: null,
    createdAt: ++_seq,
    topicTokens: [],
    business: emptyBusiness(),
    retrieval: { sticky: {}, shown: [], dismissed: [] },
  };
}

export function createConversationState() {
  const b = newBrief("unassigned", "Initial brief");
  return { active_brief_id: b.id, briefs: { [b.id]: b }, saved: [] };
}

export function activeBrief(state) {
  return state && state.briefs && state.active_brief_id ? state.briefs[state.active_brief_id] : undefined;
}
const briefsOf = (s) => (s && s.briefs ? Object.values(s.briefs) : []);
const liveBriefs = (s) => briefsOf(s).filter((b) => b.status !== "resolved");

function isEmptySeed(b) {
  if (!b) return false;
  const z = b.business;
  return b.type === "unassigned" && z.headcount == null && z.budget.ceiling == null &&
    z.budget.open === false && !z.exclude_edible && !z.exclude_fragile && !z.lightweight &&
    z.lean === "balanced" && (b.retrieval.shown || []).length === 0 &&
    Object.keys(b.retrieval.sticky || {}).length === 0;
}

// ── token helpers ────────────────────────────────────────────────────────────
const LABEL_STOP = new Set(["a","an","the","for","our","my","one","gift","gifts","present","presents",
  "brief","event","thing","something","this","that","initial","restored","new","gifting","go","back","to","with"]);
const tok = (s) => (s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !LABEL_STOP.has(w));

const TOPIC_WORDS = ["retreat","offsite","wedding","diwali","anniversary","holi","rakhi","board",
  "clients","client","employees","employee","staff","team","partners","distributors","vendors",
  "suppliers","customers","dealers","guests","ceo","assistant","speaker","keynote","founder",
  "director","manager","executive","boss"];
function topicTokensFromText(t) {
  const out = new Set();
  for (const w of TOPIC_WORDS) if (new RegExp(`\\b${w}\\b`).test(t)) out.add(w === "clients" ? "client" : (w === "employees" ? "employee" : w));
  return [...out];
}
function matchTokens(b) {
  const set = new Set(tok(b.label));
  if (b.recipient) for (const w of tok(b.recipient)) set.add(w);
  for (const w of (b.topicTokens || [])) set.add(w);
  return set;
}

// ── reference detectors ──────────────────────────────────────────────────────
const SINGULAR_ROLES = ["keynote speaker","chief executive","chief exec","managing director",
  "ceo","boss","md","founder","principal","chairman","chairperson","assistant","ea","pa",
  "secretary","speaker","manager","director","executive","friend","wife","husband","partner",
  "mother","father","client"];
function detectSingularGift(t) {
  for (const role of SINGULAR_ROLES) {
    if (new RegExp(`\\bfor\\s+(?:the\\s+|our\\s+|my\\s+|a\\s+)?${role}\\b`).test(t)) return { isSingle: true, recipient: role };
  }
  if (/\b(?:a\s+)?single\s+(?:gift|piece|item|present|hamper|box)\b/.test(t) || /\bjust\s+one\b/.test(t) ||
      /\bonly\s+one\b/.test(t) || /\bone[\s-]off\b/.test(t)) return { isSingle: true, recipient: null };
  return { isSingle: false, recipient: null };
}
function detectDivergence(t) {
  return /\b(separately|separate|also need|i also|in addition|additionally|another|one more|on top of that|aside from)\b/.test(t);
}
function detectRecipientGroupIntro(t) {
  const intro = /\b(let'?s\s+(?:think about|look at|move on to|talk about|consider)|now|next)\b/.test(t);
  const group = /\b(distributors|partners|vendors|suppliers|customers|clients|employees|staff|team|board|managers|dealers|resellers|stakeholders)\b/.test(t);
  return intro && group;
}
function detectOrdinal(t) {
  if (/\b(first|1st|earliest|original|oldest)\b/.test(t)) return "first";
  if (/\b(last|latest|most recent|previous|newest)\b/.test(t)) return "last";
  return null;
}
const ALIASES = {
  ceo: ["ceo","boss","chief exec","chief executive","md","managing director","founder","principal","head honcho"],
  assistant: ["assistant","ea","pa","secretary"],
  speaker: ["speaker","keynote"],
};
function recipientCanonical(b) {
  const r = (b.recipient || "").toLowerCase();
  for (const canon in ALIASES) if (canon === r || ALIASES[canon].includes(r)) return canon;
  const lt = tok(b.label);
  for (const canon in ALIASES) if (lt.includes(canon) || lt.some((w) => ALIASES[canon].includes(w))) return canon;
  return null;
}
function aliasMatch(t, b) {
  const canon = recipientCanonical(b);
  if (!canon) return false;
  return ALIASES[canon].some((a) => new RegExp(`\\b${a}\\b`).test(t));
}
function detectProductRef(t) {
  const form = /\b(box|set|tray|platter|hamper|candle|stole|bowl|frame|kit|tin|jar|bottle|options?|tea set|pieces?)\b/;
  if (/\bagain\b/.test(t) && /\b(show|see|pull up|bring up|look at)\b/.test(t)) return true;
  if (form.test(t) && /\b(the|this|that|those|these)\b/.test(t)) return true;
  return false;
}
function isBareParam(t) {
  return /\bmake it\b/.test(t) || /\bchange (?:it )?to\b/.test(t) || /\bset it to\b/.test(t) ||
    /\b(increase|decrease|drop|raise|lower|bump)\b/.test(t) || /\bbudget\b/.test(t) ||
    /\bprice\b/.test(t) || /\bluxurious\b/.test(t) || /\bmore\b/.test(t) || /\bcheaper\b/.test(t) ||
    /\d/.test(t);
}

// ── SWITCH scoring: a parked brief must STRICTLY beat the active brief to win ──
function scoreBrief(t, b) {
  let s = 0;
  const mt = matchTokens(b);
  const words = new Set(tok(t));
  for (const w of mt) if (words.has(w)) s += 1;
  if (b.type === "event" && /\b(client|clients|event|retreat|offsite|team|staff|employees?)\b/.test(t)) s += 0.5;
  if (b.type === "single-gift" && /\b(assistant|speaker|keynote|ceo|boss|founder|director|manager)\b/.test(t)) s += 0.5;
  if (aliasMatch(t, b)) s += 2;
  return s;
}
function resolveSwitch(state, t) {
  const live = liveBriefs(state);
  const active = activeBrief(state);
  // ordinal first/last → a specific brief by creation order
  const ord = detectOrdinal(t);
  if (ord) {
    const ordered = live.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const target = ord === "first" ? ordered[0] : ordered[ordered.length - 1];
    if (target && target.id !== state.active_brief_id) return { targetId: target.id, score: 3 };
  }
  let best = null, bestScore = 0;
  const activeScore = active ? scoreBrief(t, active) : 0;
  for (const b of live) {
    if (b.id === state.active_brief_id) continue;
    const sc = scoreBrief(t, b);
    if (sc > bestScore) { bestScore = sc; best = b; }
  }
  if (best && bestScore >= 1 && bestScore > activeScore) return { targetId: best.id, score: bestScore };
  return null;
}
function referenceMatchesActive(t, state) {
  const active = activeBrief(state);
  if (!active) return false;
  const words = new Set(tok(t));
  for (const w of matchTokens(active)) if (words.has(w)) return true;
  return aliasMatch(t, active);
}

// ── routeIntent (pure) ───────────────────────────────────────────────────────
export function routeIntent(state, text) {
  const t = (text || "").toLowerCase();
  const base = { op: "UPDATE", reference: "none", targetId: null, score: 0, clarify: false, lifecycle: null };

  // 1. Lifecycle — SPECIFIC (reset-active) before GENERIC (resolve-all).
  if (/\b(start over|start again)\b[^.]*\bthis\s+brief\b/.test(t) || /\bforget\s+this\s+brief\b/.test(t) ||
      /\breset\s+this\s+brief\b/.test(t) || /\bclear\s+this\s+brief\b/.test(t)) {
    return { ...base, lifecycle: "reset-active", reference: "none", score: 1 };
  }
  if (/\bstart\s+(?:over|fresh|again)\b/.test(t) || /\bforget\s+everything\b/.test(t) || /\bclear\s+everything\b/.test(t)) {
    return { ...base, lifecycle: "resolve-all", reference: "none", score: 1 };
  }

  // 2. SWITCH — an explicit reference to a NON-ACTIVE existing brief (label / alias / ordinal).
  const sw = resolveSwitch(state, t);
  if (sw) return { ...base, op: "SWITCH", reference: "brief", targetId: sw.targetId, score: sw.score };

  // 3. CREATE — divergence token OR a singular-recipient gift that isn't the active brief.
  const sg = detectSingularGift(t);
  const div = detectDivergence(t);
  if (div || sg.isSingle) {
    const refersActive = sg.isSingle && !div && referenceMatchesActive(t, state);
    if (!refersActive) {
      return { ...base, op: "CREATE", reference: "none", briefType: sg.isSingle ? "single-gift" : "unassigned",
               recipient: sg.recipient, score: 1 };
    }
  }

  // 4. CLARIFY band.
  const nLive = liveBriefs(state).length;
  const hasRef = referenceMatchesActive(t, state);
  if (detectRecipientGroupIntro(t) && !div && !hasRef) {
    return { ...base, reference: "parameter", clarify: true, score: 0.5 };
  }
  if (nLive >= 2 && !hasRef && isBareParam(t)) {
    return { ...base, reference: "parameter", clarify: true, score: 0.5 };
  }

  // 5. UPDATE active — classify the reference for the retrieval layer.
  let reference = "none";
  if (detectProductRef(t)) reference = "product";
  else if (isBareParam(t) || /\bprice no object\b/.test(t)) reference = "parameter";
  return { ...base, op: "UPDATE", reference };
}

// ── v8 extraction, preserved — writes into a brief.business + reports signals ──
function extractInto(b, text) {
  const t = (text || "").toLowerCase();
  const z = b.business;
  let touchedBudget = false, singleSignal = false;

  // Budget ceiling
  let m =
    t.match(/(?:₹|rs\.?\s*|inr\s*)\s*(\d[\d,]{2,})/) ||
    t.match(/(?:under|around|within|upto|up to|max|budget(?:\s*(?:is|of|=|:))?)\s*₹?\s*(\d[\d,]{2,})/) ||
    t.match(/(\d[\d,]{2,})\s*(?:each|per\s*(?:head|person|gift|piece)|pp|budget)/);
  if (m) {
    const val = parseInt(m[1].replace(/,/g, ""), 10);
    if (val >= 300 && val <= 1000000) { z.budget.ceiling = val; z.budget.open = false; touchedBudget = true; }
  } else {
    const k = t.match(/(\d+(?:\.\d+)?)\s*k\b/);
    if (k && /(budget|each|under|around|within|per|head|person)/.test(t)) {
      const val = Math.round(parseFloat(k[1]) * 1000);
      if (val >= 300 && val <= 1000000) { z.budget.ceiling = val; z.budget.open = false; touchedBudget = true; }
    }
  }

  // Open budget — clears the ceiling
  if (/\bno\s+budget\b/.test(t) || /\bregardless\s+of\s+(?:price|cost|budget)\b/.test(t) ||
      /\b(?:price|cost|money)\s+(?:is\s+)?no\s+object\b/.test(t) ||
      /\bno\s+(?:budget\s+)?(?:limit|ceiling|cap|max(?:imum)?)\b/.test(t) ||
      /\bany\s+price\b/.test(t) || /\bwhatever\s+it\s+costs\b/.test(t)) {
    z.budget.ceiling = null; z.budget.open = true;
  }

  // Headcount
  const q = t.match(/(\d[\d,]{0,5})\s*(?:senior|junior|people|persons?|recipients?|guests?|employees?|clients?|bankers?|staff|heads?|colleagues?|team|members?|gifts?|boxes?|sets?|pieces?|orders?|items?|baskets?|kits?|bottles?|jars?|tins?|hampers?|units?|pax)/);
  if (q) { const val = parseInt(q[1].replace(/,/g, ""), 10); if (val >= 1 && val <= 1000000) z.headcount = val; }

  // Single-gift signal
  if (/\b(?:a\s+)?single\s+(?:gift|piece|item|present|hamper|box)\b/.test(t) || /\bjust\s+one\b/.test(t) ||
      /\bonly\s+one\b/.test(t) || /\bone[\s-]off\b/.test(t)) { z.headcount = 1; singleSignal = true; }

  // Edible
  const edibleNeg = new RegExp(`${NEG}${NEG_FILL}\\s+(edible|food|consum\\w*|eat\\w*|sweets?|chocolate|snack|gourmet|perishable)`).test(t) || /\bnon[-\s]?edible\b/.test(t);
  const edibleOk = /(edible|food|sweets?|chocolate|consumable)s?\s*(?:is|are|'?s)?\s*(fine|ok|okay|good|allowed|welcome|alright)/.test(t) || /(allow|include|happy with|open to|fine with)\s*(edible|food|sweets?|chocolate|consumable)/.test(t);
  if (edibleNeg) z.exclude_edible = true; else if (edibleOk) z.exclude_edible = false;

  // Fragile
  const fragileNeg = new RegExp(`${NEG}${NEG_FILL}\\s+(fragile|breakable|glass|ceramic|delicate)`).test(t);
  const fragileOk = /(fragile|breakable|glass|ceramic)\s*(?:is|are|'?s)?\s*(fine|ok|okay|allowed|welcome)/.test(t);
  if (fragileNeg) z.exclude_fragile = true; else if (fragileOk) z.exclude_fragile = false;

  // Lightweight
  const lightSet =
    (/(travel|carry[-\s]?on|flight|flying|\bfly\b|lightweight|portable|hand luggage|cabin|packs?\s*flat)/.test(t) && !/delight/.test(t)) ||
    new RegExp(`${NEG}${NEG_FILL}\\s+(heavy|bulky)`).test(t) || /\btoo\s*(heavy|bulky)\b/.test(t) ||
    /(keep|stay|pack|make)\s*(?:it|them\s*)?\blight\b/.test(t);
  const lightOk = /(weight|heavy|bulky|size)\s*(?:is|are|'?s)?\s*(fine|ok|okay|no issue|not a (problem|concern))/.test(t) || /(can be|happy with)\s*(heavy|heavier|bulky|larger)/.test(t);
  if (lightSet) z.lightweight = true; else if (lightOk) z.lightweight = false;

  // Lean
  if (/(premium|upmarket|luxur\w*|high[-\s]?end|finer|nicer|fancier|dressier|more expensive|impressive|statement piece|go(?:ing)?\s+higher|push (?:the )?budget|top[-\s]?tier|nicest|something nicer)/.test(t)) z.lean = "premium";
  else if (/(cheap\w*|budget[-\s]?friendly|affordable|less expensive|economical|save money|lower[-\s]?priced|keep costs?)/.test(t)) z.lean = "cheaper";
  else if (/(keep (it )?under budget|within budget|stick to budget|back under|respect the budget)/.test(t)) z.lean = "balanced";
  else if (z.lightweight && z.lean === "balanced") z.lean = "light";

  // per-mode markers
  let explicitPer = null;
  if (/\b(in\s*total|total|all[-\s]?in|altogether|for\s+all|for\s+the\s+whole)\b/.test(t)) explicitPer = "total";
  if (/\b(per\s*head|per\s*person|each|pp|a\s*head|a\s*person|apiece)\b/.test(t)) explicitPer = "head";
  return { touchedBudget, singleSignal, explicitPer };
}

function typeUpgrade(b, sig) {
  const before = b.type;
  if (sig.singleSignal) { b.type = "single-gift"; b.business.headcount = 1; }
  else if (b.type === "unassigned" && typeof b.business.headcount === "number" && b.business.headcount > 1) b.type = "event";
  const changed = b.type !== before;
  if (sig.explicitPer) b.business.budget.per = sig.explicitPer;
  else if (changed) b.business.budget.per = b.type === "single-gift" ? "total" : "head";
}

function syncFlat(state) {
  const b = activeBrief(state);
  if (!b) return;
  state.headcount = b.business.headcount;
  state.budget_ceiling = b.business.budget.ceiling;
}

function ensureActive(state) {
  if (!activeBrief(state)) {
    const b = newBrief("unassigned", "Initial brief");
    state.briefs = state.briefs || {};
    state.briefs[b.id] = b;
    state.active_brief_id = b.id;
  }
}

// ── parseUserMessage — route, mutate, then extract into the active brief ──────
export function parseUserMessage(state, text) {
  if (!state || !state.briefs) state = migrateState(state);
  ensureActive(state);

  const routing = routeIntent(state, text);

  if (routing.lifecycle === "resolve-all") {
    for (const b of briefsOf(state)) b.status = "resolved";
    const fresh = newBrief("unassigned", "Initial brief");
    state.briefs[fresh.id] = fresh;
    state.active_brief_id = fresh.id;
    state.pending_clarify = false;
    syncFlat(state);
    return state;
  }
  if (routing.lifecycle === "reset-active") {
    const a = activeBrief(state);
    if (a) { a.type = "unassigned"; a.business = emptyBusiness(); a.retrieval = { sticky: {}, shown: [], dismissed: [] }; a.recipient = null; a.topicTokens = []; }
    state.pending_clarify = false;
    syncFlat(state);
    return state;
  }
  if (routing.clarify) { state.pending_clarify = true; return state; }

  if (routing.op === "CREATE") {
    let target = activeBrief(state);
    if (!isEmptySeed(target)) {
      if (target) target.status = "parked";
      target = newBrief("unassigned", "New brief");
      state.briefs[target.id] = target;
      state.active_brief_id = target.id;
    }
    target.status = "active";
    if (routing.briefType === "single-gift") { target.type = "single-gift"; target.business.headcount = 1; target.business.budget.per = "total"; }
    target.recipient = routing.recipient || target.recipient;
    const tt = new Set([...(target.topicTokens || []), ...topicTokensFromText((text || "").toLowerCase())]);
    target.topicTokens = [...tt];
    if (routing.recipient) target.label = cap(routing.recipient) + " gift";
    else if (target.topicTokens.length) target.label = target.topicTokens.slice(0, 3).map(cap).join(" ");
  } else if (routing.op === "SWITCH" && routing.targetId && state.briefs[routing.targetId]) {
    const a = activeBrief(state); if (a) a.status = "parked";
    state.active_brief_id = routing.targetId;
    state.briefs[routing.targetId].status = "active";
  }

  const b = activeBrief(state);
  if (!b) { syncFlat(state); return state; }
  const sig = extractInto(b, text);
  // fold any topic tokens from this turn into the brief (helps later switches)
  if (b.type !== "unassigned" || sig) {
    const tt = new Set([...(b.topicTokens || []), ...topicTokensFromText((text || "").toLowerCase())]);
    b.topicTokens = [...tt];
  }
  typeUpgrade(b, sig);
  if ((b.label === "Initial brief" || b.label === "New brief") && b.type !== "unassigned") {
    b.label = (b.topicTokens && b.topicTokens.length) ? b.topicTokens.slice(0, 3).map(cap).join(" ") : (b.type === "single-gift" ? "Single gift" : "Event");
  }
  state.pending_clarify = false;
  syncFlat(state);
  return state;
}

function cap(s) { return (s || "").split(/\s+/).map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(" "); }

// ── mergeModelFilters — per-brief, null-safe (v8 invariant 10 preserved) ──────
export function mergeModelFilters(state, modelFilters = {}) {
  if (!state || !state.briefs) state = migrateState(state);
  ensureActive(state);
  const b = activeBrief(state);
  if (!b) return state;
  const z = b.business;

  if (typeof modelFilters.budget_ceiling === "number" && modelFilters.budget_ceiling > 0) { z.budget.ceiling = modelFilters.budget_ceiling; z.budget.open = false; }
  if (modelFilters.budget_open === true) { z.budget.ceiling = null; z.budget.open = true; }
  if (typeof modelFilters.headcount === "number" && modelFilters.headcount >= 1 && b.type !== "single-gift") z.headcount = modelFilters.headcount;
  if (modelFilters.exclude_edible === true) z.exclude_edible = true;
  if (modelFilters.exclude_fragile === true) z.exclude_fragile = true;
  if (modelFilters.lightweight === true) z.lightweight = true;
  if (modelFilters.premium_requested === true && z.lean !== "cheaper") z.lean = "premium";

  syncFlat(state);
  return state;
}

// ── toCandidateFilters — shape the ACTIVE brief for buildCandidates ───────────
export function toCandidateFilters(state) {
  const b = activeBrief(state);
  if (!b) return { budget_ceiling: null, headcount: null, exclude_edible: false, exclude_fragile: false, lightweight: false, premium_requested: false, lean: "balanced", budget_per: "head" };
  const z = b.business;
  return {
    budget_ceiling: z.budget.ceiling,
    headcount: z.headcount,
    exclude_edible: z.exclude_edible,
    exclude_fragile: z.exclude_fragile,
    lightweight: z.lightweight,
    premium_requested: z.lean === "premium",
    lean: z.lean,
    budget_per: z.budget.per,
  };
}

// ── resolveActiveBrief — mark active resolved, keep exactly one active ─────────
export function resolveActiveBrief(state) {
  const a = activeBrief(state);
  if (a) a.status = "resolved";
  const parked = briefsOf(state).filter((b) => b.status === "parked").sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
  if (parked.length) { parked[0].status = "active"; state.active_brief_id = parked[0].id; }
  else { const f = newBrief("unassigned", "Initial brief"); state.briefs[f.id] = f; state.active_brief_id = f.id; }
  syncFlat(state);
  return state;
}

// ── migrateState — v8 flat blob → v9; passthrough if already v9 ───────────────
export function migrateState(persisted) {
  if (!persisted) return createConversationState();
  if (persisted.briefs && persisted.active_brief_id) return persisted;

  const hc = typeof persisted.headcount === "number" ? persisted.headcount : null;
  const b = newBrief(hc === 1 ? "single-gift" : (hc != null && hc > 1 ? "event" : "unassigned"), "Restored brief");
  b.business.headcount = hc;
  b.business.budget.ceiling = (typeof persisted.budget_ceiling === "number") ? persisted.budget_ceiling : null;
  b.business.budget.per = hc === 1 ? "total" : "head";
  b.business.exclude_edible = !!persisted.exclude_edible;
  b.business.exclude_fragile = !!persisted.exclude_fragile;
  b.business.lightweight = !!persisted.lightweight;
  b.business.lean = persisted.lean || "balanced";

  return {
    active_brief_id: b.id,
    briefs: { [b.id]: b },
    saved: Array.isArray(persisted.saved) ? persisted.saved : [],
  };
}
