import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase.js";

const CATALOGUE_URL = import.meta.env.VITE_CATALOGUE_SERVICE_URL ||
  "https://ikka-catalogue-service-production.up.railway.app";

const BG = "#FFFFFF";
const SURFACE = "#F7F7F5";
const BORDER = "#E8E5DF";
const DOVE_BLUE = "#6B8CAE";
const GREEN = "#2C5F3A";
const DARK = "#111111";
const PANEL_BG = "#1E2B3A";
const BG_COLORS = ["#F5EFE8","#EDF2EE","#EEF0F7","#F7EEF0","#F0EDE8","#EEF5F2","#F5F0E8","#EEF1F7","#F2EEF5"];
const TIER_LABEL = { Gold:"Gold", Silver:"Silver", Platinum:"Platinum" };

const QUICK_STARTS = [
  { label:"Diwali gifts for clients" },
  { label:"Joining kits for new hires" },
  { label:"Premium event gifting" },
];

const TRUST_LOGOS = ["Axis Bank","Bain & Company","Google","Microsoft","J.P.Morgan"];

const INTAKE_SYSTEM = `You are Dove, gifting concierge for Rock Dove by Ikka Dukka — a premium Indian gifting platform.

Extract a gifting brief from what the client says. Be warm, brief, decisive. Replies max 1 sentence.

FIRST: Check if this is a gifting query. If not, reply with a gentle redirect and set is_gifting_query: false.

If it IS a gifting query, extract: recipient, quantity, occasion, deadline, budget, restrictions.

If you have enough info (who + occasion at minimum), set ready: true immediately.
Do not ask follow-up questions unless something critical is completely missing.

Always respond with valid JSON only:
{
  "response": "Brief acknowledgment (1 sentence max)",
  "ready": true or false,
  "is_gifting_query": true or false,
  "filters": {
    "occasion": "diwali|birthday|anniversary|corporate|thank-you|welcome|other",
    "audience": "senior-management|employees-mass|client|colleague|family|other",
    "budget": 3000,
    "qty": 50,
    "deadline": null,
    "exclude_edible": false,
    "exclude_fragile": false,
    "include_tags": [],
    "exclude_tags": [],
    "query": "rich natural language query for product ranking"
  }
}`;

// ─── LIVE PARSING ─────────────────────────────────────────────────────────────
function parseBrief(text) {
  if (!text || text.trim().length < 6) return null;
  const t = text.toLowerCase();
  const chips = [];

  if (/senior|leadership|cxo|ceo|cfo|director|vp|banker|executive|management/.test(t))
    chips.push({ label:"Senior leadership", type:"audience" });
  else if (/employ|staff|team|workforce|junior/.test(t))
    chips.push({ label:"Employees", type:"audience" });
  else if (/client|customer|partner/.test(t))
    chips.push({ label:"Clients", type:"audience" });
  else if (/colleague|peer/.test(t))
    chips.push({ label:"Colleagues", type:"audience" });

  if (/diwali/.test(t)) chips.push({ label:"Diwali", type:"occasion" });
  else if (/new year|new-year/.test(t)) chips.push({ label:"New Year", type:"occasion" });
  else if (/wedding|favour|favor/.test(t)) chips.push({ label:"Wedding favours", type:"occasion" });
  else if (/onboard|joining|welcome|new hire/.test(t)) chips.push({ label:"Onboarding", type:"occasion" });
  else if (/anniver/.test(t)) chips.push({ label:"Anniversary", type:"occasion" });
  else if (/event|conference|offsite/.test(t)) chips.push({ label:"Corporate event", type:"occasion" });
  else if (/birthday/.test(t)) chips.push({ label:"Birthday", type:"occasion" });
  else if (/thank|appreciation/.test(t)) chips.push({ label:"Thank-you", type:"occasion" });

  const qtyMatch = t.match(/\b(\d{1,4})\s*(people|persons?|gifts?|units?|recipients?|staff|employees?|colleagues?|bankers?|heads?|guests?)\b/);
  if (qtyMatch) chips.push({ label:`${qtyMatch[1]} guests`, type:"qty" });

  let budgetAmount = null;
  const budgetPatterns = [
    /(?:₹|rs\.?\s*)\s*(\d[\d,]*)\s*(k)?\b/i,
    /\b(?:under|around|approx|max|upto|up\s+to|within|about)\s+₹?\s*(\d[\d,]*)\s*(k)?\b/i,
    /\b(\d{1,6})\s*(k)?\s*(?:each|per\s+(?:gift|head|person|unit)|budget|\/head|\/gift)\b/i,
    /\bbudget\s+(?:is|of|=)?\s*₹?\s*(\d[\d,]*)\s*(k)?\b/i,
  ];
  for (const pattern of budgetPatterns) {
    const m = t.match(pattern);
    if (m) {
      const raw = (m[1] || "").replace(/,/g, "");
      let amount = parseInt(raw);
      if ((m[2] || "").toLowerCase() === "k") amount *= 1000;
      if (amount >= 200 && amount <= 500000) { budgetAmount = amount; break; }
    }
  }
  if (budgetAmount) chips.push({ label:`₹${budgetAmount.toLocaleString("en-IN")}`, type:"budget" });

  if (/no food|non.?edible|no edible|no consumable|nothing edible|not edible|no eatables?|no snack|no sweet|no mithai/.test(t))
    chips.push({ label:"Non-consumable", type:"constraint" });
  if (/non.?fragile|nothing fragile|no fragile|not fragile|courier.?safe|shippable/.test(t))
    chips.push({ label:"Non-fragile", type:"constraint" });

  return chips.length > 0 ? chips : null;
}

function parseBriefLabels(text) {
  const chips = parseBrief(text);
  return chips ? chips.map(c => c.label) : null;
}

function contextLine(chips) {
  if (!chips) return "Curated for exactly this brief.";
  const isSenior = chips.some(c => /senior|leadership/i.test(c));
  const isDiwali = chips.some(c => /diwali/i.test(c));
  const isWedding = chips.some(c => /wedding/i.test(c));
  const isOnboard = chips.some(c => /onboard/i.test(c));
  const isClient = chips.some(c => /client/i.test(c));
  if (isSenior && isDiwali) return "For senior teams where the gift reflects judgment, not just budget.";
  if (isWedding) return "For guests who remember the gesture, long after the day.";
  if (isSenior) return "For people who notice the difference between considered and generic.";
  if (isDiwali) return "Festive, but never predictable.";
  if (isOnboard) return "A first impression that sets the tone for everything after.";
  if (isClient) return "Gifts that strengthen the relationship, quietly.";
  return "Curated for exactly this brief.";
}

// ─── PRODUCT LINE RULE ENGINE ─────────────────────────────────────────────────
const TRAIT_MAP = {
  "Candles & Incense":      ["Ritual-use", "Ceremonial", "Ambient, non-consumable"],
  "Incense & Ritual":       ["Ceremonial", "Ritual-use", "Ambient, non-consumable"],
  "Marble & Stone":         ["Durable display piece", "Stone-crafted keepsake", "Material-led"],
  "Marble & Brass":         ["Brass and stone", "Material-led statement", "Durable keepsake"],
  "Brass Objects":          ["Ceremonial brass", "Durable, material-led", "Quietly authoritative"],
  "Sculptures & Artefacts": ["Sculptural keepsake", "Made to be retained", "Ceremonial artefact"],
  "Frames & Dcor":          ["Decor-forward piece", "Display keepsake", "Visual recall, long shelf life"],
  "Desk & Office":          ["Desk-appropriate", "Practical, daily-use", "Functional keepsake"],
  "Gift Sets":              ["Complete set", "Ready to gift", "Curated for ease of distribution"],
  "Home Dcor":              ["Home accent", "Decor-forward", "Display piece with lasting presence"],
  "Wellness":               ["Wellness-oriented", "Considered ritual", "Calm, personal touch"],
  "Stationery":             ["Practical keepsake", "Desk-appropriate", "Useful, daily presence"],
  "Books":                  ["Considered choice", "Literary keepsake", "Quietly distinctive"],
  "Lifestyle":              ["Lifestyle-led", "Considered daily-use", "Understated presence"],
};

function pickTrait(tags, category, posIdx) {
  if (TRAIT_MAP[category]) {
    const opts = TRAIT_MAP[category];
    // posIdx drives rotation — adjacent cards in same category get different traits
    return opts[posIdx % opts.length];
  }
  if (tags.some(t => /ritual|ceremony|festive/.test(t))) return "Ceremonial";
  if (tags.some(t => /keepsake|collectible/.test(t))) return "Keepsake value";
  if (tags.some(t => /desk-use|desk-accessory/.test(t))) return "Desk-appropriate";
  if (tags.some(t => /home-decor|display-only/.test(t))) return "Decor-forward piece";
  if (tags.some(t => /wellness/.test(t))) return "Wellness-oriented";
  if (tags.some(t => /artisan|handcraft/.test(t))) return "Artisan-made";
  if (tags.some(t => /premium|luxury/.test(t))) return "High perceived value";
  return "Considered piece";
}

