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
const TRUST_LOGOS = ["Axis Bank","Avendus","LGT Wealth","Neo Wealth","Bain & Company"];

// ── Helpers ────────────────────────────────────────────────────

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

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
      <span style={{ fontFamily:"'PT Serif',Georgia,serif", fontSize:rockSz, fontWeight:700, letterSpacing:size==="xl"?10:4, textTransform:"uppercase", color:DARK, lineHeight:1 }}>Rock</span>
      <span style={{ fontFamily:"'PT Serif',Georgia,serif", fontSize:doveSz, fontStyle:"italic", color:DOVE_BLUE, fontWeight:400, letterSpacing:1, lineHeight:1 }}>Dove</span>
    </div>
  );
  if (onClick) return <button onClick={onClick} style={{ background:"none", border:"none", cursor:"pointer", padding:0 }}>{el}</button>;
  return el;
}

// ── DOVE CHAT PANEL (inline, no separate component to avoid focus loss) ────────

const REFINE_CHIPS = [
  { label:"More premium",      query:" more premium, elevated only" },
  { label:"Only non-fragile",  query:" nothing fragile, courier-safe only" },
  { label:"More artisan",      query:" handcrafted, artisan-made, Indian craft" },
  { label:"Different style",   query:" completely different aesthetic and category" },
];

