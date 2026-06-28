// candidate_filter.js  (v9 — per-total pricing: ceiling compared against price × headcount when budget_per==='total')
// ─────────────────────────────────────────────────────────────────────────────
// Builds the per-turn candidate pool passed to /dove-converse.
//
// Fix in this version (#3): "tiers above budget" now means CLUSTERED price tiers,
// not distinct exact prices. Prices within a gap of each other collapse into one
// tier, so a catalogue with granular pricing (₹2,810 / ₹2,840 / ₹2,890…) no longer
// yields a razor-thin slice for "2 tiers above". The gap scales with the budget.
//
// `filters` comes from toCandidateFilters(state) in conversation_state.js.
// `catalog` is the Supabase catalogue already loaded client-side. Wire the three
// app-specific predicates below to however your rows encode edible/fragile/weight.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CANDIDATES = 40;
const TIERS_ABOVE_DEFAULT = 2;   // clustered price tiers above ceiling, normally
const TIERS_ABOVE_PREMIUM = 4;   // ...and when the client asked for premium
const RESERVED_PREMIUM = 6;      // min above-ceiling pieces kept when premium NOT asked
const PREMIUM_LEAD_SHARE = 0.6;  // share of slots led by premium when it IS asked
const LIGHT_MAX_G = 400;

const CLUSTER_GAP_FRAC = 0.1;    // prices within 10% of the ceiling cluster into one tier
const CLUSTER_GAP_MIN  = 250;    // ...but at least ₹250, so small budgets cluster sanely

// ── App-specific predicates — wire to your existing tag/dimension checks ──
const isEdible  = p => hasTag(p, ["edible", "consumable", "food", "sweets", "gourmet", "perishable"]);
const isFragile = p => hasTag(p, ["fragile", "glass", "ceramic", "breakable", "delicate"]);
const weightOf  = p => Number(p.weight_g ?? p.weight ?? 0);   // grams; 0 if unknown

function hasTag(p, names) {
  const tags = (p.tags || p.product_tags || []).map(t =>
    String(typeof t === "string" ? t : t.tag || "").toLowerCase()
  );
  return names.some(n => tags.includes(n));
}

// Allowed above-ceiling prices, grouped into `nTiers` CLUSTERED tiers.
// Consecutive distinct prices separated by <= gap belong to the same tier.
function allowedAboveByTier(items, ceiling, nTiers, effOf = p => p.price) {
  const gap = Math.max(Math.round(ceiling * CLUSTER_GAP_FRAC), CLUSTER_GAP_MIN);
  const above = [...new Set(items.filter(p => effOf(p) > ceiling).map(p => effOf(p)))].sort((a, b) => a - b);
  const allowed = new Set();
  let tiers = 0, prev = null;
  for (const price of above) {
    if (prev === null || price - prev > gap) {
      tiers++;                       // a new tier begins
      if (tiers > nTiers) break;
    }
    allowed.add(price);
    prev = price;
  }
  return allowed;
}

function sortByLean(pool, lean) {
  const arr = [...pool];
  if (lean === "premium")      arr.sort((a, b) => b.price - a.price);
  else if (lean === "cheaper") arr.sort((a, b) => a.price - b.price);
  else if (lean === "light")   arr.sort((a, b) => weightOf(a) - weightOf(b));
  else                         arr.sort((a, b) => (a.id || 0) - (b.id || 0)); // balanced default
  return arr;
}