function pickBriefSignal(product, filters, chips, idx) {
  const tags = product._tags || [];
  const qty = filters?.qty || 1;
  const budget = filters?.budget || null;
  const price = product._price || 0;
  const isLarge = qty >= 25;
  const isBulk = tags.some(t => /bulk-friendly|low-moq/.test(t)) || (product.moq && parseInt(product.moq) <= 50);
  const isNonEdible = !product.edible && !tags.some(t => /edible|consumable|food|snack|beverage/.test(t));
  const hasNoFoodConstraint = chips?.some(c => c.type === "constraint" && /consumable|food/i.test(c.label));
  const underBudget = budget && price <= budget * 0.88;
  const signals = [];
  if (hasNoFoodConstraint && isNonEdible) signals.push(...["non-consumable", "keepsake-friendly", "non-consumable keepsake"]);
  if (isLarge && isBulk) signals.push(...["suited for large guest lists","easy to distribute at scale","practical for bulk gifting","distributable at your scale","scales without compromise","ideal for large-order gifting"]);
  else if (isLarge) signals.push(...["suited for larger orders","works well at scale","practical for bulk","no fuss at scale"]);
  if (underBudget) signals.push("well within budget");
  if (signals.length === 0) return null;
  return signals[idx % signals.length];
}

function pickSignal(tags, idx) {
  const signals = ["strong visual recall","made to be retained","lasting presence","high retention value","visually distinctive","endures beyond the occasion","kept long after the day","a gesture that stays","quietly unforgettable","will outlast the event","carries lasting weight","remembered, not discarded"];
  if (!tags.some(t => /keepsake|collectible|heritage|artisan|premium|luxury|handcraft/.test(t))) return null;
  return signals[idx % signals.length];
}

function assembleLine(trait, briefSignal, signal, idx) {
  const parts = [trait, briefSignal, signal].filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0] + ".";
  const templates = [
    () => parts.join(", ") + ".",
    () => `${parts[0]} — ${parts.slice(1).join(", ")}.`,
    () => parts.length === 3 ? `${parts[0]}, ${parts[1]}, ${parts[2]}.` : `${parts[0]}, ${parts[1]}.`,
  ];
  const safeIdx = isNaN(idx) ? 0 : Math.abs(Math.floor(idx));
  return templates[safeIdx % templates.length]();
}

function briefPositioningLine(product, filters, chips, idx = 0) {
  try {
    const tags = product._tags || [];
    const category = product.category || "";
    const idNum = parseInt(product.id, 10) || 0;
    const productIdx = (isNaN(idNum) ? 0 : idNum) + (isNaN(idx) ? 0 : idx);
    const trait = pickTrait(tags, category, productIdx);
    const briefSignal = pickBriefSignal(product, filters, chips, productIdx);
    const signal = pickSignal(tags, productIdx + 1);
    return assembleLine(trait, briefSignal, signal, productIdx);
  } catch(e) { return null; }
}
// ──────────────────────────────────────────────────────────────────────────────

function priceAtQty(tiers, qty) {
  if (!tiers?.length) return 0;
  try {
    const match = tiers.filter(t => qty >= t.min_qty && (t.max_qty===null||qty<=t.max_qty)).sort((a,b)=>b.min_qty-a.min_qty)[0];
    return match ? parseFloat(match.price_per_unit) : parseFloat(tiers[0].price_per_unit);
  } catch { return 0; }
}

function initials(name) { return name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase(); }

function formatBox(val) {
  if (!val) return "";
  if (Array.isArray(val)) return val.filter(Boolean).join(" · ");
  return String(val).replace(/([a-z])([A-Z])/g,"$1 · $2").replace(/\s*,\s*/g," · ").replace(/\s*\|\s*/g," · ");
}

function Logo({ size = "md", onClick }) {
  const sizes = { sm: [13, 16], md: [18, 22], xl: [44, 52] };
  const [rockSz, doveSz] = sizes[size] || sizes.md;
  const el = (
    <div style={{ display:"flex", alignItems:"baseline", gap:4 }}>
      <span style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:rockSz, fontWeight:700, letterSpacing:size==="xl"?10:4, textTransform:"uppercase", color:DARK, lineHeight:1 }}>Rock</span>
      <span style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:doveSz, fontStyle:"italic", color:DOVE_BLUE, fontWeight:400, letterSpacing:1, lineHeight:1 }}>Dove</span>
    </div>
  );
  if (onClick) return <button onClick={onClick} style={{ background:"none", border:"none", cursor:"pointer", padding:0 }}>{el}</button>;
  return el;
}

