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

// Dove follow-up prompts shown after directions are displayed
const DOVE_FOLLOWUPS = [
  "Do any of these feel right? Or shall I try a different angle?",
  "I can go more premium, more artisan, or more practical — just say the word.",
  "Want me to focus on one of these directions, or try something completely different?",
];

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
      <span style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:rockSz, fontWeight:700, letterSpacing: size==="xl"?10:4, textTransform:"uppercase", color:DARK, lineHeight:1 }}>Rock</span>
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

  // Dove chat popup state
  const [dovePopupOpen, setDovePopupOpen] = useState(false);
  const [dovePopupMsg, setDovePopupMsg] = useState("");
  const [dovePopupInput, setDovePopupInput] = useState("");
  const [dovePopupLoading, setDovePopupLoading] = useState(false);
  const [dovePopupHistory, setDovePopupHistory] = useState([]);
  const dovePopupTimer = useRef(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token") ||
      window.location.pathname.split("/").pop();
    if (token && token !== "/") loadSession(token);
    else setNotFound(true);
  }, []);

  // Show Dove popup after directions load
  useEffect(() => {
    if (view === "directions" && directions.length > 0) {
      clearTimeout(dovePopupTimer.current);
      dovePopupTimer.current = setTimeout(() => {
        const msg = DOVE_FOLLOWUPS[Math.floor(Math.random() * DOVE_FOLLOWUPS.length)];
        setDovePopupMsg(msg);
        setDovePopupHistory([{ role:"assistant", content: msg }]);
        setDovePopupOpen(true);
      }, 2000);
    }
    return () => clearTimeout(dovePopupTimer.current);
  }, [view, directions]);

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
    setDovePopupOpen(false);
    setView("thinking");
    saveConvo("user", q);
    const allProducts = productsRef.current;

    try {
      setThinkingLabel("Understanding your brief…");
      const doveRes = await fetch(CATALOGUE_URL + "/dove-chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q, conversation_history: intakeHistory, system_override: INTAKE_SYSTEM }),
      });
      const doveData = await doveRes.json();
      const newHistory = [...intakeHistory, { role:"user", content:q }, { role:"assistant", content:doveData.response }];
      setIntakeHistory(newHistory);

      if (!doveData.is_gifting_query) {
        setView("home");
        setThinking(false);
        return;
      }

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
        id: p.id, name: p.name||"", category: p.category||"",
        description: (p.description||"").slice(0,130),
        whats_in_box: Array.isArray(p.whats_in_box) ? p.whats_in_box.join(", ").slice(0,80) : (p.whats_in_box||"").slice(0,80),
        price: priceAtQty(p.pricing_tiers, qty),
        tier: p.tier||"",
        tags: (p._tags||[]).join(", "),
      }));

      setThinkingLabel("Curating your shortlist…");
      const rankRes = await fetch(CATALOGUE_URL + "/dove-rank", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: filters.query||q, budget, exclude_edible: filters.exclude_edible||false, exclude_fragile: filters.exclude_fragile||false, products: candidates }),
      });
      const ranked = await rankRes.json();
      const idOrder = ranked.ranked_ids || [];

      setThinkingLabel("Creating editorial directions…");
      const topCandidates = idOrder.slice(0, 30).map(id => candidates.find(c=>c.id===id)).filter(Boolean);

      const dirRes = await fetch(CATALOGUE_URL + "/dove-directions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: filters.query||q, budget, products: topCandidates }),
      });
      const dirData = await dirRes.json();

      const productMap = {};
      allProducts.forEach(p => { productMap[p.id] = { ...p, _price: priceAtQty(p.pricing_tiers, qty) }; });

      const enrichedDirections = (dirData.directions||[]).map(d => {
        const prods = (d.product_ids||[]).map(id => productMap[id]).filter(Boolean);
        const prices = prods.map(p => p._price||0).filter(v => v > 0);
        return {
          ...d,
          products: prods,
          price_min: prices.length ? Math.min(...prices) : (d.price_min||0),
          price_max: prices.length ? Math.max(...prices) : (d.price_max||0),
        };
      });

      setBriefSummary(ranked.summary || "Here are 3 strong directions for this brief.");
      setDirections(enrichedDirections);
      saveConvo("assistant", ranked.summary||"");
      setView("directions");
    } catch(e) {
      console.error(e);
      setView("home");
    }
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

  // Dove popup chat — handles response and re-searches if needed
  const handleDovePopupSend = async () => {
    const text = dovePopupInput.trim();
    if (!text || dovePopupLoading) return;
    setDovePopupInput("");
    setDovePopupLoading(true);
    saveConvo("user", text);

    try {
      const res = await fetch(CATALOGUE_URL + "/dove-chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          conversation_history: [...intakeHistory, ...dovePopupHistory],
          system_override: INTAKE_SYSTEM,
        }),
      });
      const data = await res.json();
      saveConvo("dove", data.response);

      const newPopupHistory = [...dovePopupHistory, { role:"user", content:text }, { role:"assistant", content:data.response }];
      setDovePopupHistory(newPopupHistory);
      setDovePopupMsg(data.response);

      if (data.ready && data.filters) {
        // New filters — re-run directions
        setDovePopupOpen(false);
        const combined = data.filters.query || text;
        setBrief(combined);
        await handleSearch(combined);
      } else if (!data.ready) {
        // Dove replied but needs more — show reply, keep popup open
        setDovePopupLoading(false);
      }
    } catch(e) {
      setDovePopupMsg("Let me try again — tell me what you'd like to change.");
      setDovePopupLoading(false);
    }
    setDovePopupLoading(false);
  };

  const exploreDirection = (direction) => {
    setActiveDirection(direction);
    setGridProducts(direction.products || []);
    setSort("rec");
    setView("grid");
    setDovePopupOpen(false);
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
      supabase.from("rd_shortlists").insert([{ session_id: session.id, product_id: p.id }]);
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

  if (notFound) return <div style={S.fullCenter}><Logo size="xl" /><p style={S.muted}>This link is invalid or has expired.</p></div>;
  if (!session) return <div style={S.fullCenter}><Logo size="xl" /><p style={S.muted}>Loading…</p></div>;

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
            {p.image_url && <img src={p.image_url} alt={p.name} style={{ width:"100%", height:"100%", objectFit:"cover" }} />}
          </div>
          <div>
            <p style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:15, fontWeight:400, color:DARK, margin:"0 0 3px" }}>{p.name}</p>
            <p style={{ fontSize:13, color:"#aaa", margin:0 }}>₹{(p._price||0).toLocaleString("en-IN")}</p>
          </div>
        </div>
      ))}
    </div>
  );

  const TopBar = () => (
    <div style={S.topBar}>
      <Logo size="sm" onClick={() => setView("home")} />
      <div style={S.refineWrap}>
        <input
          style={S.refineInput}
          value={refineText}
          onChange={e => setRefineText(e.target.value)}
          onKeyDown={e => e.key==="Enter" && handleRefine()}
          placeholder="Refine — e.g. more premium, nothing fragile, under ₹2,000…"
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

  const ShortlistDrawer = () => shortlistOpen ? (
    <div style={S.drawer}>
      <div style={S.drawerHdr}>
        <p style={S.drawerTitle}>Shortlist</p>
        <button style={{ background:"none", border:"none", fontSize:20, color:"#aaa", cursor:"pointer" }} onClick={()=>setShortlistOpen(false)}>×</button>
      </div>
      <div style={{ flex:1, overflowY:"auto" }}>
        {shortlistItems.length===0 ? (
          <p style={{ padding:"28px 20px", fontFamily:"Georgia,serif", fontSize:14, fontStyle:"italic", fontWeight:300, color:"#bbb", textAlign:"center", lineHeight:1.8, margin:0 }}>
            Heart a gift to save it here
          </p>
        ) : shortlistItems.map(p=>(
          <div key={p.id} style={S.slRow}>
            <div style={{ width:40, height:48, background:p._bg||SURFACE, flexShrink:0, overflow:"hidden", cursor:"pointer" }} onClick={()=>setSelectedProduct({...p})}>
              {p.image_url && <img src={p.image_url} alt={p.name||""} style={{ width:"100%", height:"100%", objectFit:"cover" }} onError={e=>{e.target.style.display="none"}} />}
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

  // Dove chat popup — appears on directions page
  const DovePopup = () => dovePopupOpen ? (
    <div style={S.dovePopup}>
      <div style={S.dovePopupHdr}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={S.doveDot}></span>
          <span style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:DOVE_BLUE }}>Dove</span>
        </div>
        <button style={{ background:"none", border:"none", fontSize:18, color:"#aaa", cursor:"pointer", lineHeight:1 }}
          onClick={() => setDovePopupOpen(false)}>×</button>
      </div>
      <div style={S.dovePopupMsg}>
        <p style={{ fontFamily:"Georgia,serif", fontSize:15, fontStyle:"italic", fontWeight:300, color:"#1a1a1a", lineHeight:1.75, margin:0 }}>
          {dovePopupMsg}
        </p>
      </div>
      <div style={S.dovePopupSuggs}>
        {["Yes, explore all three","Try more premium","Nothing edible","Try a different angle"].map((s,i)=>(
          <button key={i} style={S.dovePopupSugg}
            onClick={() => { setDovePopupInput(s); }}>
            {s}
          </button>
        ))}
      </div>
      <div style={S.dovePopupInputRow}>
        <input
          style={S.dovePopupInput}
          value={dovePopupInput}
          onChange={e => setDovePopupInput(e.target.value)}
          onKeyDown={e => e.key==="Enter" && handleDovePopupSend()}
          placeholder="Tell Dove…"
          disabled={dovePopupLoading}
          autoFocus
        />
        <button
          style={{ ...S.dovePopupSendBtn, ...(!dovePopupInput.trim()||dovePopupLoading?{opacity:0.35,cursor:"not-allowed"}:{}) }}
          onClick={handleDovePopupSend}
          disabled={!dovePopupInput.trim()||dovePopupLoading}
        >
          {dovePopupLoading ? "…" : "→"}
        </button>
      </div>
    </div>
  ) : (
    // Collapsed pill — click to reopen
    <button style={S.dovePopupPill} onClick={() => setDovePopupOpen(true)}>
      <span style={S.doveDot}></span>
      <span style={{ fontSize:11, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:DOVE_BLUE }}>Ask Dove</span>
    </button>
  );

  return (
    <div style={{ ...S.app, background:BG }}>

      {/* HOME */}
      {view === "home" && (
        <div style={S.homePage}>
          <div style={S.homeNav}>
            <div style={{ fontSize:10, letterSpacing:"3px", textTransform:"uppercase", color:DOVE_BLUE, fontWeight:600 }}>✦ AI-FIRST</div>
            <Logo size="md" />
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <div style={S.av}>{initials(session.client_name)}</div>
              <div>
                <p style={{ fontSize:12, fontWeight:700, letterSpacing:1, textTransform:"uppercase", fontFamily:"'Playfair Display',Georgia,serif", color:DARK, margin:0 }}>{session.client_name}</p>
                {session.client_company && <p style={{ fontSize:11, color:"#aaa", margin:0 }}>{session.client_company}</p>}
              </div>
            </div>
          </div>
          <p style={S.homeTagline}>Gift Intelligence by Ikka Dukka</p>

          <div style={S.hero}>
            <div style={S.heroLeft}>
              <h1 style={S.heroH1}>
                Tell me what you need.<br/>
                <em style={{ color:DOVE_BLUE }}>I'll take it from there.</em>
                <span style={{ fontSize:22, marginLeft:8, color:DOVE_BLUE }}>✦</span>
              </h1>
              <p style={S.heroSub}>One line is enough. Our AI gets the nuance.</p>

              <div style={S.inputBox}>
                <textarea
                  style={S.homeInput}
                  value={brief}
                  onChange={e => setBrief(e.target.value)}
                  onKeyDown={e => { if (e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); handleSearch(); }}}
                  placeholder="e.g. 50 senior bankers, Diwali, ₹3,000 budget"
                  rows={2}
                  autoFocus
                />
                <button
                  style={{ ...S.homeBtn, ...(!brief.trim()||thinking?{opacity:0.4,cursor:"not-allowed"}:{}) }}
                  onClick={() => handleSearch()}
                  disabled={!brief.trim()||thinking}
                >
                  {thinking ? "…" : "→"}
                </button>
              </div>

              <div style={S.inputMeta}>
                <span style={S.metaPill}><span style={{ color:DOVE_BLUE }}>✦</span> Understands budget, scale, occasions, constraints</span>
                <span style={S.metaDivider}>·</span>
                <span style={S.metaPill}>Results in seconds</span>
              </div>

              <div style={S.quickStarts}>
                <p style={S.quickStartLabel}>NEED INSPIRATION? TRY THESE</p>
                <div style={{ display:"flex", gap:10 }}>
                  {QUICK_STARTS.map((q,i)=>(
                    <button key={i} style={S.quickChip} onClick={() => handleSearch(q.label)}>
                      {q.label} →
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div style={S.heroRight}>
              <div style={S.heroDarkPanel}>
                <p style={S.heroPanelEyebrow}>Ikka Dukka</p>
                <p style={S.heroPanelHed}>Gifts that say<br/>the right things.</p>
                <div style={S.heroPanelPills}>
                  {["Curated by AI","Refined by experts","Chosen with purpose"].map((t,i)=>(
                    <span key={i} style={S.heroPanelPill}>{t}</span>
                  ))}
                </div>
                <div style={S.heroPanelStats}>
                  <div><p style={S.statNum}>160+</p><p style={S.statLabel}>curated gifts</p></div>
                  <div style={{ width:1, background:"rgba(255,255,255,0.1)", alignSelf:"stretch" }}></div>
                  <div><p style={S.statNum}>24hrs</p><p style={S.statLabel}>turnaround</p></div>
                  <div style={{ width:1, background:"rgba(255,255,255,0.1)", alignSelf:"stretch" }}></div>
                  <div><p style={S.statNum}>India's</p><p style={S.statLabel}>finest makers</p></div>
                </div>
              </div>
            </div>
          </div>

          <div style={S.trustBar}>
            <span style={S.trustLabel}>Trusted by teams at leading organisations</span>
            {TRUST_LOGOS.map((l,i)=>(
              <span key={i} style={S.trustLogo}>{l}</span>
            ))}
          </div>
        </div>
      )}

      {/* THINKING */}
      {view === "thinking" && (
        <div style={S.fullCenter}>
          <Logo size="xl" />
          <p style={{ fontFamily:"Georgia,serif", fontSize:19, fontStyle:"italic", fontWeight:300, color:"#888", marginTop:48, lineHeight:1.8 }}>
            {thinkingLabel}
          </p>
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

      {/* DIRECTIONS */}
      {view === "directions" && (
        <div style={{ ...S.resultsPage, background:BG }}>
          <TopBar />
          <div style={{ flex:1, overflowY:"auto" }}>
            <div style={S.directionsWrap}>
              <div style={S.directionsHdr}>
                <div>
                  <p style={S.directionsEyebrow}>YOUR BRIEF, UNDERSTOOD</p>
                  <h2 style={S.directionsH2}>
                    Here are <em style={{ color:DOVE_BLUE }}>{directions.length} strong directions</em> for this brief.
                  </h2>
                  {briefSummary && <p style={S.directionsSummary}>{briefSummary}</p>}
                </div>
              </div>

              <div style={S.directionCards}>
                {directions.map((d,i) => (
                  <div key={i} style={S.dirCard}>
                    <div style={S.dirCardImg}>
                      {d.products?.slice(0,2).map((p,j) => (
                        <div key={j} style={{ ...S.dirCardThumb, background:p._bg||SURFACE }}>
                          {p.image_url && <img src={p.image_url} alt={p.name||""} style={{ width:"100%", height:"100%", objectFit:"cover" }} onError={e=>{e.target.style.display="none"}} />}
                        </div>
                      ))}
                    </div>
                    <div style={S.dirCardBody}>
                      <p style={S.dirCardNum}>DIRECTION {d.number}</p>
                      <p style={S.dirCardName}>{d.name}</p>
                      <p style={S.dirCardTagline}>{d.tagline}</p>
                      <p style={S.dirCardDesc}>{d.description}</p>
                      <p style={S.dirCardPrice}>
                        ₹{(d.price_min||0).toLocaleString("en-IN")} – ₹{(d.price_max||0).toLocaleString("en-IN")}
                      </p>
                      <p style={S.dirCardCount}>{d.products?.length||0} gifts in this edit</p>
                    </div>
                    <button style={S.exploreBtn} onClick={() => exploreDirection(d)}>
                      Explore →
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
          {/* Dove popup — always visible on directions page */}
          <DovePopup />
        </div>
      )}

      {/* GRID */}
      {view === "grid" && (
        <div style={{ ...S.resultsPage, background:BG }}>
          <TopBar />
          <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
            <div style={{ flex:1, overflowY:"auto" }}>
              <div style={S.gridWrap}>
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:20 }}>
                  <button style={S.backLink} onClick={() => setView("directions")}>← All directions</button>
                  <span style={{ color:"#ddd" }}>·</span>
                  {activeDirection && (
                    <span style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:15, fontWeight:400, color:DARK }}>{activeDirection.name}</span>
                  )}
                </div>

                {activeDirection && (
                  <div style={S.dirBanner}>
                    <div>
                      <p style={S.dirBannerName}>{activeDirection.name}</p>
                      <p style={S.dirBannerTagline}>{activeDirection.tagline}</p>
                    </div>
                    <div style={{ display:"flex", gap:4 }}>
                      {[["rec","Recommended"],["asc","Price ↑"],["desc","Price ↓"]].map(([v,l])=>(
                        <button key={v} style={{ ...S.sortBtn, ...(sort===v?S.sortOn:{}) }} onClick={()=>setSort(v)}>{l}</button>
                      ))}
                    </div>
                  </div>
                )}

                <p style={{ fontSize:11, color:"#bbb", letterSpacing:"1px", textTransform:"uppercase", marginBottom:20 }}>
                  {sortedGrid.length} gifts in this direction
                </p>

                <div style={S.grid}>
                  {sortedGrid.map(p=>(
                    <div key={p.id} style={S.card}>
                      <div style={{ ...S.cardImg, background:p._bg||SURFACE }}
                        onClick={()=>{ setSelectedProduct({...p}); logEvent("product_view",p.id); }}>
                        {p.image_url ? (
                          <img src={p.image_url} alt={p.name||""} style={{ position:"absolute", inset:0, width:"100%", height:"100%", objectFit:"cover" }} onError={e=>{e.target.style.display="none"}} />
                        ) : (
                          <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                            <span style={{ fontSize:10, letterSpacing:"2px", color:"#bbb", textTransform:"uppercase" }}>{p.category}</span>
                          </div>
                        )}
                        <button style={{ ...S.heartBtn, color:hearted.has(p.id)?"#9B3A2A":"#bbb" }}
                          onClick={e=>{ e.stopPropagation(); toggleHeart(p); }}>
                          {hearted.has(p.id)?"♥":"♡"}
                        </button>
                      </div>
                      <div style={S.cardBody} onClick={()=>{ setSelectedProduct({...p}); logEvent("product_view",p.id); }}>
                        <span style={{ ...S.tierBadge, ...(p.tier==="Gold"?S.tierGold:p.tier==="Platinum"?S.tierPlat:S.tierSilv) }}>
                          {TIER_LABEL[p.tier]||p.tier}
                        </span>
                        <p style={S.cardName}>{p.name||""}</p>
                        <p style={S.cardCat}>{p.category||""}</p>
                        <p style={S.cardPrice}>₹{(p._price||0).toLocaleString("en-IN")}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <ShortlistDrawer />
          </div>
        </div>
      )}

      {/* MODAL — square image */}
      {selectedProduct?.id && (() => {
        const p = selectedProduct;
        const price = p._price || 0;
        const boxContents = formatBox(p.whats_in_box);
        const isHearted = hearted.has(p.id);
        return (
          <div style={S.modalOverlay} onClick={()=>setSelectedProduct(null)}>
            <div style={S.modalBox} onClick={e=>e.stopPropagation()}>
              <button style={S.modalClose} onClick={()=>setSelectedProduct(null)}>×</button>
              <div style={S.modalInner}>
                {/* Square image panel */}
                <div style={S.modalImgWrap}>
                  {p.image_url ? (
                    <img src={p.image_url} alt={p.name||""} style={{ width:"100%", height:"100%", objectFit:"contain", display:"block", background:p._bg||SURFACE }} onError={e=>{e.target.style.display="none"}} />
                  ) : (
                    <div style={{ width:"100%", height:"100%", background:p._bg||SURFACE, display:"flex", alignItems:"center", justifyContent:"center" }}>
                      <span style={{ fontSize:10, letterSpacing:"2px", color:"#bbb", textTransform:"uppercase" }}>{p.category||""}</span>
                    </div>
                  )}
                </div>
                <div style={S.modalContent}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
                    <span style={{ ...S.tierBadge, ...(p.tier==="Gold"?S.tierGold:p.tier==="Platinum"?S.tierPlat:S.tierSilv) }}>
                      {TIER_LABEL[p.tier]||p.tier||""}
                    </span>
                    <button style={{ background:"none", border:"none", fontSize:26, color:isHearted?"#9B3A2A":"#ccc", cursor:"pointer", lineHeight:1 }}
                      onClick={()=>toggleHeart(p)}>{isHearted?"♥":"♡"}</button>
                  </div>
                  <p style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:26, fontWeight:400, color:DARK, lineHeight:1.25, margin:"0 0 6px" }}>{p.name||""}</p>
                  <p style={{ fontSize:11, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 18px" }}>{p.category||""}</p>
                  <p style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:28, fontWeight:400, color:DARK, margin:"0 0 22px" }}>₹{price.toLocaleString("en-IN")}</p>
                  {p.description && <p style={{ fontFamily:"Georgia,serif", fontSize:16, fontWeight:300, color:"#444", lineHeight:1.85, margin:"0 0 22px" }}>{String(p.description)}</p>}
                  {boxContents && (
                    <div style={{ marginBottom:20, paddingBottom:18, borderBottom:`1px solid ${BORDER}` }}>
                      <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 8px" }}>What's in the box</p>
                      <p style={{ fontFamily:"Georgia,serif", fontSize:15, fontWeight:300, color:"#555", lineHeight:1.8, margin:0 }}>{boxContents}</p>
                    </div>
                  )}
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"14px 24px", marginBottom:26 }}>
                    {p.moq && <div><p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 5px" }}>Min. Order</p><p style={{ fontSize:14, color:"#333", margin:0 }}>{p.moq} units</p></div>}
                    {p.lead_time && <div><p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 5px" }}>Lead Time</p><p style={{ fontSize:14, color:"#333", margin:0 }}>{String(p.lead_time)}</p></div>}
                    {p.box_dimensions && <div><p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 5px" }}>Dimensions</p><p style={{ fontSize:14, color:"#333", margin:0 }}>{String(p.box_dimensions)}</p></div>}
                    {p.weight_grams && <div><p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 5px" }}>Weight</p><p style={{ fontSize:14, color:"#333", margin:0 }}>{p.weight_grams}g</p></div>}
                  </div>
                  <button style={{ ...S.btnGreen, ...(isHearted?{background:"#9B3A2A",boxShadow:"0 4px 0 #e8b4a8"}:{}) }}
                    onClick={()=>toggleHeart(p)}>
                    {isHearted?"♥  Saved to shortlist":"♡  Save to shortlist"}
                  </button>
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
  homeNav: { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"20px 48px", borderBottom:`1px solid ${BORDER}` },
  homeTagline: { fontSize:10, letterSpacing:"3px", textTransform:"uppercase", color:"#bbb", textAlign:"center", margin:"12px 0 0", fontWeight:300 },
  hero: { flex:1, display:"flex", gap:0, overflow:"hidden" },
  heroLeft: { flex:"0 0 52%", padding:"52px 48px 40px", display:"flex", flexDirection:"column", justifyContent:"center" },
  heroH1: { fontFamily:"'Playfair Display',Georgia,serif", fontSize:42, fontWeight:700, color:"#111", lineHeight:1.2, margin:"0 0 16px", letterSpacing:-0.5 },
  heroSub: { fontSize:15, fontWeight:300, color:"#888", margin:"0 0 32px", letterSpacing:"0.3px" },
  inputBox: { display:"flex", alignItems:"flex-end", border:"1.5px solid #111", background:"#fff", marginBottom:14 },
  homeInput: { flex:1, border:"none", outline:"none", resize:"none", padding:"16px 20px 10px", fontFamily:"Georgia,serif", fontSize:17, fontWeight:300, color:"#111", lineHeight:1.7, background:"transparent" },
  homeBtn: { width:52, height:52, background:"#111", border:"none", cursor:"pointer", color:"#fff", fontSize:20, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, alignSelf:"flex-end" },
  inputMeta: { display:"flex", alignItems:"center", gap:8, marginBottom:32 },
  metaPill: { fontSize:12, color:"#aaa", fontWeight:300 },
  metaDivider: { color:"#ddd" },
  quickStarts: { marginTop:"auto" },
  quickStartLabel: { fontSize:9, fontWeight:600, letterSpacing:"2.5px", color:"#ccc", margin:"0 0 12px" },
  quickChip: { fontFamily:"Georgia,serif", fontSize:13, fontWeight:300, fontStyle:"italic", color:"#777", background:"none", border:`1px solid ${BORDER}`, padding:"6px 14px", cursor:"pointer", lineHeight:1.4, whiteSpace:"nowrap" },
  heroRight: { flex:"0 0 48%", position:"relative" },
  heroDarkPanel: { position:"absolute", inset:0, background:"#1a1a1a", padding:"52px 44px", display:"flex", flexDirection:"column", justifyContent:"center" },
  heroPanelEyebrow: { fontSize:11, fontWeight:600, letterSpacing:"3px", textTransform:"uppercase", color:"rgba(255,255,255,0.35)", margin:"0 0 20px" },
  heroPanelHed: { fontFamily:"'Playfair Display',Georgia,serif", fontSize:36, fontWeight:400, color:"#fff", lineHeight:1.25, margin:"0 0 32px" },
  heroPanelPills: { display:"flex", flexDirection:"column", gap:10, marginBottom:48 },
  heroPanelPill: { fontSize:13, color:"rgba(255,255,255,0.55)", fontWeight:300 },
  heroPanelStats: { display:"flex", alignItems:"center", gap:28, paddingTop:32, borderTop:"1px solid rgba(255,255,255,0.08)" },
  statNum: { fontFamily:"'Playfair Display',Georgia,serif", fontSize:24, fontWeight:400, color:"#fff", margin:"0 0 3px" },
  statLabel: { fontSize:11, color:"rgba(255,255,255,0.4)", letterSpacing:"1px", textTransform:"uppercase", margin:0 },
  trustBar: { borderTop:`1px solid ${BORDER}`, padding:"18px 48px", display:"flex", alignItems:"center", gap:28, flexWrap:"wrap", background:SURFACE },
  trustLabel: { fontSize:11, color:"#bbb", letterSpacing:"0.5px", flexShrink:0 },
  trustLogo: { fontSize:12, fontWeight:600, color:"#aaa", letterSpacing:"0.5px", textTransform:"uppercase" },

  topBar: { display:"flex", alignItems:"center", gap:16, padding:"0 24px", height:56, borderBottom:`1px solid ${BORDER}`, flexShrink:0, background:"#fff" },
  refineWrap: { flex:1, display:"flex", border:`1px solid ${BORDER}`, height:36 },
  refineInput: { flex:1, border:"none", outline:"none", padding:"7px 14px", fontFamily:"Georgia,serif", fontSize:14, fontWeight:300, color:"#111", background:"transparent" },
  refineBtn: { padding:"0 16px", background:GREEN, border:"none", cursor:"pointer", color:"#fff", fontSize:12, fontWeight:600, letterSpacing:"1px", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontFamily:"'Josefin Sans',sans-serif", whiteSpace:"nowrap" },
  shortlistBtn: { background:GREEN, color:"#fff", border:"none", padding:"7px 14px", fontFamily:"'Josefin Sans',sans-serif", fontSize:11, fontWeight:600, letterSpacing:"1px", cursor:"pointer", flexShrink:0, boxShadow:"0 3px 0 #a8d4b4" },

  resultsPage: { height:"100vh", display:"flex", flexDirection:"column", overflow:"hidden" },
  directionsWrap: { maxWidth:1100, margin:"0 auto", padding:"48px 32px" },
  directionsHdr: { marginBottom:36 },
  directionsEyebrow: { fontSize:10, fontWeight:600, letterSpacing:"3px", textTransform:"uppercase", color:"#bbb", margin:"0 0 10px" },
  directionsH2: { fontFamily:"'Playfair Display',Georgia,serif", fontSize:32, fontWeight:700, color:DARK, margin:"0 0 8px", lineHeight:1.2 },
  directionsSummary: { fontFamily:"Georgia,serif", fontSize:15, fontStyle:"italic", fontWeight:300, color:"#888", margin:0 },
  directionCards: { display:"grid", gridTemplateColumns:"repeat(3, 1fr)", gap:24 },
  dirCard: { border:`1px solid ${BORDER}`, background:"#fff", display:"flex", flexDirection:"column", overflow:"hidden" },
  dirCardImg: { display:"flex", height:220, overflow:"hidden" },
  dirCardThumb: { flex:1, overflow:"hidden" },
  dirCardBody: { padding:"24px 24px 16px", flex:1 },
  dirCardNum: { fontSize:9, fontWeight:600, letterSpacing:"3px", textTransform:"uppercase", color:DOVE_BLUE, margin:"0 0 8px" },
  dirCardName: { fontFamily:"'Playfair Display',Georgia,serif", fontSize:22, fontWeight:400, color:DARK, margin:"0 0 6px", lineHeight:1.2 },
  dirCardTagline: { fontFamily:"Georgia,serif", fontSize:14, fontStyle:"italic", fontWeight:300, color:"#666", margin:"0 0 10px", lineHeight:1.6 },
  dirCardDesc: { fontSize:13, fontWeight:300, color:"#aaa", margin:"0 0 16px", lineHeight:1.5 },
  dirCardPrice: { fontFamily:"'Playfair Display',Georgia,serif", fontSize:18, fontWeight:400, color:DARK, margin:"0 0 4px" },
  dirCardCount: { fontSize:11, color:"#bbb", letterSpacing:"0.5px", margin:0 },
  exploreBtn: { margin:"0 24px 24px", padding:"12px 0", background:DARK, color:"#fff", border:"none", cursor:"pointer", fontFamily:"'Josefin Sans',sans-serif", fontSize:12, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase" },

  gridWrap: { padding:"24px 28px" },
  backLink: { fontSize:12, color:"#aaa", background:"none", border:"none", cursor:"pointer", fontFamily:"'Josefin Sans',sans-serif", letterSpacing:"0.5px", padding:0 },
  dirBanner: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20, paddingBottom:20, borderBottom:`1px solid ${BORDER}` },
  dirBannerName: { fontFamily:"'Playfair Display',Georgia,serif", fontSize:22, fontWeight:400, color:DARK, margin:"0 0 4px" },
  dirBannerTagline: { fontFamily:"Georgia,serif", fontSize:14, fontStyle:"italic", fontWeight:300, color:"#888", margin:0 },
  sortBtn: { fontSize:11, color:"#bbb", background:"none", border:"none", cursor:"pointer", fontFamily:"'Josefin Sans',sans-serif", padding:"4px 10px" },
  sortOn: { color:DARK, borderBottom:`1.5px solid ${DARK}` },
  grid: { display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(190px, 1fr))", gap:"24px 14px" },
  card: { cursor:"pointer" },
  cardImg: { width:"100%", paddingBottom:"116%", position:"relative", overflow:"hidden" },
  heartBtn: { position:"absolute", top:8, right:8, width:28, height:28, background:"rgba(255,255,255,0.9)", border:"none", fontSize:13, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" },
  cardBody: { paddingTop:10 },
  tierBadge: { fontSize:9, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", display:"inline-block", padding:"2px 8px", marginBottom:7 },
  tierGold: { color:"#7a5c20", background:"#fdf5e6", border:"1px solid #e8d5a0" },
  tierPlat: { color:"#2a4a7a", background:"#eef3fa", border:"1px solid #b8cce8" },
  tierSilv: { color:"#666", background:"#f5f5f5", border:"1px solid #e0e0e0" },
  cardName: { fontFamily:"'Playfair Display',Georgia,serif", fontSize:16, fontWeight:400, color:DARK, margin:"0 0 3px", lineHeight:1.3 },
  cardCat: { fontSize:10, letterSpacing:"1.5px", textTransform:"uppercase", color:"#bbb", margin:"0 0 7px" },
  cardPrice: { fontSize:14, fontWeight:600, color:DARK, margin:0 },

  drawer: { width:272, background:"#fff", borderLeft:`1px solid ${BORDER}`, display:"flex", flexDirection:"column", flexShrink:0 },
  drawerHdr: { padding:"16px 20px 14px", borderBottom:`1px solid ${BORDER}`, display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0 },
  drawerTitle: { fontSize:11, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:DARK, margin:0 },
  slRow: { display:"flex", alignItems:"center", gap:10, padding:"11px 18px", borderBottom:"1px solid #F5F0E8" },
  drawerFtr: { padding:18, borderTop:`1px solid ${BORDER}`, flexShrink:0 },
  btnGreen: { width:"100%", background:GREEN, color:"#fff", border:"none", padding:14, fontFamily:"'Josefin Sans',sans-serif", fontSize:11, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", cursor:"pointer", boxShadow:"0 4px 0 #a8d4b4", display:"block" },

  // Dove popup
  doveDot: { display:"inline-block", width:7, height:7, borderRadius:"50%", background:DOVE_BLUE, flexShrink:0 },
  dovePopup: {
    position:"fixed", bottom:28, right:32, width:320,
    background:"#fff", border:`1.5px solid ${DOVE_BLUE}`,
    boxShadow:"0 8px 32px rgba(0,0,0,0.12)",
    zIndex:200, display:"flex", flexDirection:"column",
  },
  dovePopupHdr: { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"14px 16px 10px", borderBottom:`1px solid ${BORDER}` },
  dovePopupMsg: { padding:"16px 16px 10px" },
  dovePopupSuggs: { display:"flex", flexWrap:"wrap", gap:6, padding:"0 16px 12px" },
  dovePopupSugg: { fontFamily:"Georgia,serif", fontSize:12, fontStyle:"italic", fontWeight:300, color:DOVE_BLUE, background:"none", border:`1px solid #d0dde8`, padding:"4px 10px", cursor:"pointer", lineHeight:1.4 },
  dovePopupInputRow: { display:"flex", borderTop:`1px solid ${BORDER}` },
  dovePopupInput: { flex:1, border:"none", outline:"none", padding:"11px 14px", fontFamily:"Georgia,serif", fontSize:14, fontWeight:300, color:"#111", background:"transparent" },
  dovePopupSendBtn: { width:44, background:DOVE_BLUE, border:"none", cursor:"pointer", color:"#fff", fontSize:17, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  dovePopupPill: { position:"fixed", bottom:28, right:32, display:"flex", alignItems:"center", gap:8, background:"#fff", border:`1.5px solid ${DOVE_BLUE}`, padding:"10px 18px", cursor:"pointer", boxShadow:"0 4px 16px rgba(107,140,174,0.2)", zIndex:200, fontFamily:"'Josefin Sans',sans-serif" },

  // Modal — square image
  modalOverlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:500, padding:32 },
  modalBox: { background:"#fff", width:"100%", maxWidth:820, maxHeight:"90vh", overflow:"hidden", position:"relative", display:"flex", flexDirection:"column" },
  modalClose: { position:"absolute", top:12, right:16, background:"none", border:"none", fontSize:28, color:"#aaa", cursor:"pointer", lineHeight:1, zIndex:10 },
  modalInner: { display:"flex", flex:1, overflow:"hidden" },
  // Square: explicit width and height equal, objectFit:contain so nothing is cropped
  modalImgWrap: { width:380, height:380, minWidth:380, flexShrink:0, background:SURFACE, overflow:"hidden" },
  modalContent: { flex:1, padding:"32px 28px", overflowY:"auto" },
};
