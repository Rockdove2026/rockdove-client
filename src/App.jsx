import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase.js";

const CATALOGUE_URL = import.meta.env.VITE_CATALOGUE_SERVICE_URL ||
  "https://ikka-catalogue-service-production.up.railway.app";

const BG_COLORS = ["#F5EFE8","#EDF2EE","#EEF0F7","#F7EEF0","#F0EDE8","#EEF5F2","#F5F0E8","#EEF1F7","#F2EEF5"];
const TIER_LABEL = { Gold:"Gold", Silver:"Silver", Platinum:"Platinum" };
const SUGGESTIONS = [
  "Diwali gifts for 50 senior bankers, around ₹3,000 each",
  "Something thoughtful for a client who loves wellness",
  "Premium client thank-you, nothing edible, needs to be couriered",
  "Onboarding gift for new joiners under ₹1,500",
];

function priceAtQty(tiers, qty) {
  if (!tiers?.length) return 0;
  try {
    const match = tiers.filter(t => qty >= t.min_qty && (t.max_qty===null||qty<=t.max_qty)).sort((a,b)=>b.min_qty-a.min_qty)[0];
    return match ? parseFloat(match.price_per_unit) : parseFloat(tiers[0].price_per_unit);
  } catch { return 0; }
}

function initials(name) { return name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase(); }
function formatBox(text) {
  if (!text) return "";
  return text.replace(/([a-z])([A-Z])/g,"$1 · $2").replace(/\s*,\s*/g," · ").replace(/\s*\|\s*/g," · ");
}