// ── APP ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [session, setSession] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const productsRef = useRef([]);
  const [view, setView] = useState("home");

  // Home fields
  const [homeQty, setHomeQty] = useState("");
  const [homeBudget, setHomeBudget] = useState("");
  const [homeTimeline, setHomeTimeline] = useState("");
  const [homeFlexible, setHomeFlexible] = useState(false);

  // Search state
  const [brief, setBrief] = useState("");
  const [thinking, setThinking] = useState(false);
  const [thinkingLabel, setThinkingLabel] = useState("Scanning 160+ curated gifts…");
  const [briefSummary, setBriefSummary] = useState("");
  const [lastFilters, setLastFilters] = useState(null);
  const [intakeHistory, setIntakeHistory] = useState([]);
  const [gridProducts, setGridProducts] = useState([]);
  const [sort, setSort] = useState("rec");

  // Shortlist
  const [hearted, setHearted] = useState(new Set());
  const heartedRef = useRef({});
  const [shortlistOpen, setShortlistOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Product modal
  const [selectedProduct, setSelectedProduct] = useState(null);

  // Dove chat panel
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatAreaRef = useRef(null);

  // Refined note
  const [refinedNote, setRefinedNote] = useState("");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token") ||
      window.location.pathname.split("/").pop();
    if (token && token !== "/") loadSession(token);
    else setNotFound(true);
  }, []);

  useEffect(() => {
    if (chatAreaRef.current) chatAreaRef.current.scrollTop = chatAreaRef.current.scrollHeight;
  }, [chatMessages, chatLoading]);

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

  // Build summary chips from the three home fields
  const homeSummaryChips = () => {
    const chips = [];
    if (homeQty) chips.push({ label:`${homeQty} recipients`, cls:"" });
    if (homeBudget) chips.push({ label:`₹${parseInt(homeBudget).toLocaleString("en-IN")} each`, cls:"budget" });
    if (homeFlexible) chips.push({ label:"No deadline", cls:"flex" });
    else if (homeTimeline) chips.push({ label:`By ${homeTimeline}`, cls:"timeline" });
    return chips;
  };

  // Build the brief string from the three fields, then search
  const handleHomeSearch = async () => {
    if (!homeQty || !homeBudget) return;
    const timelineStr = homeFlexible ? "" : homeTimeline ? `, needed by ${homeTimeline}` : "";
    const constructedBrief = `${homeQty} recipients, ₹${homeBudget} each${timelineStr}`;
    await handleSearch(constructedBrief, parseInt(homeBudget), homeFlexible ? null : homeTimeline);
  };

  const handleSearch = async (searchBrief, budgetOverride, timelineOverride) => {
    const q = searchBrief.trim();
    if (!q || thinking) return;
    setBrief(q);
    setThinking(true);
    setRefinedNote("");
    setChatMessages([]);
    setView("thinking");
    saveConvo("user", q);
    const allProducts = productsRef.current;

    try {
      // Thinking labels — timeline-aware
      const hasTimeline = timelineOverride && timelineOverride !== "flexible";
      const labels = [
        "Scanning 160+ curated gifts…",
        hasTimeline ? "Checking availability for your timeline…" : "Ranking across the full catalogue…",
        "Curating your edit…",
      ];
      let labelIdx = 0;
      setThinkingLabel(labels[0]);
      const labelInterval = setInterval(() => {
        labelIdx++;
        if (labelIdx < labels.length) setThinkingLabel(labels[labelIdx]);
        else clearInterval(labelInterval);
      }, 1000);

      // Use dove-chat with a system override for the three-field brief
      const INTAKE_SYSTEM = `You are Dove, gifting concierge for Rock Dove by Ikka Dukka — a premium Indian gifting platform.

Extract a gifting brief from what the client says. Be warm, brief, decisive. Replies max 1 sentence.

FIRST: Check if this is a gifting query. If not, reply with a gentle redirect and set is_gifting_query: false.

If it IS a gifting query, extract: recipient, quantity, occasion, deadline, budget, restrictions.

If you have enough info (quantity + budget at minimum), set ready: true immediately.
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

      const doveRes = await fetch(CATALOGUE_URL + "/dove-chat", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ message:q, conversation_history:intakeHistory, system_override:INTAKE_SYSTEM }),
      });
      const doveData = await doveRes.json();
      const newHistory = [...intakeHistory, { role:"user", content:q }, { role:"assistant", content:doveData.response }];
      setIntakeHistory(newHistory);
      if (!doveData.is_gifting_query) { setView("home"); setThinking(false); return; }

      const filters = doveData.filters || {};
      // Override budget from the field if provided
      if (budgetOverride) filters.budget = budgetOverride;
      if (doveData.filters) setLastFilters({ ...filters });

      const qty = filters.qty || parseInt(homeQty) || 1;
      const budget = filters.budget || null;

      const candidates = allProducts.filter(p => {
        const price = priceAtQty(p.pricing_tiers, qty);
        if (budget && price > budget * 1.2) return false;
        if (filters.exclude_edible && p.edible) return false;
        if (filters.exclude_fragile && p.fragile) return false;
        // Timeline filtering — if a specific deadline, prefer in-stock
        if (hasTimeline && p.lead_time) {
          // We surface everything but flag MTO that won't make it
        }
        return true;
      }).map(p => ({
        id:p.id, name:p.name||"", category:p.category||"",
        description:(p.description||"").slice(0,130),
        whats_in_box: Array.isArray(p.whats_in_box) ? p.whats_in_box.join(", ").slice(0,80) : (p.whats_in_box||"").slice(0,80),
        price: priceAtQty(p.pricing_tiers, qty),
        tier:p.tier||"", tags:(p._tags||[]).join(", "),
      }));

      const rankRes = await fetch(CATALOGUE_URL + "/dove-rank", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ brief:filters.query||q, budget, exclude_edible:filters.exclude_edible||false, exclude_fragile:filters.exclude_fragile||false, products:candidates }),
      });
      const ranked = await rankRes.json();
      const idOrder = ranked.ranked_ids || [];

      const productMap = {};
      allProducts.forEach(p => { productMap[p.id] = { ...p, _price:priceAtQty(p.pricing_tiers, qty) }; });
      const orderedProducts = idOrder.map(id => productMap[id]).filter(Boolean);

      setBriefSummary(ranked.summary || "");
      setGridProducts(orderedProducts);
      saveConvo("assistant", ranked.summary||"");

      // Set Dove's opening message in the chat panel
      const firstName = session?.client_name?.split(" ")[0] || "";
      const qtyLabel = homeQty ? `${homeQty} recipients` : "your recipients";
      const budgetLabel = homeBudget ? `₹${parseInt(homeBudget).toLocaleString("en-IN")} each` : "your budget";
      const timelineLabel = hasTimeline ? ` for delivery by ${timelineOverride}` : "";
      const doveOpener = `I've found ${orderedProducts.length} options that work for ${qtyLabel}, ${budgetLabel}${timelineLabel} — leaning considered and understated, which suits this brief. Tell me a bit about who these are for and I can narrow this further.`;

      setChatMessages([{ role:"dove", text:doveOpener }]);
      setView("grid");
    } catch(e) { console.error(e); setView("home"); }
    setThinking(false);
  };

  const handleChatRefine = async () => {
    const text = chatInput.trim();
    if (!text || chatLoading) return;
    setChatInput("");
    setChatMessages(prev => [...prev, { role:"user", text }]);
    setChatLoading(true);

    // Append to brief and re-search, but keep it conversational
    const combined = brief + ". " + text;
    setBrief(combined);

    try {
      const allProducts = productsRef.current;
      const qty = lastFilters?.qty || parseInt(homeQty) || 1;
      const budget = lastFilters?.budget || null;

      const doveRes = await fetch(CATALOGUE_URL + "/dove-chat", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          message: text,
          conversation_history: chatMessages.map(m => ({ role: m.role === "dove" ? "assistant" : "user", content: m.text })),
        }),
      });
      const doveData = await doveRes.json();
      const updatedFilters = { ...lastFilters, ...(doveData.filters || {}) };
      setLastFilters(updatedFilters);

      const candidates = allProducts.filter(p => {
        const price = priceAtQty(p.pricing_tiers, qty);
        if (budget && price > (updatedFilters.budget || budget) * 1.2) return false;
        if (updatedFilters.exclude_edible && p.edible) return false;
        if (updatedFilters.exclude_fragile && p.fragile) return false;
        return true;
      }).map(p => ({
        id:p.id, name:p.name||"", category:p.category||"",
        description:(p.description||"").slice(0,130),
        whats_in_box: Array.isArray(p.whats_in_box) ? p.whats_in_box.join(", ").slice(0,80) : (p.whats_in_box||"").slice(0,80),
        price: priceAtQty(p.pricing_tiers, qty),
        tier:p.tier||"", tags:(p._tags||[]).join(", "),
      }));

      const rankRes = await fetch(CATALOGUE_URL + "/dove-rank", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ brief: updatedFilters.query || combined, budget: updatedFilters.budget || budget, exclude_edible:updatedFilters.exclude_edible||false, exclude_fragile:updatedFilters.exclude_fragile||false, products:candidates }),
      });
      const ranked = await rankRes.json();
      const idOrder = ranked.ranked_ids || [];
      const productMap = {};
      allProducts.forEach(p => { productMap[p.id] = { ...p, _price:priceAtQty(p.pricing_tiers, qty) }; });
      const orderedProducts = idOrder.map(id => productMap[id]).filter(Boolean);
      setGridProducts(orderedProducts);
      setBriefSummary(ranked.summary || "");

      const doveReply = doveData.response || "I've adjusted the results based on that.";
      setChatMessages(prev => [...prev, { role:"dove", text:doveReply }]);
    } catch(e) {
      console.error(e);
      setChatMessages(prev => [...prev, { role:"dove", text:"I've adjusted the results — let me know if you'd like to refine further." }]);
    }
    setChatLoading(false);
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
  const sortedGrid = (() => {
    const base = [...gridProducts].sort((a,b)=>{
      if (sort==="asc") return (a._price||0)-(b._price||0);
      if (sort==="desc") return (b._price||0)-(a._price||0);
      return 0;
    });
    if (sort !== "rec") return base;
    // Round-robin interleave by category — one from each category at a time
    const byCategory = {};
    for (const p of base) {
      const cat = (p.category || "other").toLowerCase();
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(p);
    }
    const categories = Object.keys(byCategory);
    const result = [];
    let added = true;
    while (added) {
      added = false;
      for (const cat of categories) {
        if (byCategory[cat].length > 0) {
          result.push(byCategory[cat].shift());
          added = true;
        }
      }
    }
    return result;
  })();

  const S = styles;

  if (notFound) return <div style={S.fullCenter}><Logo size="xl"/><p style={S.muted}>This link is invalid or has expired.</p></div>;
  if (!session) return <div style={S.fullCenter}><Logo size="xl"/><p style={S.muted}>Loading…</p></div>;

  if (view === "submitted") return (
    <div style={S.fullCenter}>
      <div style={{ width:52, height:52, borderRadius:"50%", background:GREEN, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, marginBottom:24 }}>✓</div>
      <p style={{ fontFamily:"'PT Serif',Georgia,serif", fontSize:26, fontWeight:400, color:DARK, margin:"0 0 10px" }}>Shortlist sent</p>
      <p style={{ fontFamily:"Georgia,serif", fontSize:15, fontWeight:300, color:"#888", maxWidth:360, lineHeight:1.8, margin:"0 0 8px", textAlign:"center" }}>
        Thank you, {session.client_name.split(" ")[0]}. Nilisha's team will send a formal quote within 4 working hours.
      </p>
      <p style={{ fontFamily:"Georgia,serif", fontSize:13, fontWeight:300, color:"#aaa", maxWidth:360, lineHeight:1.8, margin:"0 0 28px", textAlign:"center" }}>
        We'll be in touch at {session.contact_email || "your registered email"}.
      </p>
      {shortlistItems.map(p=>(
        <div key={p.id} style={{ display:"flex", alignItems:"center", gap:14, padding:"12px 0", borderBottom:`1px solid ${BORDER}`, width:"100%", maxWidth:380 }}>
          <div style={{ width:44, height:54, background:p._bg||SURFACE, flexShrink:0, overflow:"hidden" }}>
            {p.image_url && <img src={p.image_url} alt={p.name} style={{ width:"100%", height:"100%", objectFit:"cover" }}/>}
          </div>
          <div>
            <p style={{ fontFamily:"'PT Serif',Georgia,serif", fontSize:15, fontWeight:400, color:DARK, margin:"0 0 3px" }}>{p.name}</p>
            <p style={{ fontSize:13, color:"#aaa", margin:0 }}>₹{(p._price||0).toLocaleString("en-IN")}</p>
          </div>
        </div>
      ))}
    </div>
  );

  // ── Shared inline JSX ──────────────────────────────────────────

  const topBarJSX = (
    <div style={S.topBar}>
      <Logo size="sm" onClick={() => setView("home")}/>
      <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0, marginLeft:"auto" }}>
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
          <span style={{ fontFamily:"'PT Serif',Georgia,serif", fontSize:20, fontWeight:400, color:DARK }}>
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

  // Dove chat panel JSX — persistent right panel on the grid view
  const dovePanelJSX = (
    <div style={{ width:272, flexShrink:0, borderLeft:`0.5px solid ${BORDER}`, display:"flex", flexDirection:"column", background:'#FAFAF8' }}>
      <div style={{ padding:"14px 16px 10px", borderBottom:`0.5px solid ${BORDER}`, flexShrink:0 }}>
        <p style={{ fontSize:9, fontWeight:700, letterSpacing:"2.5px", textTransform:"uppercase", color:"#BBB", margin:0, fontFamily:"'Hanken Grotesk',sans-serif" }}>Dove — your gifting concierge</p>
      </div>
      <div ref={chatAreaRef} style={{ flex:1, overflowY:"auto", padding:"12px 16px", display:"flex", flexDirection:"column", gap:10 }}>
        {chatMessages.map((m,i) => (
          <div key={i} style={{ display:"flex", gap:8, flexDirection:m.role==="dove"?"row":"row-reverse" }}>
            {m.role==="dove" && (
              <div style={{ width:24, height:24, borderRadius:"50%", background:DOVE_BLUE, fontSize:9, fontWeight:600, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, marginTop:2 }}>D</div>
            )}
            <div style={{ maxWidth:196, padding:"8px 10px", fontFamily:"Georgia,serif", fontSize:12, fontWeight:300, lineHeight:1.6, ...(m.role==="dove" ? { background:"#fff", border:`0.5px solid ${BORDER}`, borderRadius:"0 8px 8px 8px", color:DARK } : { background:DOVE_BLUE, color:"#fff", borderRadius:"8px 0 8px 8px", fontFamily:"'Josefin Sans',sans-serif", fontSize:11 }) }}>
              {m.text}
            </div>
          </div>
        ))}
        {chatLoading && (
          <div style={{ display:"flex", gap:8 }}>
            <div style={{ width:24, height:24, borderRadius:"50%", background:DOVE_BLUE, fontSize:9, fontWeight:600, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>D</div>
            <div style={{ padding:"8px 10px", background:"#fff", border:`0.5px solid ${BORDER}`, borderRadius:"0 8px 8px 8px", display:"flex", gap:3, alignItems:"center" }}>
              {[0,0.2,0.4].map((d,i)=>(
                <div key={i} style={{ width:5, height:5, borderRadius:"50%", background:DOVE_BLUE, animationDelay:`${d}s` }} className="td"></div>
              ))}
            </div>
          </div>
        )}
        {chatMessages.length > 0 && !chatLoading && (
          <div style={{ display:"flex", flexWrap:"wrap", gap:5, marginTop:4 }}>
            {REFINE_CHIPS.map((c,i) => (
              <button key={i} style={{ fontSize:9, fontWeight:700, letterSpacing:"1px", textTransform:"uppercase", color:DOVE_BLUE, background:"rgba(107,140,174,0.08)", border:`0.5px solid rgba(107,140,174,0.25)`, padding:"4px 9px", cursor:"pointer" }}
                onClick={() => { setChatInput(c.label); }}>
                {c.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={{ padding:"10px 12px", borderTop:`0.5px solid ${BORDER}`, display:"flex", gap:6, flexShrink:0 }}>
        <textarea
          style={{ flex:1, border:`0.5px solid ${BORDER}`, outline:"none", padding:"6px 10px", fontFamily:"Georgia,serif", fontSize:12, fontWeight:300, background:"#fff", color:DARK, resize:"none", lineHeight:1.4, height:36 }}
          value={chatInput}
          onChange={e => setChatInput(e.target.value)}
          onKeyDown={e => { if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); handleChatRefine(); } }}
          placeholder="Refine in conversation…"
        />
        <button
          style={{ width:32, height:36, background:DOVE_BLUE, border:"none", color:"#fff", cursor:"pointer", fontSize:14, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}
          onClick={handleChatRefine}
        >→</button>
      </div>
    </div>
  );

  return (
    <div style={{ ...S.app, background:BG }}>

      {/* ── HOME ── */}
      {view === "home" && (
        <div style={S.homePage}>
          <div style={S.homeNav}>
            <div style={{ opacity:0 }}>·</div>
            <Logo size="md"/>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <div style={S.av}>{initials(session.client_name)}</div>
              <div>
                <p style={{ fontSize:13, fontWeight:600, letterSpacing:"0.5px", fontFamily:"'Josefin Sans',sans-serif", color:DARK, margin:0 }}>{session.client_name}</p>
                {session.client_company && <p style={{ fontSize:12, color:"#888", margin:0 }}>{session.client_company}</p>}
              </div>
            </div>
          </div>

          <div style={S.hero}>
            <div style={S.heroLeft}>

              {/* Dove greeting */}
              <div style={{ display:"flex", gap:10, alignItems:"flex-start", marginBottom:24 }}>
                <div style={{ width:30, height:30, borderRadius:"50%", background:DOVE_BLUE, fontSize:10, fontWeight:600, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, marginTop:2 }}>D</div>
                <div>
                  <p style={{ fontSize:10, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:DOVE_BLUE, margin:"0 0 4px" }}>Dove</p>
                  <p style={{ fontFamily:"Georgia,serif", fontSize:14, fontWeight:300, color:DARK, lineHeight:1.7, margin:0 }}>
                    {getGreeting()}, {session.client_name.split(" ")[0]}. <em style={{ color:DOVE_BLUE }}>Three quick things — then I'll find the right gifts.</em>
                  </p>
                </div>
              </div>

              {/* Three-field card */}
              <div style={{ border:`1px solid #C0B8B0`, background:"#fff", marginBottom:12, boxShadow:"0 2px 12px rgba(0,0,0,0.06)" }}>
                {/* Row 1 — Qty + Budget */}
                <div style={{ display:"flex", borderBottom:`0.5px solid ${BORDER}` }}>
                  <div style={{ flex:1, padding:"16px 18px", borderRight:`0.5px solid ${BORDER}` }}>
                    <label style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#888", display:"block", marginBottom:8 }}>How many recipients?</label>
                    <input
                      type="number" min="1" placeholder="50"
                      value={homeQty}
                      onChange={e => setHomeQty(e.target.value)}
                      style={{ width:"100%", border:"none", outline:"none", fontFamily:"Georgia,serif", fontSize:20, fontWeight:300, color:DARK, background:"transparent", padding:0 }}
                    />
                    <p style={{ fontSize:11, color:"#aaa", marginTop:4 }}>people</p>
                  </div>
                  <div style={{ flex:1, padding:"16px 18px" }}>
                    <label style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#888", display:"block", marginBottom:8 }}>Budget per gift</label>
                    <input
                      type="number" min="200" placeholder="2,500"
                      value={homeBudget}
                      onChange={e => setHomeBudget(e.target.value)}
                      style={{ width:"100%", border:"none", outline:"none", fontFamily:"Georgia,serif", fontSize:20, fontWeight:300, color:DARK, background:"transparent", padding:0 }}
                    />
                    <p style={{ fontSize:11, color:"#aaa", marginTop:4 }}>₹ per person</p>
                  </div>
                </div>
                {/* Row 2 — Timeline */}
                <div style={{ padding:"16px 18px" }}>
                  <label style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#888", display:"block", marginBottom:8 }}>When do you need this by?</label>
                  <input
                    type="text" placeholder="e.g. 15 October"
                    value={homeTimeline}
                    disabled={homeFlexible}
                    onChange={e => setHomeTimeline(e.target.value)}
                    style={{ width:"100%", border:"none", outline:"none", fontFamily:"Georgia,serif", fontSize:20, fontWeight:300, color:homeFlexible?"#bbb":DARK, background:"transparent", padding:0, marginBottom:10 }}
                  />
                  <div style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" }} onClick={() => setHomeFlexible(f => !f)}>
                    <div style={{ width:14, height:14, border:`0.5px solid ${homeFlexible?DOVE_BLUE:"#C0B8B0"}`, background:homeFlexible?DOVE_BLUE:"transparent", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                      {homeFlexible && <div style={{ width:7, height:7, background:"#fff" }}></div>}
                    </div>
                    <span style={{ fontFamily:"Georgia,serif", fontSize:12, fontStyle:"italic", fontWeight:300, color:"#888" }}>I'm flexible — show me everything</span>
                  </div>
                </div>
              </div>

              {/* Summary chips */}
              <div style={{ display:"flex", alignItems:"center", gap:7, minHeight:26, marginBottom:18, flexWrap:"wrap" }}>
                {homeSummaryChips().length === 0
                  ? <span style={{ fontFamily:"Georgia,serif", fontSize:11, fontStyle:"italic", color:"#aaa" }}>Fill in the fields above — Dove does the rest.</span>
                  : <>
                      <span style={{ fontSize:9, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#888", flexShrink:0 }}>Brief:</span>
                      {homeSummaryChips().map((c,i) => (
                        <span key={i} style={{ fontSize:11, padding:"3px 10px", border:`0.5px solid ${c.cls==="budget"?"rgba(107,140,174,0.4)":c.cls==="timeline"?"rgba(44,95,58,0.25)":c.cls==="flex"?"#ddd":BORDER}`, color:c.cls==="budget"?DOVE_BLUE:c.cls==="timeline"?"#2C5F3A":c.cls==="flex"?"#aaa":"#555", background:c.cls==="budget"?"rgba(107,140,174,0.07)":c.cls==="timeline"?"rgba(44,95,58,0.06)":"transparent", borderStyle:c.cls==="flex"?"dashed":"solid", fontWeight:c.cls==="budget"?600:400 }}>{c.label}</span>
                      ))}
                    </>
                }
              </div>

              {/* CTA */}
              <div style={{ display:"flex", alignItems:"center", gap:14, marginBottom:20 }}>
                <button
                  style={{ background:"#111", color:"#fff", border:"none", padding:"13px 28px", fontFamily:"'Hanken Grotesk',sans-serif", fontSize:10, fontWeight:700, letterSpacing:"2px", textTransform:"uppercase", cursor:(!homeQty||!homeBudget)?"not-allowed":"pointer", opacity:(!homeQty||!homeBudget)?0.45:1 }}
                  disabled={!homeQty || !homeBudget}
                  onClick={handleHomeSearch}
                >
                  Find my gifts →
                </button>
                <span style={{ fontFamily:"Georgia,serif", fontSize:12, fontStyle:"italic", fontWeight:300, color:"#aaa" }}>
                  {homeQty && homeBudget ? "Dove will ask about the occasion once it shows you results." : "Two more fields and Dove is ready."}
                </span>
              </div>

              {/* Quick starts */}
              <div style={{ display:"flex", gap:7, flexWrap:"wrap" }}>
                {[
                  { label:"Diwali gifting →", qty:"50", budget:"2500", timeline:"15 October", flex:false },
                  { label:"One premium gift →", qty:"1", budget:"8000", timeline:"", flex:true },
                  { label:"New joiner kits →", qty:"30", budget:"1500", timeline:"", flex:true },
                ].map((q,i) => (
                  <button key={i}
                    style={{ fontFamily:"Georgia,serif", fontSize:12, fontWeight:300, fontStyle:"italic", color:"#444", background:"none", border:`0.5px solid #C0BAB2`, padding:"6px 14px", cursor:"pointer" }}
                    onClick={() => { setHomeQty(q.qty); setHomeBudget(q.budget); setHomeTimeline(q.timeline); setHomeFlexible(q.flex); }}>
                    {q.label}
                  </button>
                ))}
              </div>

            </div>

            {/* Right dark panel */}
            <div style={S.heroRight}>
              <div style={S.heroDarkPanel}>
                <p style={S.heroPanelEyebrow}>Ikka Dukka</p>
                <p style={{ fontFamily:"'PT Serif',Georgia,serif", fontSize:28, fontWeight:400, color:"#fff", lineHeight:1.25, margin:"0 0 20px" }}>
                  Three questions.<br/><em style={{ color:"rgba(255,255,255,0.55)" }}>Then the right gifts.</em>
                </p>
                <div style={S.heroPanelDivider}></div>
                <div style={S.heroPanelPills}>
                  {[
                    { label:"Occasion emerges in conversation", sub:"Dove asks after showing you results" },
                    { label:"Timeline filters availability", sub:"In-stock items flagged for tight deadlines" },
                    { label:"160+ gifts, ranked for your brief", sub:"Not a catalogue — a curated edit" },
                  ].map((t,i) => (
                    <div key={i} style={S.heroPanelPillRow}>
                      <span style={{ fontSize:6, color:"rgba(255,255,255,0.3)", marginTop:5 }}>●</span>
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
            <span style={S.trustLabel}>Trusted by</span>
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

      {/* ── GRID ── */}
      {view === "grid" && (
        <div style={{ ...S.resultsPage, background:BG }}>
          {topBarJSX}
          <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
            <div style={{ flex:1, overflowY:"auto" }}>
              <div style={S.gridWrap}>
                {/* Brief chips row */}
                <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", marginBottom:16, paddingBottom:14, borderBottom:`0.5px solid ${BORDER}` }}>
                  {homeSummaryChips().map((c,i) => (
                    <span key={i} style={{ fontSize:9, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", padding:"4px 12px", border:"none", background:c.cls==="budget"?"rgba(107,140,174,0.1)":"#F5F3F0", color:c.cls==="budget"?DOVE_BLUE:"#888" }}>{c.label}</span>
                  ))}
                  {briefSummary && (
                    <span style={{ fontFamily:"'PT Serif',Georgia,serif", fontSize:11, fontWeight:400, color:"#888", fontStyle:"italic", marginLeft:4 }}>
                      <span style={{ fontWeight:600, color:DOVE_BLUE }}>Dove:</span> {briefSummary}
                    </span>
                  )}
                  <div style={{ display:"flex", gap:4, marginLeft:"auto", flexShrink:0 }}>
                    {[["rec","Best fit"],["asc","Price ↑"],["desc","Price ↓"]].map(([v,l])=>(
                      <button key={v} style={{ ...S.sortBtn, ...(sort===v?S.sortOn:{}) }} onClick={()=>setSort(v)}>{l}</button>
                    ))}
                  </div>
                </div>

                <p style={{ fontSize:9, fontWeight:700, color:"#BBB", letterSpacing:"2px", textTransform:"uppercase", marginBottom:16, fontFamily:"'Hanken Grotesk',sans-serif" }}>
                  {sortedGrid.length} gifts matched
                </p>

                {/* Top 4 picks */}
                {sort==="rec" && sortedGrid.length>=2 && (
                  <div style={{ marginBottom:24 }}>
                    <p style={{ fontSize:9, fontWeight:700, letterSpacing:"3px", textTransform:"uppercase", color:"#BBB", margin:"0 0 16px", fontFamily:"'Hanken Grotesk',sans-serif" }}>Dove's picks for this brief</p>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:16 }}>
                      {(() => {
                        const budget = lastFilters?.budget || null;
                        let pool = sortedGrid.slice(0, 16);
                        if (budget) {
                          pool = [...pool].sort((a, b) => {
                            const aDist = Math.abs(budget - (a._price || 0));
                            const bDist = Math.abs(budget - (b._price || 0));
                            return aDist - bDist;
                          });
                        }
                        // Deduplicate by category — max 1 per category in top 4
                        const usedCategories = new Set();
                        const diversePicks = [];
                        for (const p of pool) {
                          const cat = (p.category || "other").toLowerCase();
                          if (!usedCategories.has(cat)) {
                            usedCategories.add(cat);
                            diversePicks.push(p);
                          }
                          if (diversePicks.length === 4) break;
                        }
                        // Fall back to pool if not enough diverse picks
                        const top4 = diversePicks.length >= 2 ? diversePicks : pool.slice(0, 4);
                        return top4.map((p, i) => {
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

                {sort==="rec" && sortedGrid.length>4 && (
                  <p style={{ fontSize:9, fontWeight:700, letterSpacing:"3px", textTransform:"uppercase", color:"#BBB", margin:"8px 0 16px", fontFamily:"'Hanken Grotesk',sans-serif" }}>
                    More options aligned to your brief
                  </p>
                )}
                <div style={S.grid}>
                  {(sort==="rec" ? (() => {
                    const budget = lastFilters?.budget || null;
                    let pool = sortedGrid.slice(0, 16);
                    if (budget) pool = [...pool].sort((a,b) => Math.abs(budget-(a._price||0)) - Math.abs(budget-(b._price||0)));
                    const usedCats = new Set();
                    const picks = [];
                    for (const p of pool) {
                      const cat = (p.category||"other").toLowerCase();
                      if (!usedCats.has(cat)) { usedCats.add(cat); picks.push(p); }
                      if (picks.length === 4) break;
                    }
                    const pickIds = new Set(picks.map(p => p.id));
                    return sortedGrid.filter(p => !pickIds.has(p.id));
                  })() : sortedGrid).map((p,i) => {
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

            {/* Persistent Dove chat panel */}
            {dovePanelJSX}

            {/* Shortlist drawer — only when open */}
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
        const briefChips = homeSummaryChips();
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
          if (isNonEdible) parts.push("non-consumable");
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
                        <span key={i} style={{ fontSize:11, color:"#666", background:SURFACE, border:`1px solid ${BORDER}`, padding:"2px 8px", ...(c.cls==="budget"?{ color:DOVE_BLUE, background:"transparent", border:`1px solid rgba(107,140,174,0.35)`, fontWeight:600 }:{}) }}>{c.label}</span>
                      ))}
                    </div>
                  )}
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", margin:"14px 0 4px" }}>
                    <span style={{ ...S.tierBadge, ...(p.tier==="Gold"?S.tierGold:p.tier==="Platinum"?S.tierPlat:S.tierSilv) }}>{TIER_LABEL[p.tier]||p.tier||""}</span>
                    <button style={{ background:"none", border:"none", fontSize:24, color:isHearted?"#9B3A2A":"#ccc", cursor:"pointer", lineHeight:1 }}
                      onClick={()=>toggleHeart(p)}>{isHearted?"♥":"♡"}</button>
                  </div>
                  <p style={{ fontFamily:"'PT Serif',Georgia,serif", fontSize:24, fontWeight:400, color:DARK, lineHeight:1.25, margin:"0 0 3px" }}>{p.name||""}</p>
                  <p style={{ fontSize:10, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 12px" }}>{p.category||""}</p>
                  <p style={{ fontFamily:"'PT Serif',Georgia,serif", fontSize:26, fontWeight:400, color:DARK, margin:"0 0 14px" }}>₹{price.toLocaleString("en-IN")}</p>
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
                      <p style={{ fontSize:9, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 10px" }}>Also in this edit</p>
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
  homePage: { minHeight:"100vh", display:"flex", flexDirection:"column" },
  homeNav: { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"18px 52px", borderBottom:`1px solid #E8E5DF` },
  hero: { flex:1, display:"flex", gap:0, overflow:"hidden" },
  heroLeft: { flex:"0 0 54%", padding:"36px 52px 32px", display:"flex", flexDirection:"column", justifyContent:"center" },
  heroRight: { flex:"0 0 46%", position:"relative" },
  heroDarkPanel: { position:"absolute", inset:0, background:PANEL_BG, padding:"44px 44px", display:"flex", flexDirection:"column", justifyContent:"center" },
  heroPanelEyebrow: { fontSize:11, fontWeight:600, letterSpacing:"3px", textTransform:"uppercase", color:"rgba(255,255,255,0.3)", margin:"0 0 16px" },
  heroPanelDivider: { height:1, background:"rgba(255,255,255,0.08)", margin:"0 0 28px" },
  heroPanelPills: { display:"flex", flexDirection:"column", gap:16, marginBottom:36 },
  heroPanelPillRow: { display:"flex", alignItems:"flex-start", gap:10 },
  heroPanelPillLabel: { fontSize:14, color:"rgba(255,255,255,0.85)", fontWeight:400, margin:"0 0 2px" },
  heroPanelPillSub: { fontSize:13, color:"rgba(255,255,255,0.45)", fontWeight:300, margin:0 },
  heroPanelStats: { display:"flex", alignItems:"center", gap:24, paddingTop:28, borderTop:"1px solid rgba(255,255,255,0.07)" },
  statNum: { fontFamily:"'PT Serif',Georgia,serif", fontSize:22, fontWeight:400, color:"#fff", margin:"0 0 3px" },
  statLabel: { fontSize:10, color:"rgba(255,255,255,0.35)", letterSpacing:"1px", textTransform:"uppercase", margin:0 },
  trustBar: { borderTop:`1px solid ${BORDER}`, padding:"18px 52px", display:"flex", alignItems:"center", gap:28, flexWrap:"wrap", background:SURFACE },
  trustLabel: { fontSize:12, color:"#888", letterSpacing:"0.3px", flexShrink:0, fontFamily:"'Josefin Sans',sans-serif" },
  trustLogo: { fontSize:12, fontWeight:700, color:"#666", letterSpacing:"1px", textTransform:"uppercase" },
  topBar: { display:"flex", alignItems:"center", gap:16, padding:"0 24px", height:56, borderBottom:`1px solid ${BORDER}`, flexShrink:0, background:"#fff" },
  shortlistBtn: { background:GREEN, color:"#fff", border:"none", padding:"7px 14px", fontFamily:"'Hanken Grotesk',sans-serif", fontSize:9, fontWeight:700, letterSpacing:"2px", textTransform:"uppercase", cursor:"pointer", flexShrink:0 },
  resultsPage: { height:"100vh", display:"flex", flexDirection:"column", overflow:"hidden" },
  gridWrap: { padding:"20px 28px" },
  sortBtn: { fontSize:9, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:"#BBB", background:"none", border:"none", cursor:"pointer", fontFamily:"'Hanken Grotesk',sans-serif", padding:"4px 12px" },
  sortOn: { color:DARK, borderBottom:`1.5px solid ${DARK}`, fontWeight:700 },
  grid: { display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(200px, 1fr))", gap:"28px 20px" },
  topCard: { border:`1px solid #C0CFE0`, background:"#fff", cursor:"pointer", overflow:"hidden" },
  topCardImg: { width:"100%", aspectRatio:"1", position:"relative", overflow:"hidden", background:SURFACE },
  topCardBody: { padding:"14px 14px 18px" },
  topCardName: { fontFamily:"'Hanken Grotesk','Josefin Sans',sans-serif", fontSize:11, fontWeight:700, color:DARK, margin:"6px 0 5px", lineHeight:1.4, letterSpacing:"0.5px", textTransform:"uppercase" },
  topCardPos: { fontFamily:"'Hanken Grotesk',sans-serif", fontSize:10, fontWeight:400, color:"#AAA", margin:"0 0 8px", lineHeight:1.5 },
  topCardPrice: { fontSize:12, fontWeight:700, color:DARK, margin:0, fontFamily:"'Hanken Grotesk',sans-serif", letterSpacing:"0.5px" },
  cardPos: { fontFamily:"'Hanken Grotesk',sans-serif", fontSize:10, fontWeight:400, color:"#AAA", margin:"0 0 5px", lineHeight:1.4 },
  card: { cursor:"pointer" },
  cardImg: { width:"100%", paddingBottom:"116%", position:"relative", overflow:"hidden" },
  heartBtn: { position:"absolute", top:8, right:8, width:28, height:28, background:"rgba(255,255,255,0.9)", border:"none", fontSize:13, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" },
  cardBody: { paddingTop:14, paddingBottom:4 },
  tierBadge: { fontSize:8, fontWeight:700, letterSpacing:"2px", textTransform:"uppercase", display:"inline-block", padding:"2px 0", marginBottom:6, fontFamily:"'Hanken Grotesk',sans-serif", background:"none", border:"none" },
  tierGold: { color:"#9A7B35" },
  tierPlat: { color:"#5A7AAA" },
  tierSilv: { color:"#AAA" },
  cardName: { fontFamily:"'Hanken Grotesk','Josefin Sans',sans-serif", fontSize:10, fontWeight:700, color:DARK, margin:"0 0 4px", lineHeight:1.4, letterSpacing:"0.5px", textTransform:"uppercase" },
  cardPrice: { fontSize:11, fontWeight:700, color:DARK, margin:0, fontFamily:"'Hanken Grotesk',sans-serif", letterSpacing:"0.5px" },
  drawer: { width:272, background:"#fff", borderLeft:`1px solid ${BORDER}`, display:"flex", flexDirection:"column", flexShrink:0 },
  drawerHdr: { padding:"16px 20px 14px", borderBottom:`1px solid ${BORDER}`, display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0 },
  drawerTitle: { fontSize:11, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:DARK, margin:0 },
  slRow: { display:"flex", alignItems:"center", gap:10, padding:"11px 18px", borderBottom:"1px solid #F5F0E8" },
  drawerFtr: { padding:18, borderTop:`1px solid ${BORDER}`, flexShrink:0 },
  btnGreen: { width:"100%", background:GREEN, color:"#fff", border:"none", padding:14, fontFamily:"'Hanken Grotesk',sans-serif", fontSize:10, fontWeight:700, letterSpacing:"2px", textTransform:"uppercase", cursor:"pointer", display:"block" },
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
};