export function buildCandidates(catalog, filters = {}, max = MAX_CANDIDATES, query = "", stickyIds = []) {
  const ceiling = filters.budget_ceiling || null;
  const premium = !!filters.premium_requested;

  // Per-total budgets: the ceiling is the WHOLE-BRIEF figure, so a piece's
  // effective cost is price × headcount. In per-head mode (default, and any caller
  // that omits budget_per) eff(p) === p.price, so behaviour is identical to v8.
  const headcount = (typeof filters.headcount === "number" && filters.headcount >= 1) ? filters.headcount : 1;
  const perTotal = filters.budget_per === "total";
  const eff = p => (perTotal ? p.price * headcount : p.price);

  // Products the client NAMED explicitly — searched across the FULL catalogue so
  // a named piece surfaces even if the brief filters would otherwise drop it.
  const pinned = query ? findNamedMatches(catalog, query).map(compact) : [];

  // Hard constraints (mirror the client-owned accumulator).
  let pool = (catalog || []).filter(p => {
    if (filters.exclude_edible  && isEdible(p))  return false;
    if (filters.exclude_fragile && isFragile(p)) return false;
    if (filters.lightweight     && weightOf(p) > LIGHT_MAX_G) return false;
    return true;
  });

  // Category browse: when the client asks for a TYPE of thing ("candles", "brass",
  // "tea", "something for the home") rather than a named piece, restrict the
  // recommendation pool to products that actually match - by name, tags and box
  // contents - so Dove shows real candles instead of reaching for a remembered one.
  // Budget and the lean still apply within the restricted set. Only restrict when it
  // leaves something to show; otherwise fall back to the full pool.
  const categoryIds = query ? findCategoryMatches(catalog, query) : [];
  if (categoryIds.length) {
    const catSet = new Set(categoryIds);
    const restricted = pool.filter(p => catSet.has(p.id));
    if (restricted.length) pool = restricted;
  }

  let base;
  if (pool.length === 0) {
    base = [];
  } else if (!ceiling) {
    // No budget stated → sort by lean, return the top slice.
    base = sortByLean(pool, filters.lean).slice(0, max).map(compact);
  } else {
    const tiers = premium ? TIERS_ABOVE_PREMIUM : TIERS_ABOVE_DEFAULT;
    const allowedAbove = allowedAboveByTier(pool, ceiling, tiers, eff);

    const under = pool
      .filter(p => eff(p) <= ceiling)
      .sort((a, b) => (ceiling - eff(a)) - (ceiling - eff(b))); // closest to ceiling first
    const over = pool
      .filter(p => eff(p) > ceiling && allowedAbove.has(eff(p)))
      .sort((a, b) => eff(a) - eff(b));                          // cheapest-premium first

    let capped;
    if (premium) {
      const premiumSlots = Math.min(over.length, Math.ceil(max * PREMIUM_LEAD_SHARE));
      capped = [...over.slice(0, premiumSlots), ...under].slice(0, max);
    } else {
      const reserved = Math.min(over.length, RESERVED_PREMIUM);
      const underSlots = Math.max(0, max - reserved);
      capped = [...under.slice(0, underSlots), ...over.slice(0, reserved)];
    }
    base = capped.map(compact);
  }

  // Sticky products: recently named or shown in earlier turns. Force-included from
  // the FULL catalogue so a follow-up like "yes" / "and the price?" still has the
  // piece under discussion, even though THIS message names nothing. Without this,
  // a product falls out of candidates the moment the client stops naming it, and
  // Dove loses track of (or contradicts) what it just said.
  const sticky = (Array.isArray(stickyIds) && stickyIds.length)
    ? stickyIds
        .map(id => (catalog || []).find(p => p.id === id))
        .filter(Boolean)
        .map(compact)
    : [];

  // Lead = this turn's named pins, then sticky context; deduped, order preserved.
  const seen = new Set();
  const lead = [];
  for (const p of [...pinned, ...sticky]) {
    if (!seen.has(p.id)) { seen.add(p.id); lead.push(p); }
  }

  if (!lead.length) return base;
  return [...lead, ...base.filter(p => !seen.has(p.id))].slice(0, max);
}

// ── Named-product retrieval ─────────────────────────────────────────────────
// When a client names a specific piece ("the Kashmiri Kahwa Set", "naturalist
// box"), make sure it reaches the model even if the brief filters would drop it.
// Guard against over-matching: a product is pinned only when MOST of its
// distinctive name survives in the message, so a lone generic word ("tea")
// stays a category browse rather than pinning dozens of products.
const NAME_STOP = new Set([
  "the","a","an","of","and","with","for","to","in","on","our","your","my","me",
  "set","sets","box","boxes","gift","gifts","collection","collections",
  "hamper","hampers","basket","baskets","kit","kits","pack","packs",
  "tin","tins","jar","jars","bottle","bottles","s","o","e",
  "show","see","price","cost","what","whats","is","are","it","this","that",
  "please","can","you","want","need","get","give","tell","about","some","any",
  // occasion / audience context — brief words, not product names
  "diwali","christmas","holi","rakhi","eid","wedding","birthday","anniversary",
  "festive","festival","corporate","client","clients","staff","team","employees",
  "recipient","recipients","people","guests",
]);