export default function App() {
  const [session, setSession] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const productsRef = useRef([]);

  // Search state
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [aiSummary, setAiSummary] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [chips, setChips] = useState([]);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [sort, setSort] = useState("rec");
  const [view, setView] = useState("home"); // home | results | submitted

  // Shortlist
  const [hearted, setHearted] = useState(new Set());
  const heartedRef = useRef({});
  const [shortlistOpen, setShortlistOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Product detail
  const [selectedProduct, setSelectedProduct] = useState(null);

  const queryInputRef = useRef(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token") ||
      window.location.pathname.split("/").pop();
    if (token && token !== "/") loadSession(token);
    else setNotFound(true);
  }, []);

  const loadSession = async (token) => {
    try {
      const { data, error } = await supabase.from("rd_sessions").select("*").eq("token", token).single();
      if (error || !data) { setNotFound(true); return; }
      setSession(data);
      supabase.from("rd_sessions").update({ last_active: new Date().toISOString() }).eq("id", data.id);
      await loadProducts();
      loadShortlist(data.id);
    } catch(e) { setNotFound(true); }
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
          ...p,
          _bg: BG_COLORS[i % BG_COLORS.length],
          _price: priceAtQty(p.pricing_tiers, 1),
          _tags: (p.product_tags||[]).map(t=>(t.tag||"").toLowerCase()).filter(Boolean),
        }));
      }
    } catch(e) { console.error(e); }
  };

  const loadShortlist = async (sessionId) => {
    try {
      const { data } = await supabase.from("rd_shortlists").select("product_id").eq("session_id", sessionId);
      if (data) setHearted(new Set(data.map(r => r.product_id)));
    } catch {}
  };

  const logEvent = useCallback(async (type, pid=null, meta={}) => {
    if (!session) return;
    try { await supabase.from("rd_events").insert([{ session_id: session.id, event_type: type, product_id: pid, metadata: meta }]); } catch {}
  }, [session]);

  const saveConvo = useCallback(async (role, message) => {
    if (!session) return;
    try { await supabase.from("rd_conversations").insert([{ session_id: session.id, role, message }]); } catch {}
  }, [session]);

  const handleSearch = async (q) => {
    const searchQ = q || query;
    if (!searchQ.trim() || searching) return;
    setQuery(searchQ);
    setSearching(true);
    setFollowUp("");
    setView("results");
    saveConvo("user", searchQ);

    const allProducts = productsRef.current;

    try {
      // Call Dove AI to interpret the query
      const doveRes = await fetch(CATALOGUE_URL + "/dove-chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: searchQ, conversation_history: conversationHistory }),
      });
      const doveData = await doveRes.json();

      // Update conversation history
      const newHistory = [
        ...conversationHistory,
        { role: "user", content: searchQ },
        { role: "assistant", content: doveData.response },
      ];
      setConversationHistory(newHistory);
      saveConvo("dove", doveData.response);

      // If Dove has a follow-up question, show it softly
      if (!doveData.ready && doveData.response && !doveData.response.toLowerCase().includes("hello")) {
        setFollowUp(doveData.response);
      }

      const filters = doveData.filters || {};
      const qty = filters.qty || 1;
      const budget = filters.budget || null;

      // Build chips
      const newChips = [];
      if (filters.occasion && filters.occasion !== "other") newChips.push(filters.occasion.toUpperCase().replace(/-/g," "));
      if (filters.audience && filters.audience !== "other") newChips.push(filters.audience.toUpperCase().replace(/-/g," "));
      if (budget) newChips.push(`₹${budget.toLocaleString("en-IN")} / UNIT`);
      if (filters.exclude_edible) newChips.push({ label:"NON-EDIBLE", muted:true });
      if (filters.exclude_fragile) newChips.push({ label:"NON-FRAGILE", muted:true });
      setChips(newChips);

      // Pre-filter
      const candidates = allProducts.filter(p => {
        const price = priceAtQty(p.pricing_tiers, qty);
        if (budget && price > budget * 1.2) return false;
        if (filters.exclude_edible && p.edible) return false;
        if (filters.exclude_fragile && p.fragile) return false;
        return true;
      }).map(p => ({
        id: p.id, name: p.name||"", category: p.category||"",
        description: (p.description||"").slice(0,150),
        whats_in_box: (p.whats_in_box||"").slice(0,100),
        price: priceAtQty(p.pricing_tiers, qty),
        tier: p.tier||"",
        tags: (p._tags||[]).join(", "),
      }));

      // Claude ranks
      const rankRes = await fetch(CATALOGUE_URL + "/dove-rank", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brief: searchQ,
          budget: filters.budget || null,
          exclude_edible: filters.exclude_edible || false,
          exclude_fragile: filters.exclude_fragile || false,
          products: candidates,
        }),
      });
      const ranked = await rankRes.json();
      setAiSummary(ranked.summary || "");
      saveConvo("assistant", ranked.summary || "");

      const idOrder = ranked.ranked_ids || [];
      const productMap = {};
      allProducts.forEach(p => { productMap[p.id] = { ...p, _price: priceAtQty(p.pricing_tiers, qty) }; });

      const ordered = idOrder.map(id => productMap[id]).filter(Boolean);
      const rankedSet = new Set(idOrder);
      const rest = candidates.filter(c=>!rankedSet.has(c.id)).map(c=>productMap[c.id]).filter(Boolean);
      setResults([...ordered, ...rest]);
      setSort("rec");

      // If Dove is ready, clear follow-up
      if (doveData.ready) setFollowUp("");

    } catch(e) {
      console.error(e);
      setResults(allProducts.map(p=>({...p, _price:priceAtQty(p.pricing_tiers,1)})));
      setAiSummary("Here are our curated gifts.");
    }
    setSearching(false);
  };

  const toggleHeart = async (p) => {
    if (!session || !p?.id) return;
    const productId = p.id;
    const isHearted = hearted.has(productId);
    const newHearted = new Set(hearted);
    if (isHearted) {
      newHearted.delete(productId);
      delete heartedRef.current[productId];
      supabase.from("rd_shortlists").delete().eq("session_id", session.id).eq("product_id", productId);
      logEvent("shortlist_remove", productId);
    } else {
      newHearted.add(productId);
      heartedRef.current[productId] = p;
      supabase.from("rd_shortlists").insert([{ session_id: session.id, product_id: productId }]);
      logEvent("shortlist_add", productId);
      setShortlistOpen(true);
    }
    setHearted(newHearted);
  };

  const submitShortlist = async () => {
    if (!session || hearted.size===0) return;
    setSubmitting(true);
    logEvent("shortlist_submit", null, { product_ids: [...hearted], count: hearted.size });
    setTimeout(() => { setView("submitted"); setSubmitting(false); }, 800);
  };

  const sortedResults = [...results].sort((a,b) => {
    if (sort==="asc") return (a._price||0)-(b._price||0);
    if (sort==="desc") return (b._price||0)-(a._price||0);
    return 0;
  });

  const shortlistItems = [...hearted].map(id => heartedRef.current[id] || results.find(p=>p.id===id)).filter(Boolean);
  const totalEstimate = shortlistItems.reduce((s,p)=>s+(p._price||0),0);

  const S = styles;

  if (notFound) return (
    <div style={S.fullCenter}>
      <BigLogo />
      <p style={{ fontSize:15, color:"#888", marginTop:28, fontFamily:"Georgia,serif", fontWeight:300 }}>This link is invalid or has expired.</p>
    </div>
  );

  if (!session) return (
    <div style={S.fullCenter}>
      <BigLogo />
      <p style={{ fontSize:11, color:"#bbb", letterSpacing:"3px", textTransform:"uppercase", marginTop:24, fontFamily:"'Josefin Sans',sans-serif" }}>Loading…</p>
    </div>
  );

  if (view === "submitted") return (
    <div style={S.fullCenter}>
      <div style={{ width:52, height:52, borderRadius:"50%", background:"#2C5F3A", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, marginBottom:24 }}>✓</div>
      <p style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:28, fontWeight:400, color:"#111", margin:"0 0 10px" }}>Shortlist sent</p>
      <p style={{ fontFamily:"Georgia,serif", fontSize:17, fontWeight:300, color:"#888", maxWidth:380, lineHeight:1.8, margin:"0 0 32px", textAlign:"center" }}>
        Thank you, {session.client_name.split(" ")[0]}. We'll follow up within 24 hours with availability and final pricing.
      </p>
      <div style={{ width:"100%", maxWidth:400 }}>
        {shortlistItems.map(p=>(
          <div key={p.id} style={{ display:"flex", alignItems:"center", gap:14, padding:"12px 0", borderBottom:"1px solid #f0f0f0" }}>
            <div style={{ width:44, height:54, background:p._bg||"#f5f0eb", flexShrink:0, overflow:"hidden" }}>
              {p.image_url && <img src={p.image_url} alt={p.name} style={{ width:"100%", height:"100%", objectFit:"cover" }} />}
            </div>
            <div>
              <p style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:16, fontWeight:400, color:"#111", margin:"0 0 3px" }}>{p.name}</p>
              <p style={{ fontSize:13, color:"#aaa", margin:0 }}>₹{(p._price||0).toLocaleString("en-IN")}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div style={S.app}>

      {/* ── HOME ── */}
      {view === "home" && (
        <div style={S.homePage}>
          <div style={S.homeCenter}>
            <BigLogo />
            <p style={S.homeTagline}>by Ikka Dukka · Gift Intelligence</p>
            <p style={S.homeGreeting}>
              Hello {session.client_name.split(" ")[0]} — what would you like to gift today?
            </p>

            <div style={S.homeInputWrap}>
              <textarea
                ref={queryInputRef}
                style={S.homeTextarea}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); handleSearch(); } }}
                placeholder="Tell us what you're looking for…"
                rows={2}
                autoFocus
              />
              <button
                style={{ ...S.homeSearchBtn, ...(!query.trim()||searching?{ opacity:0.4, cursor:"not-allowed" }:{}) }}
                onClick={() => handleSearch()}
                disabled={!query.trim()||searching}
              >
                {searching ? "Searching…" : "Find gifts →"}
              </button>
            </div>

            <div style={S.homeSuggs}>
              {SUGGESTIONS.map((s,i) => (
                <button key={i} style={S.suggBtn} onClick={() => { setQuery(s); handleSearch(s); }}>{s}</button>
              ))}
            </div>
          </div>

          <div style={S.homeClientBadge}>
            <div style={S.av}>{initials(session.client_name)}</div>
            <div>
              <p style={{ fontSize:12, fontWeight:600, color:"#111", margin:0 }}>{session.client_name}</p>
              {session.client_company && <p style={{ fontSize:11, color:"#aaa", margin:0 }}>{session.client_company}</p>}
            </div>
          </div>
        </div>
      )}

      {/* ── RESULTS ── */}
      {view === "results" && (
        <div style={S.resultsPage}>

          {/* Persistent top bar */}
          <div style={S.topBar}>
            <button style={S.logoSmall} onClick={() => setView("home")}>
              <span style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:14, fontWeight:700, letterSpacing:4, textTransform:"uppercase", color:"#111" }}>Rock</span>
              <span style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:16, fontStyle:"italic", color:"#2C5F3A", fontWeight:400, marginLeft:3 }}>Dove</span>
            </button>

            <div style={S.searchBarWrap}>
              <textarea
                style={S.searchBar}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); handleSearch(); } }}
                rows={1}
              />
              <button
                style={{ ...S.searchBarBtn, ...(searching?{ opacity:0.5, cursor:"not-allowed" }:{}) }}
                onClick={() => handleSearch()}
                disabled={searching}
              >
                {searching ? "…" : "→"}
              </button>
            </div>

            <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
              {hearted.size > 0 && (
                <button style={S.shortlistToggleBtn} onClick={() => setShortlistOpen(!shortlistOpen)}>
                  ♥ {hearted.size} saved
                </button>
              )}
              <div style={S.av}>{initials(session.client_name)}</div>
            </div>
          </div>

          {/* Context strip */}
          {(chips.length > 0 || aiSummary) && (
            <div style={S.contextStrip}>
              {chips.length > 0 && chips.map((c,i) => (
                <span key={i} style={typeof c==="string"?S.chip:S.chipMuted}>
                  {typeof c==="string"?c:c.label}
                </span>
              ))}
              {aiSummary && (
                <span style={S.aiSummaryText}>— {aiSummary}</span>
              )}
            </div>
          )}

          {/* Grid + shortlist */}
          <div style={S.resultsBody}>
            <div style={{ flex:1, overflowY:"auto" }}>
              <div style={S.gridWrap}>
                <div style={S.gridMeta}>
                  <span style={S.gridCnt}>{searching ? "Searching…" : `${results.length} gifts curated`}</span>
                  <div style={{ display:"flex", gap:4 }}>
                    {[["rec","Recommended"],["asc","Price ↑"],["desc","Price ↓"]].map(([v,l]) => (
                      <button key={v} style={{ ...S.sortBtn, ...(sort===v?S.sortOn:{}) }} onClick={() => setSort(v)}>{l}</button>
                    ))}
                  </div>
                </div>

                {searching ? (
                  <div style={{ textAlign:"center", padding:"80px 0", color:"#bbb", fontFamily:"Georgia,serif", fontSize:17, fontStyle:"italic", fontWeight:300 }}>
                    Finding the perfect gifts for you…
                  </div>
                ) : (
                  <div style={S.grid}>
                    {sortedResults.map(p => (
                      <div key={p.id} style={S.card}>
                        <div style={{ ...S.cardImg, background:p._bg||"#f5f0eb" }}
                          onClick={() => { setSelectedProduct({...p}); logEvent("product_view", p.id); }}>
                          {p.image_url ? (
                            <img src={p.image_url} alt={p.name}
                              style={{ position:"absolute", inset:0, width:"100%", height:"100%", objectFit:"cover" }}
                              onError={e=>{e.target.style.display="none"}} />
                          ) : (
                            <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                              <span style={{ fontSize:10, letterSpacing:"2px", color:"#bbb", textTransform:"uppercase" }}>{p.category}</span>
                            </div>
                          )}
                          <button style={{ ...S.heartBtn, color: hearted.has(p.id)?"#9B3A2A":"#bbb" }}
                            onClick={e => { e.stopPropagation(); toggleHeart(p); }}>
                            {hearted.has(p.id)?"♥":"♡"}
                          </button>
                        </div>
                        <div style={S.cardBody} onClick={() => { setSelectedProduct({...p}); logEvent("product_view", p.id); }}>
                          <span style={{ ...S.tierBadge, ...(p.tier==="Gold"?S.tierGold:p.tier==="Platinum"?S.tierPlat:S.tierSilv) }}>
                            {TIER_LABEL[p.tier]||p.tier}
                          </span>
                          <p style={S.cardName}>{p.name}</p>
                          <p style={S.cardCat}>{p.category}</p>
                          <p style={S.cardPrice}>₹{(p._price||0).toLocaleString("en-IN")}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Soft follow-up from Dove — below results, never blocking */}
                {followUp && !searching && (
                  <div style={S.followUp}>
                    <span style={S.followUpDot}></span>
                    <div>
                      <p style={S.followUpText}>{followUp}</p>
                      <div style={S.followUpInput}>
                        <input
                          style={S.followUpField}
                          placeholder="Reply to refine…"
                          onKeyDown={e => {
                            if (e.key==="Enter" && e.target.value.trim()) {
                              const refined = query + ". " + e.target.value.trim();
                              setQuery(refined);
                              handleSearch(refined);
                              e.target.value = "";
                            }
                          }}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Shortlist drawer */}
            {shortlistOpen && (
              <div style={S.shortlistDrawer}>
                <div style={S.shortlistHeader}>
                  <p style={S.shortlistTitle}>Your shortlist</p>
                  <button style={{ background:"none", border:"none", fontSize:20, color:"#aaa", cursor:"pointer" }}
                    onClick={() => setShortlistOpen(false)}>×</button>
                </div>
                <div style={{ flex:1, overflowY:"auto" }}>
                  {shortlistItems.length === 0 ? (
                    <p style={{ padding:"28px 20px", fontSize:13, color:"#bbb", textAlign:"center", fontFamily:"Georgia,serif", fontStyle:"italic", fontWeight:300, lineHeight:1.8 }}>
                      Heart a gift to save it here
                    </p>
                  ) : shortlistItems.map(p => (
                    <div key={p.id} style={S.slRow}>
                      <div style={{ width:42, height:50, background:p._bg||"#f5f0eb", flexShrink:0, overflow:"hidden", cursor:"pointer" }}
                        onClick={() => setSelectedProduct({...p})}>
                        {p.image_url && <img src={p.image_url} alt={p.name} style={{ width:"100%", height:"100%", objectFit:"cover" }} onError={e=>{e.target.style.display="none"}} />}
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <p style={{ fontSize:12, fontWeight:500, color:"#111", margin:"0 0 2px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.name}</p>
                        <p style={{ fontSize:11, color:"#aaa", margin:0 }}>₹{(p._price||0).toLocaleString("en-IN")}</p>
                      </div>
                      <button style={{ background:"none", border:"none", color:"#ccc", cursor:"pointer", fontSize:17, padding:0, flexShrink:0 }}
                        onClick={() => toggleHeart(p)}>×</button>
                    </div>
                  ))}
                </div>
                <div style={S.slFooter}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:14, paddingBottom:14, borderBottom:"1px solid #f0ece4" }}>
                    <span style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#aaa" }}>Total</span>
                    <span style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:20, fontWeight:400, color:"#111" }}>
                      {hearted.size===0?"—":`₹${totalEstimate.toLocaleString("en-IN")}`}
                    </span>
                  </div>
                  <button style={{ ...S.btnGreen, ...(hearted.size===0?{ opacity:0.4, cursor:"not-allowed", boxShadow:"none" }:{}) }}
                    onClick={submitShortlist} disabled={hearted.size===0||submitting}>
                    {submitting?"Sending…":"Send to Rock Dove →"}
                  </button>
                  <p style={{ fontSize:10, color:"#bbb", textAlign:"center", marginTop:10 }}>We follow up within 24 hours</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* PRODUCT MODAL */}
      {selectedProduct?.id && (
        <div style={S.modalOverlay} onClick={() => setSelectedProduct(null)}>
          <div style={S.modalBox} onClick={e => e.stopPropagation()}>
            <button style={S.modalClose} onClick={() => setSelectedProduct(null)}>×</button>
            <div style={S.modalInner}>
              <div style={S.modalImg}>
                {selectedProduct.image_url ? (
                  <img src={selectedProduct.image_url} alt={selectedProduct.name||""}
                    style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }}
                    onError={e=>{e.target.style.display="none"}} />
                ) : (
                  <div style={{ width:"100%", height:"100%", background:selectedProduct._bg||"#f5f0eb", display:"flex", alignItems:"center", justifyContent:"center" }}>
                    <span style={{ fontSize:10, letterSpacing:"2px", color:"#bbb", textTransform:"uppercase" }}>{selectedProduct.category}</span>
                  </div>
                )}
              </div>
              <div style={S.modalContent}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
                  <span style={{ ...S.tierBadge, ...(selectedProduct.tier==="Gold"?S.tierGold:selectedProduct.tier==="Platinum"?S.tierPlat:S.tierSilv) }}>
                    {TIER_LABEL[selectedProduct.tier]||selectedProduct.tier}
                  </span>
                  <button style={{ background:"none", border:"none", fontSize:26, color: hearted.has(selectedProduct.id)?"#9B3A2A":"#ccc", cursor:"pointer", lineHeight:1 }}
                    onClick={() => toggleHeart(selectedProduct)}>
                    {hearted.has(selectedProduct.id)?"♥":"♡"}
                  </button>
                </div>
                <p style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:26, fontWeight:400, color:"#111", lineHeight:1.25, margin:"0 0 6px" }}>
                  {selectedProduct.name||""}
                </p>
                <p style={{ fontSize:11, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 20px" }}>
                  {selectedProduct.category||""}
                </p>
                <p style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:30, fontWeight:400, color:"#111", margin:"0 0 24px" }}>
                  ₹{(selectedProduct._price||0).toLocaleString("en-IN")}
                </p>
                {selectedProduct.description && (
                  <p style={{ fontFamily:"Georgia,serif", fontSize:16, fontWeight:300, color:"#444", lineHeight:1.85, margin:"0 0 24px" }}>
                    {selectedProduct.description}
                  </p>
                )}
                {selectedProduct.whats_in_box && (
                  <div style={{ marginBottom:22, paddingBottom:18, borderBottom:"1px solid #f0f0f0" }}>
                    <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 8px" }}>What's in the box</p>
                    <p style={{ fontFamily:"Georgia,serif", fontSize:15, fontWeight:300, color:"#555", lineHeight:1.8, margin:0 }}>
                      {formatBox(selectedProduct.whats_in_box)}
                    </p>
                  </div>
                )}
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"14px 24px", marginBottom:28 }}>
                  {selectedProduct.moq && <div>
                    <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 5px" }}>Min. Order</p>
                    <p style={{ fontSize:14, color:"#333", margin:0 }}>{selectedProduct.moq} units</p>
                  </div>}
                  {selectedProduct.lead_time && <div>
                    <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 5px" }}>Lead Time</p>
                    <p style={{ fontSize:14, color:"#333", margin:0 }}>{selectedProduct.lead_time}</p>
                  </div>}
                  {selectedProduct.box_dimensions && <div>
                    <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 5px" }}>Dimensions</p>
                    <p style={{ fontSize:14, color:"#333", margin:0 }}>{selectedProduct.box_dimensions}</p>
                  </div>}
                  {selectedProduct.weight_grams && <div>
                    <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 5px" }}>Weight</p>
                    <p style={{ fontSize:14, color:"#333", margin:0 }}>{selectedProduct.weight_grams}g</p>
                  </div>}
                </div>
                <button
                  style={{ ...S.btnGreen, ...(hearted.has(selectedProduct.id)?{ background:"#9B3A2A", boxShadow:"0 4px 0 #e8b4a8" }:{}) }}
                  onClick={() => toggleHeart(selectedProduct)}>
                  {hearted.has(selectedProduct.id)?"♥  Saved to shortlist":"♡  Save to shortlist"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BigLogo() {
  return (
    <div style={{ textAlign:"center" }}>
      <div style={{ display:"flex", alignItems:"baseline", justifyContent:"center", gap:8 }}>
        <span style={{
          fontFamily:"'Playfair Display',Georgia,serif",
          fontSize:56,
          fontWeight:700,
          letterSpacing:12,
          textTransform:"uppercase",
          color:"#111",
          lineHeight:1,
        }}>Rock</span>
        <span style={{
          fontFamily:"'Playfair Display',Georgia,serif",
          fontSize:64,
          fontStyle:"italic",
          color:"#2C5F3A",
          fontWeight:400,
          letterSpacing:2,
          lineHeight:1,
        }}>Dove</span>
      </div>
    </div>
  );
}

const styles = {
  app: { minHeight:"100vh", background:"#fff", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif" },
  fullCenter: { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:"100vh", textAlign:"center", padding:32 },
  av: { width:32, height:32, borderRadius:"50%", background:"#7A90B0", fontSize:11, fontWeight:600, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },

  // Home
  homePage: { minHeight:"100vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"60px 40px", position:"relative" },
  homeCenter: { width:"100%", maxWidth:720, textAlign:"center" },
  homeTagline: { fontFamily:"'Josefin Sans',sans-serif", fontSize:11, letterSpacing:"3px", textTransform:"uppercase", color:"#bbb", margin:"12px 0 0", fontWeight:300 },
  homeGreeting: { fontFamily:"Georgia,serif", fontSize:20, fontWeight:300, color:"#555", margin:"40px 0 36px", lineHeight:1.6, fontStyle:"italic" },
  homeInputWrap: { width:"100%", border:"1.5px solid #1a1a1a", background:"#fff", display:"flex", flexDirection:"column" },
  homeTextarea: { width:"100%", border:"none", outline:"none", resize:"none", padding:"20px 24px 0", fontFamily:"Georgia,serif", fontSize:18, fontWeight:300, color:"#111", lineHeight:1.7, background:"transparent", boxSizing:"border-box" },
  homeSearchBtn: { alignSelf:"flex-end", background:"#2C5F3A", color:"#fff", border:"none", margin:"12px 16px 16px", padding:"10px 24px", fontFamily:"'Josefin Sans',sans-serif", fontSize:12, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", cursor:"pointer", boxShadow:"0 4px 0 #a8d4b4" },
  homeSuggs: { marginTop:24, display:"flex", flexWrap:"wrap", gap:8, justifyContent:"center" },
  suggBtn: { fontFamily:"Georgia,serif", fontSize:14, fontWeight:300, color:"#888", background:"none", border:"1px solid #E0DDD8", padding:"8px 16px", cursor:"pointer", fontStyle:"italic", lineHeight:1.5 },
  homeClientBadge: { position:"absolute", top:28, right:32, display:"flex", alignItems:"center", gap:10 },

  // Results page
  resultsPage: { height:"100vh", display:"flex", flexDirection:"column", overflow:"hidden" },

  // Top bar
  topBar: { display:"flex", alignItems:"center", gap:16, padding:"0 28px", height:58, borderBottom:"1px solid #EDEBE6", flexShrink:0, background:"#fff" },
  logoSmall: { background:"none", border:"none", cursor:"pointer", display:"flex", alignItems:"baseline", gap:3, flexShrink:0, padding:0 },
  searchBarWrap: { flex:1, display:"flex", border:"1px solid #CDCAC4", background:"#fff", height:38 },
  searchBar: { flex:1, border:"none", outline:"none", resize:"none", padding:"8px 14px", fontFamily:"Georgia,serif", fontSize:15, fontWeight:300, color:"#111", background:"transparent", lineHeight:1.4 },
  searchBarBtn: { width:44, background:"#2C5F3A", border:"none", cursor:"pointer", color:"#fff", fontSize:18, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  shortlistToggleBtn: { background:"#2C5F3A", color:"#fff", border:"none", padding:"7px 14px", fontFamily:"'Josefin Sans',sans-serif", fontSize:11, fontWeight:600, letterSpacing:"1px", cursor:"pointer", flexShrink:0, boxShadow:"0 3px 0 #a8d4b4" },

  // Context strip
  contextStrip: { padding:"8px 28px", display:"flex", gap:8, flexWrap:"wrap", alignItems:"center", borderBottom:"1px solid #F5F2EE", background:"#FAFAF8", flexShrink:0 },
  chip: { fontSize:10, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:"#2C5F3A", padding:"3px 10px", border:"1px solid #a8c8b4", background:"#eaf2ec" },
  chipMuted: { fontSize:10, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:"#bbb", padding:"3px 10px", border:"1px solid #eee", background:"#fafafa" },
  aiSummaryText: { fontFamily:"Georgia,serif", fontSize:14, fontStyle:"italic", fontWeight:300, color:"#888" },

  resultsBody: { flex:1, display:"flex", overflow:"hidden" },
  gridWrap: { padding:"22px 28px" },
  gridMeta: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 },
  gridCnt: { fontSize:11, color:"#bbb", letterSpacing:"1px", textTransform:"uppercase", fontFamily:"'Josefin Sans',sans-serif" },
  sortBtn: { fontSize:11, color:"#bbb", background:"none", border:"none", cursor:"pointer", fontFamily:"'Josefin Sans',sans-serif", padding:"4px 10px" },
  sortOn: { color:"#111", borderBottom:"1.5px solid #111" },

  grid: { display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(190px, 1fr))", gap:"24px 14px" },
  card: { cursor:"pointer" },
  cardImg: { width:"100%", paddingBottom:"116%", position:"relative", overflow:"hidden" },
  heartBtn: { position:"absolute", top:8, right:8, width:28, height:28, background:"rgba(255,255,255,0.9)", border:"none", fontSize:13, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" },
  cardBody: { paddingTop:10 },
  tierBadge: { fontSize:9, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", display:"inline-block", padding:"2px 8px", marginBottom:7 },
  tierGold: { color:"#7a5c20", background:"#fdf5e6", border:"1px solid #e8d5a0" },
  tierPlat: { color:"#2a4a7a", background:"#eef3fa", border:"1px solid #b8cce8" },
  tierSilv: { color:"#666", background:"#f5f5f5", border:"1px solid #e0e0e0" },
  cardName: { fontFamily:"'Playfair Display',Georgia,serif", fontSize:16, fontWeight:400, color:"#111", margin:"0 0 3px", lineHeight:1.3 },
  cardCat: { fontSize:10, letterSpacing:"1.5px", textTransform:"uppercase", color:"#bbb", margin:"0 0 8px", fontFamily:"'Josefin Sans',sans-serif" },
  cardPrice: { fontSize:14, fontWeight:600, color:"#111", margin:0, fontFamily:"'Josefin Sans',sans-serif" },

  // Follow-up
  followUp: { display:"flex", alignItems:"flex-start", gap:12, marginTop:40, padding:"20px 24px", background:"#F9F7F4", borderTop:"1px solid #EDEBE6" },
  followUpDot: { display:"inline-block", width:7, height:7, borderRadius:"50%", background:"#2C5F3A", flexShrink:0, marginTop:6 },
  followUpText: { fontFamily:"Georgia,serif", fontSize:16, fontWeight:300, fontStyle:"italic", color:"#555", margin:"0 0 12px", lineHeight:1.7 },
  followUpInput: { display:"flex" },
  followUpField: { flex:1, fontFamily:"Georgia,serif", fontSize:15, fontWeight:300, color:"#111", border:"none", borderBottom:"1.5px solid #1a1a1a", padding:"6px 0", outline:"none", background:"transparent", fontStyle:"italic" },

  // Shortlist drawer
  shortlistDrawer: { width:280, background:"#fff", borderLeft:"1px solid #EDEBE6", display:"flex", flexDirection:"column", flexShrink:0 },
  shortlistHeader: { padding:"18px 20px 14px", borderBottom:"1px solid #EDEBE6", display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0 },
  shortlistTitle: { fontFamily:"'Josefin Sans',sans-serif", fontSize:11, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#111", margin:0 },
  slRow: { display:"flex", alignItems:"center", gap:10, padding:"11px 18px", borderBottom:"1px solid #F5F0E8" },
  slFooter: { padding:18, borderTop:"1px solid #EDEBE6", flexShrink:0 },
  btnGreen: { width:"100%", background:"#2C5F3A", color:"#fff", border:"none", padding:14, fontFamily:"'Josefin Sans',sans-serif", fontSize:11, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", cursor:"pointer", boxShadow:"0 4px 0 #a8d4b4", display:"block" },

  // Modal
  modalOverlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:500, padding:32 },
  modalBox: { background:"#fff", width:"100%", maxWidth:820, maxHeight:"90vh", overflow:"hidden", position:"relative", display:"flex", flexDirection:"column" },
  modalClose: { position:"absolute", top:12, right:16, background:"none", border:"none", fontSize:28, color:"#aaa", cursor:"pointer", lineHeight:1, zIndex:10 },
  modalInner: { display:"flex", flex:1, minHeight:480, overflow:"hidden" },
  modalImg: { width:340, minWidth:340, flexShrink:0, background:"#f5f0eb", overflow:"hidden" },
  modalContent: { flex:1, padding:"32px 28px", overflowY:"auto" },
};