export default function App() {
  const [session, setSession] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const productsRef = useRef([]);
  const [view, setView] = useState("home");
  const [brief, setBrief] = useState("");
  const [liveChips, setLiveChips] = useState(null);
  const [thinking, setThinking] = useState(false);
  const [thinkingLabel, setThinkingLabel] = useState("Understanding your brief…");
  const [directions, setDirections] = useState([]);
  const [briefSummary, setBriefSummary] = useState("");
  const [lastFilters, setLastFilters] = useState(null);
  const [intakeHistory, setIntakeHistory] = useState([]);
  const [activeDirection, setActiveDirection] = useState(null);
  const [gridProducts, setGridProducts] = useState([]);
  const [sort, setSort] = useState("rec");
  const [hearted, setHearted] = useState(new Set());
  const heartedRef = useRef({});
  const [shortlistOpen, setShortlistOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [refineText, setRefineText] = useState("");
  const [refining, setRefining] = useState(false);
  const [refinedNote, setRefinedNote] = useState("");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token") ||
      window.location.pathname.split("/").pop();
    if (token && token !== "/") loadSession(token);
    else setNotFound(true);
  }, []);

  useEffect(() => {
    const chips = parseBrief(brief);
    setLiveChips(chips ? chips.map(c => c.label) : null);
  }, [brief]);

  const loadSession = async (token) => {
    try {
      const { data, error } = await supabase.from("rd_sessions").select("*").eq("token", token).single();
      if (error || !data) { setNotFound(true); return; }
      setSession(data);
      supabase.from("rd_sessions").update({ last_active: new Date().toISOString() }).eq("id", data.id);
      await Promise.all([loadProducts(), loadShortlist(data.id)]);
    } catch { setNotFound(true); }
  };

  const loadProducts = async () => {
    try {
      let { data, error } = await supabase.from("catalog")
        .select("*, pricing_tiers(*), product_tags(tag, dimension)")
        .eq("active", true).order("popularity", { ascending: false });
      if (error) {
        const res = await supabase.from("catalog").select("*, pricing_tiers(*)").eq("active", true).order("popularity", { ascending: false });
        data = res.data;
      }
      if (data) {
        productsRef.current = data.map((p,i) => ({
          ...p, _bg: BG_COLORS[i%BG_COLORS.length],
          _price: priceAtQty(p.pricing_tiers, 1),
          _tags: (p.product_tags||[]).map(t=>(t.tag||"").toLowerCase()).filter(Boolean),
        }));
      }
    } catch(e) { console.error(e); }
  };

  const loadShortlist = async (sessionId) => {
    try {
      const { data } = await supabase.from("rd_shortlists").select("product_id").eq("session_id", sessionId);
      if (data?.length > 0) {
        const ids = new Set(data.map(r => r.product_id));
        setHearted(ids);
        setTimeout(() => {
          ids.forEach(id => {
            const p = productsRef.current.find(x => x.id === id);
            if (p) heartedRef.current[id] = p;
          });
        }, 1200);
      }
    } catch {}
  };

  const saveConvo = useCallback(async (role, message) => {
    if (!session) return;
    try { await supabase.from("rd_conversations").insert([{ session_id: session.id, role, message }]); } catch {}
  }, [session]);

  const logEvent = useCallback(async (type, pid=null, meta={}) => {
    if (!session) return;
    try { await supabase.from("rd_events").insert([{ session_id: session.id, event_type: type, product_id: pid, metadata: meta }]); } catch {}
  }, [session]);

  const handleSearch = async (searchBrief) => {
    const q = (searchBrief || brief).trim();
    if (!q || thinking) return;
    setBrief(q);
    setThinking(true);
    setRefinedNote("");
    setView("thinking");
    saveConvo("user", q);
    const allProducts = productsRef.current;
    try {
      setThinkingLabel("Understanding your brief…");
      const doveRes = await fetch(CATALOGUE_URL + "/dove-chat", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ message:q, conversation_history:intakeHistory, system_override:INTAKE_SYSTEM }),
      });
      const doveData = await doveRes.json();
      const newHistory = [...intakeHistory, { role:"user", content:q }, { role:"assistant", content:doveData.response }];
      setIntakeHistory(newHistory);
      if (!doveData.is_gifting_query) { setView("home"); setThinking(false); return; }
      const filters = doveData.filters || {};
      if (doveData.filters) setLastFilters(doveData.filters);
      const qty = filters.qty || 1;
      const budget = filters.budget || null;

      setThinkingLabel("Scanning 160+ curated gifts…");
      const candidates = allProducts.filter(p => {
        const price = priceAtQty(p.pricing_tiers, qty);
        if (budget && price > budget * 1.2) return false;
        if (filters.exclude_edible && p.edible) return false;
        if (filters.exclude_fragile && p.fragile) return false;
        return true;
      }).map(p => ({
        id:p.id, name:p.name||"", category:p.category||"",
        description:(p.description||"").slice(0,130),
        whats_in_box: Array.isArray(p.whats_in_box) ? p.whats_in_box.join(", ").slice(0,80) : (p.whats_in_box||"").slice(0,80),
        price: priceAtQty(p.pricing_tiers, qty),
        tier:p.tier||"", tags:(p._tags||[]).join(", "),
      }));

      setThinkingLabel("Curating your shortlist…");
      const rankRes = await fetch(CATALOGUE_URL + "/dove-rank", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ brief:filters.query||q, budget, exclude_edible:filters.exclude_edible||false, exclude_fragile:filters.exclude_fragile||false, products:candidates }),
      });
      const ranked = await rankRes.json();
      const idOrder = ranked.ranked_ids || [];

      setThinkingLabel("Creating editorial directions…");
      const topCandidates = idOrder.map(id => candidates.find(c=>c.id===id)).filter(Boolean);
      const dirRes = await fetch(CATALOGUE_URL + "/dove-directions", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ brief:filters.query||q, budget, products:topCandidates }),
      });
      const dirData = await dirRes.json();

      const productMap = {};
      allProducts.forEach(p => { productMap[p.id] = { ...p, _price:priceAtQty(p.pricing_tiers, qty) }; });

      const enrichedDirections = (dirData.directions||[]).map(d => {
        const prods = (d.product_ids||[]).map(id => productMap[id]).filter(Boolean);
        const prices = prods.map(p => p._price||0).filter(v => v > 0);
        return { ...d, products:prods, price_min:prices.length?Math.min(...prices):(d.price_min||0), price_max:prices.length?Math.max(...prices):(d.price_max||0) };
      });

      setBriefSummary(ranked.summary || "");
      setDirections(enrichedDirections);
      saveConvo("assistant", ranked.summary||"");
      setView("directions");
    } catch(e) { console.error(e); setView("home"); }
    setThinking(false);
  };

  const handleRefine = async () => {
    const text = refineText.trim();
    if (!text || refining) return;
    setRefineText("");
    setRefining(true);
    const combined = brief + ". " + text;
    setBrief(combined);
    await handleSearch(combined);
    setRefining(false);
  };

  const exploreDirection = (direction) => {
    setActiveDirection(direction);
    setGridProducts(direction.products || []);
    setSort("rec");
    setView("grid");
    logEvent("direction_explore", null, { direction_name: direction.name });
  };

  const toggleHeart = async (p) => {
    if (!session || !p?.id) return;
    const isHearted = hearted.has(p.id);
    const newHearted = new Set(hearted);
    if (isHearted) {
      newHearted.delete(p.id);
      delete heartedRef.current[p.id];
      supabase.from("rd_shortlists").delete().eq("session_id", session.id).eq("product_id", p.id);
      logEvent("shortlist_remove", p.id);
    } else {
      newHearted.add(p.id);
      heartedRef.current[p.id] = p;
      supabase.from("rd_shortlists").insert([{ session_id:session.id, product_id:p.id }]);
      logEvent("shortlist_add", p.id);
      setShortlistOpen(true);
    }
    setHearted(newHearted);
  };

  const submitShortlist = async () => {
    if (!session || hearted.size===0) return;
    setSubmitting(true);
    logEvent("shortlist_submit", null, { product_ids:[...hearted], count:hearted.size });
    setTimeout(() => { setView("submitted"); setSubmitting(false); }, 800);
  };

  const shortlistItems = [...hearted].map(id => heartedRef.current[id]).filter(Boolean);
  const totalEstimate = shortlistItems.reduce((s,p)=>s+(p._price||0),0);
  const sortedGrid = [...gridProducts].sort((a,b)=>{
    if (sort==="asc") return (a._price||0)-(b._price||0);
    if (sort==="desc") return (b._price||0)-(a._price||0);
    return 0;
  });

  const S = styles;

  if (notFound) return <div style={S.fullCenter}><Logo size="xl"/><p style={S.muted}>This link is invalid or has expired.</p></div>;
  if (!session) return <div style={S.fullCenter}><Logo size="xl"/><p style={S.muted}>Loading…</p></div>;

  if (view === "submitted") return (
    <div style={S.fullCenter}>
      <div style={{ width:52, height:52, borderRadius:"50%", background:GREEN, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, marginBottom:24 }}>✓</div>
      <p style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:26, fontWeight:400, color:DARK, margin:"0 0 10px" }}>Shortlist sent</p>
      <p style={{ fontFamily:"Georgia,serif", fontSize:15, fontWeight:300, color:"#888", maxWidth:360, lineHeight:1.8, margin:"0 0 28px", textAlign:"center" }}>
        Thank you, {session.client_name.split(" ")[0]}. We'll follow up within 24 hours.
      </p>
      {shortlistItems.map(p=>(
        <div key={p.id} style={{ display:"flex", alignItems:"center", gap:14, padding:"12px 0", borderBottom:`1px solid ${BORDER}`, width:"100%", maxWidth:380 }}>
          <div style={{ width:44, height:54, background:p._bg||SURFACE, flexShrink:0, overflow:"hidden" }}>
            {p.image_url && <img src={p.image_url} alt={p.name} style={{ width:"100%", height:"100%", objectFit:"cover" }}/>}
          </div>
          <div>
            <p style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:15, fontWeight:400, color:DARK, margin:"0 0 3px" }}>{p.name}</p>
            <p style={{ fontSize:13, color:"#aaa", margin:0 }}>₹{(p._price||0).toLocaleString("en-IN")}</p>
          </div>
        </div>
      ))}
    </div>
  );

  // ── Inline JSX variables (not components — avoids focus loss on re-render) ──
  const topBarJSX = (
    <div style={S.topBar}>
      <Logo size="sm" onClick={() => setView("home")}/>
      <div style={S.refineWrap}>
        <input
          style={S.refineInput}
          value={refineText}
          onChange={e => setRefineText(e.target.value)}
          onKeyDown={e => e.key==="Enter" && handleRefine()}
          placeholder="Refine in one line — e.g. more premium, nothing fragile…"
          disabled={refining || thinking}
        />
        <button style={{ ...S.refineBtn, ...(!refineText.trim()||refining?{opacity:0.4,cursor:"not-allowed"}:{}) }}
          onClick={handleRefine} disabled={!refineText.trim()||refining}>
          {refining ? "…" : "Refine →"}
        </button>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
        {hearted.size > 0 && (
          <button style={S.shortlistBtn} onClick={() => setShortlistOpen(!shortlistOpen)}>
            ♥ {hearted.size} saved
          </button>
        )}
        <div style={S.av}>{initials(session.client_name)}</div>
      </div>
    </div>
  );

  const shortlistDrawerJSX = shortlistOpen ? (
    <div style={S.drawer}>
      <div style={S.drawerHdr}>
        <p style={S.drawerTitle}>Shortlist</p>
        <button style={{ background:"none", border:"none", fontSize:20, color:"#aaa", cursor:"pointer" }} onClick={()=>setShortlistOpen(false)}>×</button>
      </div>
      <div style={{ flex:1, overflowY:"auto" }}>
        {shortlistItems.length===0 ? (
          <p style={{ padding:"28px 20px", fontFamily:"Georgia,serif", fontSize:14, fontStyle:"italic", fontWeight:300, color:"#bbb", textAlign:"center", lineHeight:1.8, margin:0 }}>Heart a gift to save it here</p>
        ) : shortlistItems.map(p=>(
          <div key={p.id} style={S.slRow}>
            <div style={{ width:40, height:48, background:p._bg||SURFACE, flexShrink:0, overflow:"hidden", cursor:"pointer" }} onClick={()=>setSelectedProduct({...p})}>
              {p.image_url && <img src={p.image_url} alt={p.name||""} style={{ width:"100%", height:"100%", objectFit:"cover" }} onError={e=>{e.target.style.display="none"}}/>}
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <p style={{ fontSize:12, fontWeight:500, color:DARK, margin:"0 0 2px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.name}</p>
              <p style={{ fontSize:11, color:"#aaa", margin:0 }}>₹{(p._price||0).toLocaleString("en-IN")}</p>
            </div>
            <button style={{ background:"none", border:"none", color:"#ccc", cursor:"pointer", fontSize:17, padding:0, flexShrink:0 }} onClick={()=>toggleHeart(p)}>×</button>
          </div>
        ))}
      </div>
      <div style={S.drawerFtr}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:14, paddingBottom:14, borderBottom:"1px solid #f0ece4" }}>
          <span style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#aaa" }}>Total</span>
          <span style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:20, fontWeight:400, color:DARK }}>
            {hearted.size===0?"—":`₹${totalEstimate.toLocaleString("en-IN")}`}
          </span>
        </div>
        <button style={{ ...S.btnGreen, ...(hearted.size===0?{opacity:0.4,cursor:"not-allowed",boxShadow:"none"}:{}) }}
          onClick={submitShortlist} disabled={hearted.size===0||submitting}>
          {submitting?"Sending…":"Send to Rock Dove →"}
        </button>
        <p style={{ fontSize:10, color:"#bbb", textAlign:"center", marginTop:10 }}>We follow up within 24 hours</p>
      </div>
    </div>
  ) : null;

  const REFINE_CHIPS = [
    { label:"Elevate",          group:"refine",     query:" more premium, ultra-luxury only",          note:"Shifted toward elevated, artisanal selections." },
    { label:"More distinctive", group:"refine",     query:" unique, rare, unexpected category",        note:"Shifted toward more distinctive, memorable pieces." },
    { label:"Different angle",  group:"refine",     query:" completely different style and category",  note:"Taking a different angle entirely." },
    { label:"No food",          group:"constraint", query:" nothing edible or consumable",             note:"Shifted toward non-edible options only." },
    { label:"More functional",  group:"constraint", query:" desk-friendly, practical, everyday use",   note:"Shifted toward purposeful, functional gifting." },
    { label:"More artisan",     group:"constraint", query:" handcrafted, artisan-made, Indian craft",  note:"Shifted toward handcrafted, artisan-led selections." },
  ];

  return (
    <div style={{ ...S.app, background:BG }}>

      {/* ── HOME ── */}
      {view === "home" && (
        <div style={S.homePage}>
          <div style={S.homeNav}>
            <div style={{ fontSize:10, letterSpacing:"3px", textTransform:"uppercase", color:DOVE_BLUE, fontWeight:600 }}>✦ AI-FIRST</div>
            <Logo size="md"/>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <div style={S.av}>{initials(session.client_name)}</div>
              <div>
                <p style={{ fontSize:12, fontWeight:700, letterSpacing:1, textTransform:"uppercase", fontFamily:"'Playfair Display',Georgia,serif", color:DARK, margin:0 }}>{session.client_name}</p>
                {session.client_company && <p style={{ fontSize:11, color:"#aaa", margin:0 }}>{session.client_company}</p>}
              </div>
            </div>
          </div>

          <div style={S.hero}>
            <div style={S.heroLeft}>
              <p style={S.homeTaglineLeft}>Gift Intelligence by Ikka Dukka</p>
              <h1 style={S.heroH1}>Tell me what you need.<br/><em style={{ color:DOVE_BLUE }}>I'll take it from there.</em></h1>
              <p style={S.heroSub}>Describe your brief in one line. Include occasion, recipients, quantity and budget.</p>

              <div style={S.briefGuideRow}>
                {[
                  { label:"Occasion", eg:"Diwali · onboarding · wedding" },
                  { label:"Recipients", eg:"Senior clients · new hires" },
                  { label:"Quantity", eg:"50 people · 200 gifts" },
                  { label:"Budget", eg:"₹3,000 each · under ₹5k" },
                ].map((g,i) => (
                  <div key={i} style={S.briefGuideItem}>
                    <p style={S.briefGuideLabel}>{g.label}</p>
                    <p style={S.briefGuideEg}>{g.eg}</p>
                  </div>
                ))}
              </div>

              <div style={S.inputBox}>
                <textarea
                  style={S.homeInput}
                  value={brief}
                  onChange={e => setBrief(e.target.value)}
                  onKeyDown={e => { if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); handleSearch(); }}}
                  placeholder="e.g. 50 senior bankers, Diwali, ₹3,000 each, nothing edible"
                  rows={2}
                  autoFocus
                />
                <button
                  style={{ ...S.homeBtn, ...(!brief.trim()||thinking?{opacity:0.35,cursor:"not-allowed"}:{}) }}
                  onClick={() => handleSearch()}
                  disabled={!brief.trim()||thinking}
                >
                  {thinking ? "…" : "→"}
                </button>
              </div>

              <div style={S.liveParseRow}>
                {(() => {
                  const parsed = parseBrief(brief);
                  if (!parsed || parsed.length === 0)
                    return <span style={S.liveParseHint}>Results appear in seconds · No form, no steps</span>;
                  return (
                    <>
                      <span style={S.liveParseLabel}>Understood:</span>
                      {parsed.map((c,i) => (
                        <span key={i} style={{ ...S.liveParsedChip, ...(c.type==="budget"?S.liveParsedChipBudget:{}), ...(c.type==="constraint"?S.liveParsedChipConstraint:{}) }}>{c.label}</span>
                      ))}
                    </>
                  );
                })()}
              </div>

              <div style={S.quickStarts}>
                <p style={S.quickStartLabel}>Or try one of these</p>
                <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                  {QUICK_STARTS.map((q,i)=>(
                    <button key={i} style={S.quickChip} onClick={() => handleSearch(q.label)}>{q.label} →</button>
                  ))}
                </div>
              </div>
            </div>

            <div style={S.heroRight}>
              <div style={S.heroDarkPanel}>
                <p style={S.heroPanelEyebrow}>Ikka Dukka</p>
                <p style={S.heroPanelHed}>Gifts that say<br/>the right things.</p>
                <div style={S.heroPanelDivider}></div>
                <div style={S.heroPanelPills}>
                  {[
                    { label:"Curated by AI", sub:"160+ handpicked gifts" },
                    { label:"Refined by experts", sub:"Every direction reviewed" },
                    { label:"Chosen with purpose", sub:"Matched to your brief" },
                  ].map((t,i)=>(
                    <div key={i} style={S.heroPanelPillRow}>
                      <span style={{ fontSize:8, color:DOVE_BLUE, marginTop:3 }}>✦</span>
                      <div>
                        <p style={S.heroPanelPillLabel}>{t.label}</p>
                        <p style={S.heroPanelPillSub}>{t.sub}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div style={S.heroPanelStats}>
                  <div><p style={S.statNum}>160+</p><p style={S.statLabel}>curated gifts</p></div>
                  <div style={{ width:1, background:"rgba(255,255,255,0.1)", alignSelf:"stretch" }}></div>
                  <div><p style={S.statNum}>24hrs</p><p style={S.statLabel}>turnaround</p></div>
                  <div style={{ width:1, background:"rgba(255,255,255,0.1)", alignSelf:"stretch" }}></div>
                  <div><p style={S.statNum}>100%</p><p style={S.statLabel}>Indian makers</p></div>
                </div>
              </div>
            </div>
          </div>

          <div style={S.trustBar}>
            <span style={S.trustLabel}>Trusted by teams at</span>
            {TRUST_LOGOS.map((l,i)=><span key={i} style={S.trustLogo}>{l}</span>)}
          </div>
        </div>
      )}

      {/* ── THINKING ── */}
      {view === "thinking" && (
        <div style={S.fullCenter}>
          <Logo size="xl"/>
          <p style={{ fontFamily:"Georgia,serif", fontSize:19, fontStyle:"italic", fontWeight:300, color:"#888", marginTop:48, lineHeight:1.8 }}>{thinkingLabel}</p>
          <div style={{ display:"flex", gap:6, marginTop:20 }}>
            <span className="td"></span>
            <span className="td" style={{ animationDelay:"0.2s" }}></span>
            <span className="td" style={{ animationDelay:"0.4s" }}></span>
          </div>
          <p style={{ fontFamily:"Georgia,serif", fontSize:14, fontStyle:"italic", fontWeight:300, color:"#ccc", marginTop:16 }}>
            "{brief.length > 60 ? brief.slice(0,60)+"…" : brief}"
          </p>
        </div>
      )}

      {/* ── DIRECTIONS ── */}
      {view === "directions" && (
        <div style={{ ...S.resultsPage, background:BG }}>
          {topBarJSX}
          <div style={{ flex:1, overflowY:"auto" }}>
            <div style={S.directionsWrap}>
              <div style={S.directionsHdr}>
                <p style={S.directionsEyebrow}>YOUR BRIEF, UNDERSTOOD</p>
                {(() => {
                  const chips = parseBrief(brief);
                  if (!chips?.length) return null;
                  return (
                    <div style={S.briefChipsRow}>
                      {chips.map((c,i) => (
                        <span key={i} style={{ ...S.briefChip, ...(c.type==="budget"?S.briefChipBudget:{}), ...(c.type==="constraint"?S.briefChipConstraint:{}) }}>{c.label}</span>
                      ))}
                    </div>
                  );
                })()}
                <h2 style={S.directionsH2}>Three directions. <em style={{ color:DOVE_BLUE }}>All viable.</em></h2>
                {briefSummary && (
                  <p style={S.directionsIntel}><span style={{ fontWeight:600, color:DOVE_BLUE }}>Dove:</span> {briefSummary}</p>
                )}
                {brief && (
                  <p style={S.directionsContext}>{contextLine(liveChips || parseBriefLabels(brief))}</p>
                )}
                <p style={S.confidenceCue}>All three fit your brief — choose based on tone.</p>
                <div style={S.refineChipsRow}>
                  <span style={S.refineChipsLabel}>Refine:</span>
                  {REFINE_CHIPS.filter(c => c.group==="refine").map((c,i) => (
                    <button key={i} style={S.refineChipBtn}
                      onClick={() => {
                        // For "Different angle", inject current direction names so Claude actively avoids them
                        let query = c.query;
                        if (c.label === "Different angle" && directions.length > 0) {
                          const dirNames = directions.map(d => d.name).join(", ");
                          query = ` completely different product categories and aesthetic — avoid anything similar to: ${dirNames}`;
                        }
                        const r = brief + query;
                        setBrief(r); setRefinedNote(c.note); handleSearch(r);
                      }}>{c.label}</button>
                  ))}
                  <span style={{ ...S.refineChipsLabel, marginLeft:8 }}>Constraints:</span>
                  {REFINE_CHIPS.filter(c => c.group==="constraint").map((c,i) => (
                    <button key={i} style={S.refineChipBtnMuted}
                      onClick={() => { const r=brief+c.query; setBrief(r); setRefinedNote(c.note); handleSearch(r); }}>{c.label}</button>
                  ))}
                </div>
                {refinedNote && (
                  <p style={S.refinedNote}><span style={{ color:DOVE_BLUE, marginRight:6 }}>✦</span>{refinedNote}</p>
                )}
              </div>

              <div style={S.directionCards}>
                {directions.map((d,i) => {
                  const cats = [...new Set((d.products||[]).map(p=>p.category).filter(Boolean))].slice(0,2);
                  const hasCraft = (d.products||[]).some(p=>(p._tags||[]).some(t=>t.includes("handcraft")||t.includes("artisan")));
                  const hasIndia = (d.products||[]).some(p=>(p._tags||[]).some(t=>t.includes("made-in-india")));
                  const microTags = [...cats, hasCraft?"Handmade":null, hasIndia?"India":null].filter(Boolean).slice(0,4);
                  return (
                    <div key={i} style={S.dirCard}>
                      <div style={S.dirCardImg}>
                        {(d.products||[]).slice(0,2).map((p,j) => (
                          <div key={j} style={{ ...S.dirCardThumb, background:p._bg||SURFACE }}>
                            {p.image_url && <img src={p.image_url} alt={p.name||""} style={{ width:"100%", height:"100%", objectFit:"cover" }} onError={e=>{e.target.style.display="none"}}/>}
                          </div>
                        ))}
                      </div>
                      <div style={S.dirCardBody}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                          <p style={{ ...S.dirCardNum, margin:0 }}>Direction {d.number}</p>
                          {i===0&&<span style={{ ...S.dirBadge, ...S.dirBadgePrimary }}>Most chosen</span>}
                          {i===1&&<span style={{ ...S.dirBadge, ...S.dirBadgeSecondary }}>Well balanced</span>}
                          {i===2&&<span style={{ ...S.dirBadge, ...S.dirBadgeTertiary }}>Statement choice</span>}
                        </div>
                        <p style={S.dirCardName}>{d.name}</p>
                        <p style={S.dirCardTagline}>{d.tagline}</p>
                        <p style={S.dirCardDesc}>{d.description}</p>
                        {microTags.length>0 && <p style={S.dirCardMicroTags}>{microTags.join(" · ")}</p>}
                        <p style={S.dirCardPrice}>
                          {(d.price_min||0)===(d.price_max||0)
                            ? `₹${(d.price_min||0).toLocaleString("en-IN")}`
                            : `₹${(d.price_min||0).toLocaleString("en-IN")} – ₹${(d.price_max||0).toLocaleString("en-IN")}`}
                        </p>
                        <p style={S.dirCardCount}>{(d.products||[]).length} gifts in this edit</p>
                      </div>
                      <button style={S.exploreBtn} onClick={() => exploreDirection(d)}>Explore this direction →</button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── GRID ── */}
      {view === "grid" && (
        <div style={{ ...S.resultsPage, background:BG }}>
          {topBarJSX}
          <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
            <div style={{ flex:1, overflowY:"auto" }}>
              <div style={S.gridWrap}>
                <div style={{ marginBottom:20 }}>
                  <button style={S.backLink} onClick={() => setView("directions")}>← Back to recommendations</button>
                </div>

                {activeDirection && (
                  <div style={S.dirBanner}>
                    <div style={{ flex:1 }}>
                      <p style={S.dirBannerName}>{activeDirection.name}</p>
                      <p style={S.dirBannerTagline}>{activeDirection.tagline}</p>
                      {(() => {
                        const parsed = parseBrief(brief) || [];
                        const hasBudget = parsed.some(c=>c.type==="budget");
                        if (!hasBudget && lastFilters?.budget) parsed.push({ label:`₹${lastFilters.budget.toLocaleString("en-IN")}`, type:"budget" });
                        const hasConstraint = parsed.some(c=>c.type==="constraint");
                        if (!hasConstraint && lastFilters?.exclude_edible) parsed.push({ label:"Non-consumable", type:"constraint" });
                        if (!hasConstraint && lastFilters?.exclude_fragile) parsed.push({ label:"Non-fragile", type:"constraint" });
                        if (!parsed.length) return null;
                        return (
                          <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:8, flexWrap:"wrap" }}>
                            <span style={{ fontSize:11, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:"#777", fontFamily:"'Josefin Sans',sans-serif" }}>Selected for:</span>
                            {parsed.map((c,i) => (
                              <span key={i} style={{ fontSize:11, color:"#555", background:"transparent", border:`1px solid ${BORDER}`, padding:"2px 10px", fontWeight:400,
                                ...(c.type==="budget"?{ color:DOVE_BLUE, background:"rgba(107,140,174,0.07)", border:`1px solid rgba(107,140,174,0.35)`, fontWeight:600 }:{}),
                                ...(c.type==="constraint"?{ color:"#7A4A2A", background:"rgba(122,74,42,0.06)", border:`1px solid rgba(122,74,42,0.2)` }:{}),
                              }}>{c.label}</span>
                            ))}
                          </div>
                        );
                      })()}
                      {briefSummary && (
                        <p style={{ fontFamily:"Georgia,serif", fontSize:13, fontWeight:300, color:"#666", margin:"8px 0 0", lineHeight:1.6 }}>
                          <span style={{ fontWeight:600, color:DOVE_BLUE }}>Dove:</span> {briefSummary}
                        </p>
                      )}
                      {activeDirection.description && (
                        <p style={{ fontFamily:"Georgia,serif", fontSize:18, fontWeight:400, fontStyle:"normal", color:"#111", margin:"14px 0 0", lineHeight:1.6, borderLeft:`3px solid ${DOVE_BLUE}`, paddingLeft:16 }}>
                          {activeDirection.description}
                        </p>
                      )}
                    </div>
                    <div style={{ display:"flex", gap:4, flexShrink:0, alignSelf:"flex-start" }}>
                      {[["rec","Best fit"],["asc","Price ↑"],["desc","Price ↓"]].map(([v,l])=>(
                        <button key={v} style={{ ...S.sortBtn, ...(sort===v?S.sortOn:{}) }} onClick={()=>setSort(v)}>{l}</button>
                      ))}
                    </div>
                  </div>
                )}

                <p style={{ fontSize:12, color:"#888", letterSpacing:"1px", textTransform:"uppercase", marginBottom:16, fontFamily:"'Josefin Sans',sans-serif" }}>
                  {sortedGrid.length} gifts in this direction
                </p>

                {/* TOP 4 — from top 8 ranked, sorted by budget proximity */}
                {sort==="rec" && sortedGrid.length>=2 && (
                  <div style={S.topPicksRow}>
                    <p style={S.topPicksLabel}>Best fit for your brief</p>
                    <div style={S.topPicksGrid}>
                      {(() => {
                        const budget = lastFilters?.budget || null;
                        let pool = sortedGrid.slice(0, 8);
                        if (budget) {
                          // Sort pool by price proximity to budget ceiling (closest = best)
                          pool = [...pool].sort((a, b) => {
                            const aDist = Math.abs(budget - (a._price || 0));
                            const bDist = Math.abs(budget - (b._price || 0));
                            return aDist - bDist;
                          });
                        }
                        return pool.slice(0, 4).map((p, i) => {
                          const posLine = briefPositioningLine(p, lastFilters, parseBrief(brief), i);
                          return (
                            <div key={p.id} style={S.topCard} onClick={()=>{ setSelectedProduct({...p}); logEvent("product_view",p.id); }}>
                              <div style={{ ...S.topCardImg, background:p._bg||SURFACE }}>
                                {p.image_url && <img src={p.image_url} alt={p.name||""} style={{ position:"absolute", inset:0, width:"100%", height:"100%", objectFit:"contain", padding:8 }} onError={e=>{e.target.style.display="none"}}/>}
                                <button style={{ ...S.heartBtn, color:hearted.has(p.id)?"#9B3A2A":"#bbb" }}
                                  onClick={e=>{ e.stopPropagation(); toggleHeart(p); }}>{hearted.has(p.id)?"♥":"♡"}</button>
                              </div>
                              <div style={S.topCardBody}>
                                <span style={{ ...S.tierBadge, ...(p.tier==="Gold"?S.tierGold:p.tier==="Platinum"?S.tierPlat:S.tierSilv), marginBottom:4 }}>{TIER_LABEL[p.tier]||p.tier}</span>
                                <p style={S.topCardName}>{p.name||""}</p>
                                {posLine && <p style={S.topCardPos}>{posLine}</p>}
                                <p style={S.topCardPrice}>₹{(p._price||0).toLocaleString("en-IN")}</p>
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>
                )}

                {/* REMAINING */}
                {sort==="rec" && sortedGrid.length>4 && (
                  <p style={{ fontSize:11, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#aaa", margin:"4px 0 14px", fontFamily:"'Josefin Sans',sans-serif" }}>
                    More options aligned to your brief
                  </p>
                )}
                <div style={S.grid}>
                  {(sort==="rec" ? sortedGrid.slice(4) : sortedGrid).map((p,i) => {
                    const posLine = briefPositioningLine(p, lastFilters, parseBrief(brief), i+4);
                    return (
                      <div key={p.id} style={S.card}>
                        <div style={{ ...S.cardImg, background:p._bg||SURFACE }}
                          onClick={()=>{ setSelectedProduct({...p}); logEvent("product_view",p.id); }}>
                          {p.image_url ? (
                            <img src={p.image_url} alt={p.name||""} style={{ position:"absolute", inset:0, width:"100%", height:"100%", objectFit:"cover" }} onError={e=>{e.target.style.display="none"}}/>
                          ) : (
                            <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                              <span style={{ fontSize:10, letterSpacing:"2px", color:"#bbb", textTransform:"uppercase" }}>{p.category}</span>
                            </div>
                          )}
                          <button style={{ ...S.heartBtn, color:hearted.has(p.id)?"#9B3A2A":"#bbb" }}
                            onClick={e=>{ e.stopPropagation(); toggleHeart(p); }}>{hearted.has(p.id)?"♥":"♡"}</button>
                        </div>
                        <div style={S.cardBody} onClick={()=>{ setSelectedProduct({...p}); logEvent("product_view",p.id); }}>
                          <span style={{ ...S.tierBadge, ...(p.tier==="Gold"?S.tierGold:p.tier==="Platinum"?S.tierPlat:S.tierSilv) }}>{TIER_LABEL[p.tier]||p.tier}</span>
                          <p style={S.cardName}>{p.name||""}</p>
                          {posLine && <p style={S.cardPos}>{posLine}</p>}
                          <p style={S.cardPrice}>₹{(p._price||0).toLocaleString("en-IN")}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            {shortlistDrawerJSX}
          </div>
        </div>
      )}

      {/* ── MODAL ── */}
      {selectedProduct?.id && (() => {
        const p = selectedProduct;
        const price = p._price || 0;
        const boxContents = formatBox(p.whats_in_box);
        const isHearted = hearted.has(p.id);
        const briefChips = parseBrief(brief);
        const budget = lastFilters?.budget || null;
        const tags = p._tags || [];
        const isNonEdible = !p.edible && !tags.some(t => /edible|consumable|food|snack|beverage/.test(t));
        const cues = [];
        if (budget && price <= budget) cues.push("Fits budget");
        if (isNonEdible) cues.push("Non-consumable");
        if (p.moq && parseInt(p.moq) <= 50) cues.push("Bulk-friendly");
        if (tags.some(t => /handcraft|artisan|hand-finish|handmade/.test(t))) cues.push("Handcrafted");
        if (tags.some(t => /made-in-india/.test(t))) cues.push("Made in India");
        const doveFitLine = (() => {
          const parts = [];
          if (budget && price <= budget) parts.push("within budget");
          if (isNonEdible && briefChips?.some(c=>c.type==="constraint")) parts.push("meets your non-consumable requirement");
          if (tags.some(t => /keepsake|collectible|heritage/.test(t))) parts.push("strong keepsake value");
          if (p.moq && parseInt(p.moq) <= 50) parts.push("distributable at your scale");
          if (tags.some(t => /artisan|handcraft/.test(t))) parts.push("artisan provenance");
          if (parts.length===0) return null;
          return "A strong fit for this brief — " + parts.join(", ") + ".";
        })();
        const alsoConsidered = gridProducts.filter(op=>op.id!==p.id).slice(0,4);
        return (
          <div style={S.modalOverlay} onClick={()=>setSelectedProduct(null)}>
            <div style={S.modalBox} onClick={e=>e.stopPropagation()}>
              <button style={S.modalClose} onClick={()=>setSelectedProduct(null)}>×</button>
              <div style={S.modalInner}>
                <div style={S.modalImgWrap}>
                  {p.image_url ? (
                    <img src={p.image_url} alt={p.name||""} style={{ width:"100%", height:"100%", objectFit:"contain", display:"block", background:p._bg||SURFACE }} onError={e=>{e.target.style.display="none"}}/>
                  ) : (
                    <div style={{ width:"100%", height:"100%", background:p._bg||SURFACE, display:"flex", alignItems:"center", justifyContent:"center" }}>
                      <span style={{ fontSize:10, letterSpacing:"2px", color:"#bbb", textTransform:"uppercase" }}>{p.category||""}</span>
                    </div>
                  )}
                </div>
                <div style={S.modalContent}>
                  {doveFitLine && (
                    <div style={S.modalDoveLine}>
                      <span style={{ fontWeight:600, color:DOVE_BLUE, marginRight:6 }}>Dove:</span>
                      <span style={{ fontFamily:"Georgia,serif", fontSize:13, fontWeight:300, color:"#555", lineHeight:1.6 }}>{doveFitLine}</span>
                    </div>
                  )}
                  {briefChips?.length > 0 && (
                    <div style={S.modalBriefRow}>
                      <span style={{ fontSize:9, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", flexShrink:0 }}>For:</span>
                      {briefChips.map((c,i) => (
                        <span key={i} style={{ fontSize:11, color:"#666", background:SURFACE, border:`1px solid ${BORDER}`, padding:"2px 8px",
                          ...(c.type==="budget"?{ color:DOVE_BLUE, background:"transparent", border:`1px solid rgba(107,140,174,0.35)`, fontWeight:600 }:{}),
                          ...(c.type==="constraint"?{ color:"#7A4A2A", background:"rgba(122,74,42,0.06)", border:`1px solid rgba(122,74,42,0.2)` }:{}),
                        }}>{c.label}</span>
                      ))}
                    </div>
                  )}
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", margin:"14px 0 4px" }}>
                    <span style={{ ...S.tierBadge, ...(p.tier==="Gold"?S.tierGold:p.tier==="Platinum"?S.tierPlat:S.tierSilv) }}>{TIER_LABEL[p.tier]||p.tier||""}</span>
                    <button style={{ background:"none", border:"none", fontSize:24, color:isHearted?"#9B3A2A":"#ccc", cursor:"pointer", lineHeight:1 }}
                      onClick={()=>toggleHeart(p)}>{isHearted?"♥":"♡"}</button>
                  </div>
                  <p style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:24, fontWeight:400, color:DARK, lineHeight:1.25, margin:"0 0 3px" }}>{p.name||""}</p>
                  <p style={{ fontSize:10, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 12px" }}>{p.category||""}</p>
                  <p style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:26, fontWeight:400, color:DARK, margin:"0 0 14px" }}>₹{price.toLocaleString("en-IN")}</p>
                  {cues.length>0 && (
                    <div style={S.modalCues}>{cues.slice(0,4).map((c,i)=><span key={i} style={S.modalCue}>✓ {c}</span>)}</div>
                  )}
                  {p.description && <p style={{ fontFamily:"Georgia,serif", fontSize:14, fontWeight:300, color:"#555", lineHeight:1.8, margin:"14px 0" }}>{String(p.description)}</p>}
                  {boxContents && (
                    <div style={{ marginBottom:14, paddingBottom:14, borderBottom:`1px solid ${BORDER}` }}>
                      <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 6px" }}>What's in the box</p>
                      <p style={{ fontFamily:"Georgia,serif", fontSize:13, fontWeight:300, color:"#555", lineHeight:1.7, margin:0 }}>{boxContents}</p>
                    </div>
                  )}
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px 24px", marginBottom:18 }}>
                    {p.moq && <div><p style={{ fontSize:9, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 3px" }}>Min. Order</p><p style={{ fontSize:13, color:"#333", margin:0 }}>{p.moq} units</p></div>}
                    {p.lead_time && <div><p style={{ fontSize:9, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 3px" }}>Lead Time</p><p style={{ fontSize:13, color:"#333", margin:0 }}>{String(p.lead_time)}</p></div>}
                    {p.box_dimensions && <div><p style={{ fontSize:9, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 3px" }}>Dimensions</p><p style={{ fontSize:13, color:"#333", margin:0 }}>{String(p.box_dimensions)}</p></div>}
                    {p.weight_grams && <div><p style={{ fontSize:9, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 3px" }}>Weight</p><p style={{ fontSize:13, color:"#333", margin:0 }}>{p.weight_grams}g</p></div>}
                  </div>
                  <button style={{ ...S.btnGreen, ...(isHearted?{background:"#9B3A2A",boxShadow:"0 4px 0 #e8b4a8"}:{}) }} onClick={()=>toggleHeart(p)}>
                    {isHearted ? "♥  Saved for this brief" : "♡  Save to shortlist"}
                  </button>
                  {alsoConsidered.length>0 && (
                    <div style={{ marginTop:20, paddingTop:16, borderTop:`1px solid ${BORDER}` }}>
                      <p style={{ fontSize:9, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 10px" }}>Also in this direction</p>
                      <div style={{ display:"flex", gap:10, overflowX:"auto", paddingBottom:4 }}>
                        {alsoConsidered.map(op => (
                          <div key={op.id} style={{ flexShrink:0, width:72, cursor:"pointer" }} onClick={()=>setSelectedProduct({...op})}>
                            <div style={{ width:72, height:72, background:op._bg||SURFACE, overflow:"hidden", marginBottom:4 }}>
                              {op.image_url && <img src={op.image_url} alt={op.name||""} style={{ width:"100%", height:"100%", objectFit:"cover" }} onError={e=>{e.target.style.display="none"}}/>}
                            </div>
                            <p style={{ fontSize:10, color:"#777", margin:"0 0 1px", lineHeight:1.3, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:72 }}>{op.name}</p>
                            <p style={{ fontSize:10, color:"#aaa", margin:0 }}>₹{(op._price||0).toLocaleString("en-IN")}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

const styles = {
  app: { minHeight:"100vh", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", color:"#111" },
  fullCenter: { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:"100vh", textAlign:"center", padding:32 },
  muted: { fontFamily:"Georgia,serif", fontSize:15, fontWeight:300, color:"#aaa", marginTop:24 },
  av: { width:36, height:36, borderRadius:"50%", background:"#7A90B0", fontSize:12, fontWeight:600, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },

  // Home
  homePage: { minHeight:"100vh", display:"flex", flexDirection:"column" },
  homeNav: { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"18px 52px", borderBottom:`1px solid ${BORDER}` },
  homeTaglineLeft: { fontSize:10, letterSpacing:"3px", textTransform:"uppercase", color:"#bbb", margin:"0 0 18px", fontWeight:300 },
  hero: { flex:1, display:"flex", gap:0, overflow:"hidden" },
  heroLeft: { flex:"0 0 54%", padding:"44px 52px 36px", display:"flex", flexDirection:"column", justifyContent:"center" },
  heroH1: { fontFamily:"'Playfair Display',Georgia,serif", fontSize:40, fontWeight:700, color:DARK, lineHeight:1.2, margin:"0 0 12px", letterSpacing:-0.5 },
  heroSub: { fontSize:14, fontWeight:300, color:"#777", margin:"0 0 24px", lineHeight:1.65 },
  briefGuideRow: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px 32px", marginBottom:22, paddingBottom:20, borderBottom:`1px solid ${BORDER}` },
  briefGuideItem: { display:"flex", flexDirection:"column", gap:3 },
  briefGuideLabel: { fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#777", margin:0 },
  briefGuideEg: { fontSize:12, fontWeight:300, color:"#bbb", margin:0 },
  inputBox: { display:"flex", alignItems:"flex-end", background:"#fff", border:`1px solid #D0CBC3`, boxShadow:"0 2px 20px rgba(0,0,0,0.06)", marginBottom:10 },
  homeInput: { flex:1, border:"none", outline:"none", resize:"none", padding:"16px 20px 12px", fontFamily:"Georgia,serif", fontSize:16, fontWeight:300, color:DARK, lineHeight:1.7, background:"transparent" },
  homeBtn: { width:52, height:52, background:DOVE_BLUE, border:"none", cursor:"pointer", color:"#fff", fontSize:20, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, alignSelf:"flex-end" },
  liveParseRow: { display:"flex", alignItems:"center", gap:8, minHeight:28, marginBottom:24, flexWrap:"wrap" },
  liveParseLabel: { fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#888", flexShrink:0 },
  liveParsedChip: { fontSize:12, color:"#444", background:"transparent", padding:"4px 12px", border:`1px solid ${BORDER}`, fontWeight:400 },
  liveParsedChipBudget: { color:DOVE_BLUE, background:"rgba(107,140,174,0.07)", border:`1px solid rgba(107,140,174,0.35)`, fontWeight:600 },
  liveParsedChipConstraint: { color:"#7A4A2A", background:"rgba(122,74,42,0.06)", border:`1px solid rgba(122,74,42,0.22)`, fontWeight:500 },
  liveParseHint: { fontSize:12, color:"#bbb", fontWeight:300 },
  quickStarts: { marginTop:"auto", paddingTop:20 },
  quickStartLabel: { fontSize:9, fontWeight:600, letterSpacing:"2.5px", color:"#ccc", margin:"0 0 10px" },
  quickChip: { fontFamily:"Georgia,serif", fontSize:13, fontWeight:300, fontStyle:"italic", color:"#777", background:"none", border:`1px solid ${BORDER}`, padding:"6px 14px", cursor:"pointer", lineHeight:1.4, whiteSpace:"nowrap" },
  heroRight: { flex:"0 0 46%", position:"relative" },
  heroDarkPanel: { position:"absolute", inset:0, background:PANEL_BG, padding:"44px 44px", display:"flex", flexDirection:"column", justifyContent:"center" },
  heroPanelEyebrow: { fontSize:11, fontWeight:600, letterSpacing:"3px", textTransform:"uppercase", color:"rgba(255,255,255,0.3)", margin:"0 0 16px" },
  heroPanelHed: { fontFamily:"'Playfair Display',Georgia,serif", fontSize:34, fontWeight:400, color:"#fff", lineHeight:1.25, margin:"0 0 24px" },
  heroPanelDivider: { height:1, background:"rgba(255,255,255,0.08)", margin:"0 0 28px" },
  heroPanelPills: { display:"flex", flexDirection:"column", gap:16, marginBottom:36 },
  heroPanelPillRow: { display:"flex", alignItems:"flex-start", gap:10 },
  heroPanelPillLabel: { fontSize:13, color:"rgba(255,255,255,0.75)", fontWeight:400, margin:"0 0 2px" },
  heroPanelPillSub: { fontSize:11, color:"rgba(255,255,255,0.35)", fontWeight:300, margin:0 },
  heroPanelStats: { display:"flex", alignItems:"center", gap:24, paddingTop:28, borderTop:"1px solid rgba(255,255,255,0.07)" },
  statNum: { fontFamily:"'Playfair Display',Georgia,serif", fontSize:22, fontWeight:400, color:"#fff", margin:"0 0 3px" },
  statLabel: { fontSize:10, color:"rgba(255,255,255,0.35)", letterSpacing:"1px", textTransform:"uppercase", margin:0 },
  trustBar: { borderTop:`1px solid ${BORDER}`, padding:"16px 52px", display:"flex", alignItems:"center", gap:24, flexWrap:"wrap", background:SURFACE },
  trustLabel: { fontSize:11, color:"#bbb", letterSpacing:"0.5px", flexShrink:0 },
  trustLogo: { fontSize:11, fontWeight:600, color:"#aaa", letterSpacing:"0.5px", textTransform:"uppercase" },

  // Top bar
  topBar: { display:"flex", alignItems:"center", gap:16, padding:"0 24px", height:56, borderBottom:`1px solid ${BORDER}`, flexShrink:0, background:"#fff" },
  refineWrap: { flex:1, display:"flex", border:`1px solid #D8D4CE`, height:38, boxShadow:"0 1px 6px rgba(0,0,0,0.05)" },
  refineInput: { flex:1, border:"none", outline:"none", padding:"7px 14px", fontFamily:"Georgia,serif", fontSize:14, fontWeight:300, color:"#111", background:"transparent" },
  refineBtn: { padding:"0 18px", background:DOVE_BLUE, border:"none", cursor:"pointer", color:"#fff", fontSize:12, fontWeight:600, letterSpacing:"1px", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontFamily:"'Josefin Sans',sans-serif", whiteSpace:"nowrap" },
  shortlistBtn: { background:GREEN, color:"#fff", border:"none", padding:"7px 14px", fontFamily:"'Josefin Sans',sans-serif", fontSize:11, fontWeight:600, letterSpacing:"1px", cursor:"pointer", flexShrink:0, boxShadow:"0 3px 0 #a8d4b4" },

  // Results
  resultsPage: { height:"100vh", display:"flex", flexDirection:"column", overflow:"hidden" },
  directionsWrap: { maxWidth:1100, margin:"0 auto", padding:"40px 32px" },
  directionsHdr: { marginBottom:32 },
  directionsEyebrow: { fontSize:11, fontWeight:600, letterSpacing:"3px", textTransform:"uppercase", color:"#888", margin:"0 0 14px", fontFamily:"'Josefin Sans',sans-serif" },
  briefChipsRow: { display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", marginBottom:20 },
  briefChip: { fontSize:12, color:"#555", background:"transparent", border:`1px solid ${BORDER}`, padding:"4px 12px", fontWeight:400 },
  briefChipBudget: { color:DOVE_BLUE, background:"rgba(107,140,174,0.07)", border:`1px solid rgba(107,140,174,0.35)`, fontWeight:600 },
  briefChipConstraint: { color:"#7A4A2A", background:"rgba(122,74,42,0.06)", border:`1px solid rgba(122,74,42,0.22)`, fontWeight:500 },
  directionsH2: { fontFamily:"'Playfair Display',Georgia,serif", fontSize:36, fontWeight:700, color:DARK, margin:"0 0 12px", lineHeight:1.15 },
  directionsIntel: { fontFamily:"Georgia,serif", fontSize:16, fontWeight:300, color:"#444", margin:"8px 0 6px", lineHeight:1.6 },
  directionsContext: { fontFamily:"Georgia,serif", fontSize:14, fontStyle:"italic", fontWeight:300, color:"#666", margin:"0 0 10px", lineHeight:1.5 },
  confidenceCue: { fontSize:13, color:"#666", letterSpacing:"0.2px", margin:"0 0 18px", fontWeight:400, fontFamily:"Georgia,serif" },
  refineChipsRow: { display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" },
  refineChipsLabel: { fontSize:11, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:"#888", flexShrink:0, fontFamily:"'Josefin Sans',sans-serif" },
  refineChipBtn: { fontFamily:"Georgia,serif", fontSize:13, fontWeight:300, fontStyle:"italic", color:"#333", background:"none", border:`1px solid #bbb`, padding:"5px 14px", cursor:"pointer", lineHeight:1.4 },
  refineChipBtnMuted: { fontFamily:"Georgia,serif", fontSize:13, fontWeight:300, fontStyle:"italic", color:"#777", background:"none", border:`1px solid ${BORDER}`, padding:"5px 14px", cursor:"pointer", lineHeight:1.4, marginLeft:4 },
  refinedNote: { fontFamily:"Georgia,serif", fontSize:13, fontStyle:"italic", fontWeight:300, color:DOVE_BLUE, margin:"12px 0 0", display:"flex", alignItems:"center" },

  // Direction badges — colour-coded, actually readable
  dirBadge: { fontSize:10, fontWeight:600, letterSpacing:"1px", textTransform:"uppercase", padding:"3px 9px", fontFamily:"'Josefin Sans',sans-serif", flexShrink:0 },
  dirBadgePrimary:   { background:DOVE_BLUE, color:"#fff", border:`1px solid ${DOVE_BLUE}` },
  dirBadgeSecondary: { background:"transparent", color:"#444", border:"1px solid #999" },
  dirBadgeTertiary:  { background:DARK, color:"#fff", border:`1px solid ${DARK}` },

  directionCards: { display:"grid", gridTemplateColumns:"repeat(3, 1fr)", gap:24 },
  dirCard: { border:`1px solid ${BORDER}`, background:"#fff", display:"flex", flexDirection:"column", overflow:"hidden" },
  dirCardImg: { display:"flex", height:200, overflow:"hidden" },
  dirCardThumb: { flex:1, overflow:"hidden" },
  dirCardBody: { padding:"18px 20px 14px", flex:1 },
  dirCardNum: { fontSize:10, fontWeight:400, letterSpacing:"2px", textTransform:"uppercase", color:"#aaa", margin:"0 0 6px", fontFamily:"'Josefin Sans',sans-serif" },
  dirCardName: { fontFamily:"'Playfair Display',Georgia,serif", fontSize:24, fontWeight:400, color:DARK, margin:"0 0 6px", lineHeight:1.2 },
  dirCardTagline: { fontFamily:"Georgia,serif", fontSize:15, fontStyle:"italic", fontWeight:300, color:"#444", margin:"0 0 8px", lineHeight:1.55 },
  dirCardDesc: { fontSize:14, fontWeight:300, color:"#555", margin:"0 0 10px", lineHeight:1.55, fontFamily:"Georgia,serif" },
  dirCardMicroTags: { fontSize:12, color:DOVE_BLUE, letterSpacing:"0.3px", margin:"0 0 10px", fontWeight:500 },
  dirCardPrice: { fontFamily:"'Playfair Display',Georgia,serif", fontSize:19, fontWeight:400, color:DARK, margin:"0 0 4px" },
  dirCardCount: { fontSize:13, color:"#777", letterSpacing:"0.3px", margin:0, fontFamily:"'Josefin Sans',sans-serif" },
  exploreBtn: { margin:"0 20px 20px", padding:"12px 0", background:DOVE_BLUE, color:"#fff", border:"none", cursor:"pointer", fontFamily:"'Josefin Sans',sans-serif", fontSize:12, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", boxShadow:`0 3px 0 rgba(107,140,174,0.3)` },

  // Grid
  gridWrap: { padding:"20px 28px" },
  backLink: { fontSize:12, color:"#666", background:"none", border:"none", cursor:"pointer", fontFamily:"'Josefin Sans',sans-serif", letterSpacing:"0.5px", padding:0 },
  dirBanner: { display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:16, paddingBottom:16, borderBottom:`1px solid ${BORDER}` },
  dirBannerName: { fontFamily:"'Playfair Display',Georgia,serif", fontSize:26, fontWeight:400, color:DARK, margin:"0 0 4px" },
  dirBannerTagline: { fontFamily:"Georgia,serif", fontSize:15, fontStyle:"italic", fontWeight:300, color:"#555", margin:0 },
  sortBtn: { fontSize:12, color:"#888", background:"none", border:"none", cursor:"pointer", fontFamily:"'Josefin Sans',sans-serif", padding:"4px 10px" },
  sortOn: { color:DARK, borderBottom:`1.5px solid ${DARK}`, fontWeight:600 },
  grid: { display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(200px, 1fr))", gap:"28px 20px" },

  // Top 2 picks
  topPicksRow: { marginBottom:24 },
  topPicksLabel: { fontSize:13, fontWeight:400, color:"#666", margin:"0 0 12px", fontFamily:"Georgia,serif", fontStyle:"italic" },
  topPicksGrid: { display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:16 },
  topCard: { border:`1px solid #C0CFE0`, background:"#fff", cursor:"pointer", overflow:"hidden" },
  topCardImg: { width:"100%", aspectRatio:"1", position:"relative", overflow:"hidden", background:SURFACE },
  topCardBody: { padding:"14px 14px 18px" },
  topCardName: { fontFamily:"'Playfair Display',Georgia,serif", fontSize:19, fontWeight:400, color:DARK, margin:"6px 0 5px", lineHeight:1.25 },
  topCardPos: { fontFamily:"Georgia,serif", fontSize:14, fontWeight:300, fontStyle:"italic", color:"#555", margin:"0 0 8px", lineHeight:1.6 },
  topCardPrice: { fontSize:16, fontWeight:600, color:DARK, margin:0 },

  // Standard cards
  cardPos: { fontFamily:"Georgia,serif", fontSize:14, fontWeight:300, fontStyle:"italic", color:"#555", margin:"0 0 6px", lineHeight:1.6 },
  card: { cursor:"pointer" },
  cardImg: { width:"100%", paddingBottom:"116%", position:"relative", overflow:"hidden" },
  heartBtn: { position:"absolute", top:8, right:8, width:28, height:28, background:"rgba(255,255,255,0.9)", border:"none", fontSize:13, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" },
  cardBody: { paddingTop:14, paddingBottom:4 },
  tierBadge: { fontSize:10, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", display:"inline-block", padding:"3px 8px", marginBottom:8, fontFamily:"'Josefin Sans',sans-serif" },
  tierGold: { color:"#7a5c20", background:"#fdf5e6", border:"1px solid #e8d5a0" },
  tierPlat: { color:"#2a4a7a", background:"#eef3fa", border:"1px solid #b8cce8" },
  tierSilv: { color:"#555", background:"#f5f5f5", border:"1px solid #d8d8d8" },
  cardName: { fontFamily:"'Playfair Display',Georgia,serif", fontSize:19, fontWeight:400, color:DARK, margin:"0 0 5px", lineHeight:1.25 },
  cardPrice: { fontSize:15, fontWeight:600, color:DARK, margin:0 },

  // Shortlist drawer
  drawer: { width:272, background:"#fff", borderLeft:`1px solid ${BORDER}`, display:"flex", flexDirection:"column", flexShrink:0 },
  drawerHdr: { padding:"16px 20px 14px", borderBottom:`1px solid ${BORDER}`, display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0 },
  drawerTitle: { fontSize:11, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:DARK, margin:0 },
  slRow: { display:"flex", alignItems:"center", gap:10, padding:"11px 18px", borderBottom:"1px solid #F5F0E8" },
  drawerFtr: { padding:18, borderTop:`1px solid ${BORDER}`, flexShrink:0 },
  btnGreen: { width:"100%", background:GREEN, color:"#fff", border:"none", padding:14, fontFamily:"'Josefin Sans',sans-serif", fontSize:11, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", cursor:"pointer", boxShadow:"0 4px 0 #a8d4b4", display:"block" },

  // Modal
  modalOverlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:500, padding:32 },
  modalBox: { background:"#fff", width:"100%", maxWidth:860, maxHeight:"90vh", overflow:"hidden", position:"relative", display:"flex", flexDirection:"column" },
  modalClose: { position:"absolute", top:12, right:16, background:"none", border:"none", fontSize:28, color:"#aaa", cursor:"pointer", lineHeight:1, zIndex:10 },
  modalInner: { display:"flex", flex:1, overflow:"hidden" },
  modalImgWrap: { width:340, minWidth:340, flexShrink:0, background:SURFACE, overflow:"hidden" },
  modalContent: { flex:1, padding:"24px 26px", overflowY:"auto" },
  modalDoveLine: { background:"rgba(107,140,174,0.06)", border:`1px solid rgba(107,140,174,0.2)`, padding:"10px 14px", lineHeight:1.5, display:"flex", alignItems:"flex-start" },
  modalBriefRow: { display:"flex", alignItems:"center", gap:5, flexWrap:"wrap", marginTop:10, paddingBottom:10, borderBottom:`1px solid ${BORDER}` },
  modalCues: { display:"flex", gap:8, flexWrap:"wrap", margin:"0 0 4px" },
  modalCue: { fontSize:11, color:GREEN, fontWeight:500, letterSpacing:"0.3px" },

  doveDot: { display:"inline-block", width:7, height:7, borderRadius:"50%", background:DOVE_BLUE, flexShrink:0 },
};