function nameTokens(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t && !NAME_STOP.has(t) && !/^\d+$/.test(t));
}

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function tokMatch(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
  if (a.length >= 4 && b.length >= 4 && Math.abs(a.length - b.length) <= 1 && lev(a, b) <= 1) return true;
  return false;
}

export function findNamedMatches(catalog, query) {
  const q = nameTokens(query);
  if (q.length === 0) return [];
  const scored = [];
  for (const p of (catalog || [])) {
    const nm = nameTokens(p.name);
    if (!nm.length) continue;
    let matched = 0;
    for (const nt of nm) if (q.some(qt => tokMatch(nt, qt))) matched++;
    const frac = matched / nm.length;
    if (matched >= 1 && frac >= 0.6) scored.push({ p, matched, frac });
  }
  scored.sort((a, b) => b.frac - a.frac || b.matched - a.matched);
  return scored.slice(0, 5).map(x => x.p);
}

// ── Category / keyword retrieval ────────────────────────────────────────────
// When a client browses by TYPE ("any candles?", "something in brass", "tea sets")
// rather than naming a piece, restrict candidates to products that genuinely match.
// Without this, a category ask returns the brief's generic top slice and Dove may
// pitch a remembered item it can't show. Matching is on whole words across name,
// tags and box contents, so "tea" matches a tea set but not "steamer".
const CATEGORY_VOCAB = new Set([
  // item types
  "candle","candles","tea","coffee","mug","mugs","cup","cups","bowl","bowls",
  "plate","plates","tray","trays","frame","frames","coaster","coasters",
  "scarf","scarves","stole","stoles","shawl","shawls","pashmina","wrap",
  "soap","soaps","incense","diya","diyas","urli","platter","platters",
  "spoon","spoons","tumbler","tumblers","jar","jars","bottle","bottles",
  "vase","vases","clock","clocks","journal","notebook","pen","planter",
  // materials
  "brass","marble","silver","gold","golden","ceramic","wood","wooden","bone",
  "inlay","leather","glass","copper","stoneware","nacre","pearl","silk","wool","cashmere",
  // qualities / scents
  "scented","soy","floral","handpainted","hand-painted","handmade","engraved","embroidered",
  // rooms / use
  "home","kitchen","desk","table","tableware","barware","bar","decor","decorative","dining",
]);

function categoryTerms(query) {
  return [...new Set(
    String(query || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(t => CATEGORY_VOCAB.has(t))
  )];
}

function productTokens(p) {
  const tags = (p.tags || p.product_tags || [])
    .map(t => (typeof t === "string" ? t : (t && t.tag) || ""))
    .join(" ");
  const box = Array.isArray(p.whats_in_box) ? p.whats_in_box.join(" ") : (p.whats_in_box || "");
  const text = [p.name || "", tags, box, p.short_desc || p.description || ""].join(" ");
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean)
  );
}

export function findCategoryMatches(catalog, query) {
  const terms = categoryTerms(query);
  if (!terms.length) return [];
  const hits = [];
  for (const p of (catalog || [])) {
    const toks = productTokens(p);
    let matched = 0;
    for (const term of terms) {
      const sing = term.replace(/s$/, "");
      const plur = sing + "s";
      if (toks.has(term) || toks.has(sing) || toks.has(plur)) matched++;
    }
    if (matched >= 1) hits.push({ p, matched });
  }
  hits.sort((a, b) => b.matched - a.matched);   // most category terms matched first
  return hits.map(h => h.p.id);
}

// Compact shape sent to the model — keep each item small.
function compact(p) {
  return {
    id: p.id,
    name: p.name,
    price: p.price,
    weight_g: weightOf(p) || undefined,
    tags: (p.tags || p.product_tags || [])
      .map(t => (typeof t === "string" ? t : t.tag))
      .filter(Boolean)
      .slice(0, 6),
    maker: p.maker || p.maker_name || undefined,
    short_desc: (p.short_desc || p.description || "").slice(0, 280) || undefined,
    whats_in_box: Array.isArray(p.whats_in_box)
      ? p.whats_in_box
      : (p.whats_in_box ? [p.whats_in_box] : []),
    tiers: Array.isArray(p.tiers) ? p.tiers : [],
    shortlisted: !!p.shortlisted,
  };
}
