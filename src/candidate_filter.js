// candidate_filter.js  (v3 — corrected)
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
function allowedAboveByTier(items, ceiling, nTiers) {
  const gap = Math.max(Math.round(ceiling * CLUSTER_GAP_FRAC), CLUSTER_GAP_MIN);
  const above = [...new Set(items.filter(p => p.price > ceiling).map(p => p.price))].sort((a, b) => a - b);
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

export function buildCandidates(catalog, filters = {}, max = MAX_CANDIDATES) {
  const ceiling = filters.budget_ceiling || null;
  const premium = !!filters.premium_requested;

  // Hard constraints (mirror the client-owned accumulator).
  let pool = (catalog || []).filter(p => {
    if (filters.exclude_edible  && isEdible(p))  return false;
    if (filters.exclude_fragile && isFragile(p)) return false;
    if (filters.lightweight     && weightOf(p) > LIGHT_MAX_G) return false;
    return true;
  });
  if (pool.length === 0) return [];

  // No budget stated → sort by lean, return the top slice.
  if (!ceiling) {
    return sortByLean(pool, filters.lean).slice(0, max).map(compact);
  }

  const tiers = premium ? TIERS_ABOVE_PREMIUM : TIERS_ABOVE_DEFAULT;
  const allowedAbove = allowedAboveByTier(pool, ceiling, tiers);

  const under = pool
    .filter(p => p.price <= ceiling)
    .sort((a, b) => (ceiling - a.price) - (ceiling - b.price)); // closest to ceiling first
  const over = pool
    .filter(p => p.price > ceiling && allowedAbove.has(p.price))
    .sort((a, b) => a.price - b.price);                          // cheapest-premium first

  let capped;
  if (premium) {
    // Asked to go up — lead with premium, reserve a healthy share of slots.
    const premiumSlots = Math.min(over.length, Math.ceil(max * PREMIUM_LEAD_SHARE));
    capped = [...over.slice(0, premiumSlots), ...under].slice(0, max);
  } else {
    // Lead with under-budget (closest to ceiling), but guarantee several premium
    // pieces survive so a later "more premium" has genuine range.
    const reserved = Math.min(over.length, RESERVED_PREMIUM);
    const underSlots = Math.max(0, max - reserved);
    capped = [...under.slice(0, underSlots), ...over.slice(0, reserved)];
  }

  return capped.map(compact);
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
    short_desc: (p.short_desc || p.description || "").slice(0, 120) || undefined,
  };
}
