import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase.js";

const CATALOGUE_URL = import.meta.env.VITE_CATALOGUE_SERVICE_URL ||
  "https://ikka-catalogue-service-production.up.railway.app";

const BG_COLORS = ["#F5EFE8","#EDF2EE","#EEF0F7","#F7EEF0","#F0EDE8","#EEF5F2","#F5F0E8","#EEF1F7","#F2EEF5"];
const TIER_LABEL = { Gold:"Gold", Silver:"Silver", Platinum:"Platinum" };

const SUGGESTIONS = [
  "Diwali gifts for senior leadership, around ₹3,000",
  "Premium client thank-you, something personal",
  "New joiner welcome gift under ₹1,500",
  "Work anniversary gift for a long-serving employee",
];

function priceAtQty(tiers, qty) {
  if (!tiers || !tiers.length) return 0;
  try {
    const match = tiers
      .filter(t => qty >= t.min_qty && (t.max_qty === null || qty <= t.max_qty))
      .sort((a, b) => b.min_qty - a.min_qty)[0];
    return match ? parseFloat(match.price_per_unit) : parseFloat(tiers[0].price_per_unit);
  } catch { return 0; }
}

function initials(name) {
  return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function formatBox(text) {
  if (!text) return "";
  return text.replace(/([a-z])([A-Z])/g, "$1 · $2").replace(/\s*,\s*/g, " · ").replace(/\s*\|\s*/g, " · ");
}

function safe(val, fallback = "") { try { return val ?? fallback; } catch { return fallback; } }

export default function App() {
  const [session, setSession] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const productsRef = useRef([]);
  const [results, setResults] = useState([]);
  const [hearted, setHearted] = useState(new Set());
  const heartedRef = useRef({});
  const [selectedProduct, setSelectedProduct] = useState(null);

  const [messages, setMessages] = useState([]);
  const [doveHistory, setDoveHistory] = useState([]);
  const [inputText, setInputText] = useState("");
  const [doveTyping, setDoveTyping] = useState(false);
  const [lastFilters, setLastFilters] = useState(null);
  const [queryLog, setQueryLog] = useState([]);
  const chatEndRef = useRef(null);

  const [view, setView] = useState("chat");
  const [rightTab, setRightTab] = useState("shortlist");
  const [chips, setChips] = useState([]);
  const [aiSummary, setAiSummary] = useState("");
  const [ranking, setRanking] = useState(false);
  const [sort, setSort] = useState("rec");
  const [submitting, setSubmitting] = useState(false);
  const [refineText, setRefineText] = useState("");
  const [refineLoading, setRefineLoading] = useState(false);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token") ||
      window.location.pathname.split("/").pop();
    if (token && token !== "/") loadSession(token);
    else setNotFound(true);
  }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, doveTyping]);

  const loadSession = async (token) => {
    try {
      const { data, error } = await supabase.from("rd_sessions").select("*").eq("token", token).single();
      if (error || !data) { setNotFound(true); return; }
      setSession(data);
      supabase.from("rd_sessions").update({ last_active: new Date().toISOString() }).eq("id", data.id);
      await loadProducts();
      loadShortlist(data.id);
      const greeting = `Hello ${data.client_name.split(" ")[0]} — I'm Dove, your gifting concierge at Rock Dove.\n\nTell me about your gifting need. Who are you gifting, and what's the occasion?`;
      setTimeout(() => {
        setMessages([{ role: "dove", text: greeting }]);
        setDoveHistory([{ role: "assistant", content: greeting }]);
      }, 400);
    } catch (e) { console.error(e); setNotFound(true); }
  };

  const loadProducts = async () => {
    try {
      // Try with product_tags join first
      let { data, error } = await supabase.from("catalog")
        .select("*, pricing_tiers(*), product_tags(tag, dimension)")
        .eq("active", true).order("popularity", { ascending: false });
      // Fallback without join if it fails
      if (error) {
        const res = await supabase.from("catalog")
          .select("*, pricing_tiers(*)").eq("active", true).order("popularity", { ascending: false });
        data = res.data;
      }
      if (data) {
        productsRef.current = data.map((p, i) => ({
          ...p,
          _bg: BG_COLORS[i % BG_COLORS.length],
          _price: priceAtQty(p.pricing_tiers, 1),
          _tags: (p.product_tags || []).map(t => (t.tag || "").toLowerCase()).filter(Boolean),
        }));
      }
    } catch (e) { console.error("loadProducts:", e); }
  };

  const loadShortlist = async (sessionId) => {
    try {
      const { data } = await supabase.from("rd_shortlists").select("product_id").eq("session_id", sessionId);
      if (data) setHearted(new Set(data.map(r => r.product_id)));
    } catch (e) { console.error(e); }
  };

  const logEvent = useCallback(async (type, pid=null, meta={}) => {
    if (!session) return;
    try { await supabase.from("rd_events").insert([{ session_id: session.id, event_type: type, product_id: pid, metadata: meta }]); }
    catch {}
  }, [session]);

  const saveConvo = useCallback(async (role, message) => {
    if (!session) return;
    try { await supabase.from("rd_conversations").insert([{ session_id: session.id, role, message }]); }
    catch {}
  }, [session]);

  const callDove = async (userMessage, history) => {
    const res = await fetch(CATALOGUE_URL + "/dove-chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: userMessage, conversation_history: history }),
    });
    if (!res.ok) throw new Error("Dove unavailable");
    return res.json();
  };

  const runCuration = async (filters) => {
    setRanking(true);
    const allProducts = productsRef.current;
    const qty = filters.qty || 1;
    const budget = filters.budget || null;

    const newChips = [];
    if (filters.occasion && filters.occasion !== "other") newChips.push(filters.occasion.toUpperCase().replace(/-/g," "));
    if (filters.audience && filters.audience !== "other") newChips.push(filters.audience.toUpperCase().replace(/-/g," "));
    if (budget) newChips.push(`₹${budget.toLocaleString("en-IN")} / UNIT`);
    if (filters.exclude_edible) newChips.push({ label:"NON-EDIBLE", muted:true });
    if (filters.exclude_fragile) newChips.push({ label:"NON-FRAGILE", muted:true });
    setChips(newChips);

    try {
      const candidates = allProducts.filter(p => {
        const price = priceAtQty(p.pricing_tiers, qty);
        if (budget && price > budget * 1.2) return false;
        if (filters.exclude_edible && p.edible) return false;
        if (filters.exclude_fragile && p.fragile) return false;
        return true;
      }).map(p => ({
        id: p.id, name: p.name || "", category: p.category || "",
        description: (p.description || "").slice(0, 150),
        whats_in_box: (p.whats_in_box || "").slice(0, 100),
        price: priceAtQty(p.pricing_tiers, qty),
        tier: p.tier || "",
        tags: (p._tags || []).join(", "),
      }));

      const rankRes = await fetch(CATALOGUE_URL + "/dove-rank", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brief: filters.query || "",
          budget: filters.budget || null,
          exclude_edible: filters.exclude_edible || false,
          exclude_fragile: filters.exclude_fragile || false,
          products: candidates,
        }),
      });
      const ranked = await rankRes.json();
      setAiSummary(ranked.summary || "Here are your curated gifts.");
      saveConvo("assistant", ranked.summary || "");

      const idOrder = ranked.ranked_ids || [];
      const productMap = {};
      allProducts.forEach(p => { productMap[p.id] = { ...p, _price: priceAtQty(p.pricing_tiers, qty) }; });

      const ordered = idOrder.map(id => productMap[id]).filter(Boolean);
      const rankedSet = new Set(idOrder);
      const rest = candidates.filter(c => !rankedSet.has(c.id)).map(c => productMap[c.id]).filter(Boolean);
      setResults([...ordered, ...rest]);
      setSort("rec");
    } catch(e) {
      console.error("Ranking:", e);
      const budget2 = filters.budget || null;
      const fallback = allProducts
        .filter(p => !budget2 || priceAtQty(p.pricing_tiers, qty) <= budget2 * 1.2)
        .map(p => ({ ...p, _price: priceAtQty(p.pricing_tiers, qty) }));
      setResults(fallback);
      setAiSummary("Here are our curated gifts for you.");
    }
    setRanking(false);
  };

  const handleSend = async (textOverride) => {
    const msg = (textOverride || inputText).trim();
    if (!msg || doveTyping || ranking) return;
    setInputText("");
    setMessages(prev => [...prev, { role: "user", text: msg }]);
    setQueryLog(prev => [{ text: msg, ts: Date.now() }, ...prev].slice(0, 8));
    saveConvo("user", msg);
    setDoveTyping(true);
    try {
      const data = await callDove(msg, doveHistory);
      setDoveTyping(false);
      setMessages(prev => [...prev, { role: "dove", text: data.response }]);
      setDoveHistory(prev => [...prev, { role:"user", content:msg }, { role:"assistant", content:data.response }]);
      saveConvo("dove", data.response);
      if (data.ready && data.filters) {
        setLastFilters(data.filters);
        await runCuration(data.filters);
        setView("results");
        setRightTab("shortlist");
      }
    } catch(e) {
      setDoveTyping(false);
      setMessages(prev => [...prev, { role:"dove", text:"I had a moment of difficulty. Could you rephrase that?" }]);
    }
  };

  const handleRefine = async () => {
    const text = refineText.trim();
    if (!text || refineLoading) return;
    setRefineText("");
    setRefineLoading(true);
    setMessages(prev => [...prev, { role:"user", text }]);
    try {
      const data = await callDove(text, doveHistory);
      setMessages(prev => [...prev, { role:"dove", text: data.response }]);
      setDoveHistory(prev => [...prev, { role:"user", content:text }, { role:"assistant", content:data.response }]);
      const filters = (data.ready && data.filters) ? data.filters
        : lastFilters ? { ...lastFilters, query: (lastFilters.query||"") + ". " + text } : null;
      if (filters) { setLastFilters(filters); await runCuration(filters); }
    } catch(e) {
      setMessages(prev => [...prev, { role:"dove", text:"Let me try again — could you describe what you're looking for?" }]);
    }
    setRefineLoading(false);
  };

  const toggleHeart = async (p) => {
    if (!session || !p) return;
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
    }
    setHearted(newHearted);
  };

  const submitShortlist = async () => {
    if (!session || hearted.size === 0) return;
    setSubmitting(true);
    logEvent("shortlist_submit", null, { product_ids: [...hearted], count: hearted.size });
    setTimeout(() => { setView("submitted"); setSubmitting(false); }, 800);
  };

  const sortedResults = [...results].sort((a,b) => {
    if (sort==="asc") return (a._price||0) - (b._price||0);
    if (sort==="desc") return (b._price||0) - (a._price||0);
    return 0;
  });

  const shortlistItems = [...hearted].map(id => heartedRef.current[id] || results.find(p => p.id === id)).filter(Boolean);
  const totalEstimate = shortlistItems.reduce((s,p) => s+(p._price||0), 0);

  const S = styles;

  if (notFound) return (
    <div style={S.fullCenter}>
      <RockDoveLogo size="lg" />
      <p style={{ ...S.bodyText, color:"#666", marginTop:28 }}>This link is invalid or has expired.</p>
      <p style={{ ...S.bodyText, color:"#bbb", marginTop:8, fontSize:13 }}>Please contact your Rock Dove curator for a new link.</p>
    </div>
  );

  if (!session) return (
    <div style={S.fullCenter}>
      <RockDoveLogo size="lg" />
      <p style={{ fontSize:11, color:"#bbb", letterSpacing:"2px", textTransform:"uppercase", marginTop:24 }}>Loading your experience…</p>
    </div>
  );

  if (view === "submitted") return (
    <div style={S.fullCenter}>
      <div style={{ width:52, height:52, borderRadius:"50%", background:"#2C5F3A", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, marginBottom:22 }}>✓</div>
      <p style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:30, fontWeight:400, color:"#111", margin:"0 0 10px" }}>Shortlist sent</p>
      <p style={{ ...S.bodyText, color:"#888", maxWidth:380, lineHeight:1.8, marginBottom:32, textAlign:"center" }}>
        Thank you, {session.client_name.split(" ")[0]}. We'll follow up within 24 hours with availability and final pricing.
      </p>
      <div style={{ width:"100%", maxWidth:380 }}>
        {shortlistItems.map(p => (
          <div key={p.id} style={{ display:"flex", alignItems:"center", gap:14, padding:"13px 0", borderBottom:"1px solid #f0f0f0" }}>
            <div style={{ width:46, height:56, background:p._bg||"#f5f0eb", flexShrink:0, overflow:"hidden" }}>
              {p.image_url && <img src={p.image_url} alt={p.name} style={{ width:"100%", height:"100%", objectFit:"cover" }} />}
            </div>
            <div>
              <p style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:16, fontWeight:400, color:"#111", margin:"0 0 3px" }}>{p.name}</p>
              <p style={{ fontSize:13, color:"#aaa", margin:0 }}>₹{(p._price||0).toLocaleString("en-IN")}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div style={S.app}>

      {/* LEFT SIDEBAR */}
      <div style={S.sidebar}>
        <div style={S.sideTop}>
          <RockDoveLogo size="sm" />
        </div>

        <div style={S.sideClient}>
          <div style={S.av}>{initials(session.client_name)}</div>
          <div>
            <p style={{ fontSize:12, fontWeight:600, color:"#111", margin:0, letterSpacing:"0.3px" }}>{session.client_name}</p>
            {session.client_company && <p style={{ fontSize:11, color:"#aaa", margin:0 }}>{session.client_company}</p>}
          </div>
        </div>

        {view === "results" && (
          <button style={S.sideNewBtn} onClick={() => { setView("chat"); }}>
            ← Back to Dove
          </button>
        )}

        {queryLog.length > 0 && (
          <div style={S.sideHistory}>
            <p style={S.sideHistoryLabel}>Recent searches</p>
            {queryLog.map((q, i) => (
              <button key={i} style={S.sideHistoryItem} onClick={() => handleSend(q.text)}>
                <span style={{ color:"#bbb", flexShrink:0 }}>↺</span>
                <span style={{ fontSize:12, color:"#555", lineHeight:1.5, textAlign:"left" }}>
                  {q.text.length > 36 ? q.text.slice(0, 36) + "…" : q.text}
                </span>
              </button>
            ))}
          </div>
        )}

        <div style={S.sideMeta}>
          <p style={{ fontSize:10, color:"#ccc", letterSpacing:"1px", margin:0, textTransform:"uppercase" }}>Rock Dove · Gift Intelligence</p>
        </div>
      </div>

      {/* MAIN */}
      <div style={S.main}>

        {/* ── CHAT ── */}
        {view === "chat" && (
          <div style={S.chatOuter}>
            {/* Welcome header — shown when conversation just started */}
            {messages.length <= 1 && (
              <div style={S.welcomeHeader}>
                <RockDoveLogo size="xl" center />
                <p style={S.welcomeTagline}>by Ikka Dukka · Gift Intelligence</p>
              </div>
            )}

            {/* Messages */}
            <div style={S.chatScroll}>
              <div style={S.chatInner}>
                {messages.map((m, i) => (
                  <div key={i} style={{ marginBottom: m.role==="dove" ? 32 : 20 }}>
                    {m.role === "dove" ? (
                      <div style={S.doveRow}>
                        <div style={S.doveAvatarDot}></div>
                        <div>
                          <p style={S.doveName}>Dove</p>
                          <p style={S.doveText}>
                            {m.text.split("\n").map((line,j,arr) => (
                              <span key={j}>{line}{j<arr.length-1&&<br/>}</span>
                            ))}
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div style={S.userRow}>
                        <p style={S.userText}>
                          {m.text.split("\n").map((line,j,arr) => (
                            <span key={j}>{line}{j<arr.length-1&&<br/>}</span>
                          ))}
                        </p>
                      </div>
                    )}
                  </div>
                ))}

                {doveTyping && (
                  <div style={S.doveRow}>
                    <div style={S.doveAvatarDot}></div>
                    <div>
                      <p style={S.doveName}>Dove</p>
                      <div style={{ display:"flex", gap:5, alignItems:"center", height:28 }}>
                        <span className="td"></span>
                        <span className="td" style={{ animationDelay:"0.2s" }}></span>
                        <span className="td" style={{ animationDelay:"0.4s" }}></span>
                      </div>
                    </div>
                  </div>
                )}

                {ranking && (
                  <div style={S.doveRow}>
                    <div style={S.doveAvatarDot}></div>
                    <div>
                      <p style={S.doveName}>Dove</p>
                      <p style={S.doveText}>Curating your selection from our catalogue…</p>
                    </div>
                  </div>
                )}

                {results.length > 0 && !ranking && (
                  <div style={{ margin:"8px 0 24px" }}>
                    <button style={S.viewGiftsBtn} onClick={() => setView("results")}>
                      View {results.length} curated gifts →
                    </button>
                  </div>
                )}

                <div ref={chatEndRef} />
              </div>
            </div>

            {/* Input */}
            <div style={S.inputOuter}>
              <div style={S.inputWrap}>
                <textarea
                  style={S.textarea}
                  value={inputText}
                  onChange={e => setInputText(e.target.value)}
                  onKeyDown={e => { if (e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); handleSend(); } }}
                  placeholder="Tell Dove what you're looking for…"
                  disabled={doveTyping||ranking}
                  rows={1}
                />
                <button
                  style={{ ...S.sendBtn, ...(!inputText.trim()||doveTyping||ranking?{ opacity:0.3, cursor:"not-allowed" }:{}) }}
                  onClick={() => handleSend()}
                  disabled={!inputText.trim()||doveTyping||ranking}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                  </svg>
                </button>
              </div>

              {messages.length <= 1 && (
                <div style={S.suggs}>
                  {SUGGESTIONS.map((s,i) => (
                    <button key={i} style={S.suggBtn} onClick={() => handleSend(s)}>{s}</button>
                  ))}
                </div>
              )}

              <p style={S.privacyNote}>Private · Shared only with Rock Dove</p>
            </div>
          </div>
        )}

        {/* ── RESULTS ── */}
        {view === "results" && (
          <div style={S.resultsOuter}>
            {(chips.length > 0 || aiSummary) && (
              <div style={S.contextBar}>
                {chips.length > 0 && (
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap", padding:"10px 28px 0" }}>
                    {chips.map((c,i) => (
                      <span key={i} style={typeof c==="string"?S.chip:S.chipMuted}>
                        {typeof c==="string"?c:c.label}
                      </span>
                    ))}
                  </div>
                )}
                {aiSummary && (
                  <div style={S.aiBar}>
                    <span style={S.aiDot}></span>
                    <span style={S.aiLbl}>Dove</span>
                    <span style={S.aiTxt}>{aiSummary}</span>
                  </div>
                )}
              </div>
            )}

            <div style={S.resultsBody}>
              {/* Grid */}
              <div style={S.gridWrap}>
                <div style={S.gridMeta}>
                  <span style={S.gridCnt}>{ranking ? "Curating…" : `${results.length} gifts curated`}</span>
                  <div style={{ display:"flex", gap:4 }}>
                    {[["rec","Recommended"],["asc","Price ↑"],["desc","Price ↓"]].map(([v,l]) => (
                      <button key={v} style={{ ...S.sortBtn, ...(sort===v?S.sortOn:{}) }} onClick={() => setSort(v)}>{l}</button>
                    ))}
                  </div>
                </div>

                {ranking ? (
                  <div style={{ textAlign:"center", padding:"80px 0", color:"#bbb", fontSize:13 }}>
                    Dove is reviewing our catalogue for you…
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
                              onError={e => { e.target.style.display="none"; }} />
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
                            {TIER_LABEL[p.tier]||p.tier||""}
                          </span>
                          <p style={S.cardName}>{p.name||""}</p>
                          <p style={S.cardCat}>{p.category||""}</p>
                          <p style={S.cardPrice}>₹{(p._price||0).toLocaleString("en-IN")}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Right panel */}
              <div style={S.rightPanel}>
                <div style={S.tabBar}>
                  <button style={{ ...S.tab, ...(rightTab==="shortlist"?S.tabOn:{}) }} onClick={() => setRightTab("shortlist")}>
                    Shortlist {hearted.size>0&&<span style={S.tabBadge}>{hearted.size}</span>}
                  </button>
                  <button style={{ ...S.tab, ...(rightTab==="dove"?S.tabOn:{}) }} onClick={() => setRightTab("dove")}>
                    <span style={{ display:"inline-block", width:6, height:6, borderRadius:"50%", background:"#2C5F3A", marginRight:5 }}></span>
                    Dove
                  </button>
                </div>

                {rightTab==="shortlist" && (
                  <>
                    <div style={{ flex:1, overflowY:"auto" }}>
                      {hearted.size===0 ? (
                        <p style={{ padding:"36px 20px", fontSize:13, color:"#ccc", textAlign:"center", lineHeight:1.8, margin:0 }}>
                          Heart a gift<br/>to save it here
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
                          <button style={{ background:"none", border:"none", color:"#ccc", cursor:"pointer", fontSize:18, padding:0, lineHeight:1, flexShrink:0 }}
                            onClick={() => toggleHeart(p)}>×</button>
                        </div>
                      ))}
                    </div>
                    <div style={S.slFooter}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:14, paddingBottom:14, borderBottom:"1px solid #f0ece4" }}>
                        <span style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#aaa" }}>Total</span>
                        <span style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:22, fontWeight:400, color:"#111" }}>
                          {hearted.size===0?"—":`₹${totalEstimate.toLocaleString("en-IN")}`}
                        </span>
                      </div>
                      <button style={{ ...S.btnGreen, ...(hearted.size===0?{ opacity:0.4, cursor:"not-allowed", boxShadow:"none" }:{}) }}
                        onClick={submitShortlist} disabled={hearted.size===0||submitting}>
                        {submitting?"Sending…":"Send to Rock Dove →"}
                      </button>
                      <p style={{ fontSize:10, color:"#bbb", textAlign:"center", marginTop:10, letterSpacing:"0.5px" }}>We follow up within 24 hours</p>
                    </div>
                  </>
                )}

                {rightTab==="dove" && (
                  <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
                    <div style={{ flex:1, overflowY:"auto", padding:"14px 16px" }}>
                      {messages.map((m,i) => (
                        <div key={i} style={{ marginBottom:14, display:"flex", flexDirection:"column", alignItems: m.role==="dove"?"flex-start":"flex-end" }}>
                          {m.role==="dove" && <p style={{ fontSize:9, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:"#2C5F3A", margin:"0 0 5px" }}>Dove</p>}
                          <p style={m.role==="dove"
                            ? { fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:15, color:"#333", lineHeight:1.7, maxWidth:"95%", margin:0, fontWeight:400 }
                            : { fontSize:13, background:"#f5f5f3", color:"#111", lineHeight:1.65, maxWidth:"90%", padding:"8px 12px", margin:0 }
                          }>
                            {m.text.split("\n").map((line,j,arr) => (
                              <span key={j}>{line}{j<arr.length-1&&<br/>}</span>
                            ))}
                          </p>
                        </div>
                      ))}
                      {refineLoading && (
                        <div style={{ marginBottom:14 }}>
                          <p style={{ fontSize:9, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:"#2C5F3A", margin:"0 0 5px" }}>Dove</p>
                          <div style={{ display:"flex", gap:4 }}>
                            <span className="td"></span><span className="td" style={{ animationDelay:"0.2s" }}></span><span className="td" style={{ animationDelay:"0.4s" }}></span>
                          </div>
                        </div>
                      )}
                    </div>
                    <div style={{ padding:"12px 14px", borderTop:"1px solid #eeebe6" }}>
                      <div style={{ display:"flex", border:"1px solid #ddd" }}>
                        <input style={{ flex:1, border:"none", outline:"none", padding:"10px 12px", fontSize:13, background:"transparent", color:"#111", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif" }}
                          value={refineText} onChange={e=>setRefineText(e.target.value)}
                          onKeyDown={e=>e.key==="Enter"&&handleRefine()}
                          placeholder="Refine with Dove…" disabled={refineLoading} />
                        <button style={{ width:40, background:"#2C5F3A", border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", ...(!refineText.trim()||refineLoading?{ opacity:0.3, cursor:"not-allowed" }:{}) }}
                          onClick={handleRefine} disabled={!refineText.trim()||refineLoading}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* MODAL — defensive rendering */}
      {selectedProduct && selectedProduct.id && (
        <div style={S.modalOverlay} onClick={() => setSelectedProduct(null)}>
          <div style={S.modalBox} onClick={e => e.stopPropagation()}>
            <button style={S.modalClose} onClick={() => setSelectedProduct(null)}>×</button>
            <div style={S.modalInner}>
              <div style={S.modalImg}>
                {selectedProduct.image_url ? (
                  <img src={selectedProduct.image_url} alt={selectedProduct.name||""}
                    style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }}
                    onError={e => { e.target.style.display="none"; }} />
                ) : (
                  <div style={{ width:"100%", height:"100%", background:selectedProduct._bg||"#f5f0eb", display:"flex", alignItems:"center", justifyContent:"center" }}>
                    <span style={{ fontSize:11, letterSpacing:"2px", color:"#bbb", textTransform:"uppercase" }}>{selectedProduct.category||""}</span>
                  </div>
                )}
              </div>
              <div style={S.modalContent}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
                  <span style={{ ...S.tierBadge, ...(selectedProduct.tier==="Gold"?S.tierGold:selectedProduct.tier==="Platinum"?S.tierPlat:S.tierSilv) }}>
                    {TIER_LABEL[selectedProduct.tier]||selectedProduct.tier||""}
                  </span>
                  <button style={{ background:"none", border:"none", fontSize:24, color: hearted.has(selectedProduct.id)?"#9B3A2A":"#ccc", cursor:"pointer", lineHeight:1 }}
                    onClick={() => toggleHeart(selectedProduct)}>
                    {hearted.has(selectedProduct.id)?"♥":"♡"}
                  </button>
                </div>
                <p style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:26, fontWeight:400, color:"#111", lineHeight:1.25, margin:"0 0 6px" }}>
                  {safe(selectedProduct.name)}
                </p>
                <p style={{ fontSize:11, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 18px" }}>
                  {safe(selectedProduct.category)}
                </p>
                <p style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:28, fontWeight:400, color:"#111", margin:"0 0 22px" }}>
                  ₹{(selectedProduct._price||0).toLocaleString("en-IN")}
                </p>
                {selectedProduct.description && (
                  <p style={{ fontSize:15, color:"#444", lineHeight:1.8, margin:"0 0 22px", fontWeight:300 }}>
                    {safe(selectedProduct.description)}
                  </p>
                )}
                {selectedProduct.whats_in_box && (
                  <div style={{ marginBottom:20, paddingBottom:18, borderBottom:"1px solid #f0f0f0" }}>
                    <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 8px" }}>What's in the box</p>
                    <p style={{ fontSize:14, color:"#555", lineHeight:1.8, margin:0 }}>{formatBox(safe(selectedProduct.whats_in_box))}</p>
                  </div>
                )}
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"12px 24px", marginBottom:24 }}>
                  {selectedProduct.moq && <div>
                    <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 4px" }}>Min. Order</p>
                    <p style={{ fontSize:14, color:"#333", margin:0 }}>{selectedProduct.moq} units</p>
                  </div>}
                  {selectedProduct.lead_time && <div>
                    <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 4px" }}>Lead Time</p>
                    <p style={{ fontSize:14, color:"#333", margin:0 }}>{safe(selectedProduct.lead_time)}</p>
                  </div>}
                  {selectedProduct.box_dimensions && <div>
                    <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 4px" }}>Dimensions</p>
                    <p style={{ fontSize:14, color:"#333", margin:0 }}>{safe(selectedProduct.box_dimensions)}</p>
                  </div>}
                  {selectedProduct.weight_grams && <div>
                    <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 4px" }}>Weight</p>
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

function RockDoveLogo({ size, center }) {
  const sizes = {
    sm: { rock: 13, dove: 18, gap: 3 },
    lg: { rock: 20, dove: 28, gap: 4 },
    xl: { rock: 26, dove: 36, gap: 5 },
  };
  const s = sizes[size] || sizes.lg;
  return (
    <div style={{ textAlign: center ? "center" : "left" }}>
      <div style={{ display:"flex", alignItems:"baseline", gap:s.gap, justifyContent: center?"center":"flex-start" }}>
        <span style={{
          fontFamily:"'Cormorant Garamond',Georgia,serif",
          fontSize: s.rock,
          fontWeight: 600,
          letterSpacing: size==="xl" ? 8 : size==="lg" ? 6 : 4,
          textTransform:"uppercase",
          color:"#111",
        }}>Rock</span>
        <span style={{
          fontFamily:"'Cormorant Garamond',Georgia,serif",
          fontSize: s.dove,
          fontStyle:"italic",
          color:"#2C5F3A",
          fontWeight: 400,
          letterSpacing: 1,
        }}>Dove</span>
      </div>
    </div>
  );
}

const styles = {
  app: { display:"flex", height:"100vh", overflow:"hidden", background:"#fff", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", color:"#111" },
  fullCenter: { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100vh", textAlign:"center", padding:32 },
  bodyText: { fontSize:15, lineHeight:1.7, margin:0, fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif" },

  // Sidebar
  sidebar: { width:214, background:"#FAFAF8", borderRight:"1px solid #EDEBE6", display:"flex", flexDirection:"column", flexShrink:0, padding:"22px 0" },
  sideTop: { padding:"0 18px 18px", borderBottom:"1px solid #EDEBE6", marginBottom:16 },
  sideClient: { display:"flex", alignItems:"center", gap:10, padding:"0 16px 16px", borderBottom:"1px solid #EDEBE6", marginBottom:12 },
  av: { width:32, height:32, borderRadius:"50%", background:"#7A90B0", fontSize:11, fontWeight:600, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  sideNewBtn: { margin:"0 12px 12px", padding:"9px 12px", background:"none", border:"1px solid #DDD", fontSize:12, fontWeight:500, color:"#2C5F3A", cursor:"pointer", textAlign:"left", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", letterSpacing:"0.3px" },
  sideHistory: { flex:1, overflowY:"auto", padding:"0 12px" },
  sideHistoryLabel: { fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 8px 4px" },
  sideHistoryItem: { display:"flex", alignItems:"flex-start", gap:8, width:"100%", padding:"7px 6px", background:"none", border:"none", cursor:"pointer", textAlign:"left", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", marginBottom:2 },
  sideMeta: { padding:"14px 18px 0", borderTop:"1px solid #EDEBE6", marginTop:"auto" },

  // Main
  main: { flex:1, display:"flex", flexDirection:"column", overflow:"hidden" },

  // Chat
  chatOuter: { flex:1, display:"flex", flexDirection:"column", overflow:"hidden" },
  welcomeHeader: { textAlign:"center", padding:"48px 40px 24px", flexShrink:0 },
  welcomeTagline: { fontSize:11, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"8px 0 0", fontWeight:300 },
  chatScroll: { flex:1, overflowY:"auto" },
  chatInner: { maxWidth:680, margin:"0 auto", padding:"24px 40px 16px" },

  doveRow: { display:"flex", alignItems:"flex-start", gap:12, marginBottom:4 },
  doveAvatarDot: { width:8, height:8, borderRadius:"50%", background:"#2C5F3A", flexShrink:0, marginTop:8 },
  doveName: { fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#2C5F3A", margin:"0 0 8px" },
  doveText: {
    fontFamily:"'Cormorant Garamond',Georgia,serif",
    fontSize:19,
    fontWeight:300,
    color:"#1a1a1a",
    lineHeight:1.85,
    margin:0,
    maxWidth:"92%",
    letterSpacing:"0.01em",
  },
  userRow: { display:"flex", justifyContent:"flex-end", marginBottom:4 },
  userText: { background:"#F5F5F3", padding:"12px 16px", fontSize:15, color:"#111", lineHeight:1.65, maxWidth:"72%", fontWeight:400, margin:0 },

  viewGiftsBtn: { background:"#2C5F3A", color:"#fff", border:"none", padding:"12px 24px", fontSize:13, fontWeight:600, letterSpacing:"1px", textTransform:"uppercase", cursor:"pointer", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", boxShadow:"0 4px 0 #a8d4b4" },

  inputOuter: { borderTop:"1px solid #EDEBE6", padding:"18px 40px 22px", flexShrink:0 },
  inputWrap: { maxWidth:680, margin:"0 auto", display:"flex", alignItems:"flex-end", border:"1.5px solid #CDCAC4", background:"#fff" },
  textarea: { flex:1, border:"none", outline:"none", resize:"none", padding:"14px 18px", fontSize:16, color:"#111", background:"transparent", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", lineHeight:1.6, minHeight:50, fontWeight:300 },
  sendBtn: { width:50, height:50, background:"#2C5F3A", border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", flexShrink:0, alignSelf:"flex-end" },
  suggs: { maxWidth:680, margin:"14px auto 0", display:"flex", flexWrap:"wrap", gap:8 },
  suggBtn: { fontSize:12, color:"#666", background:"#F5F5F3", border:"1px solid #E8E5DF", padding:"7px 14px", cursor:"pointer", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", fontWeight:300 },
  privacyNote: { maxWidth:680, margin:"10px auto 0", fontSize:10, color:"#ccc", letterSpacing:"1px", textTransform:"uppercase", textAlign:"center" },

  // Results
  resultsOuter: { flex:1, display:"flex", flexDirection:"column", overflow:"hidden" },
  contextBar: { borderBottom:"1px solid #EDEBE6", flexShrink:0 },
  chip: { fontSize:10, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:"#2C5F3A", padding:"4px 12px", border:"1px solid #a8c8b4", background:"#eaf2ec", display:"inline-block" },
  chipMuted: { fontSize:10, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:"#bbb", padding:"4px 12px", border:"1px solid #eee", background:"#fafafa", display:"inline-block" },
  aiBar: { padding:"10px 28px 14px", display:"flex", gap:10, alignItems:"center", background:"#F9F7F4" },
  aiDot: { display:"inline-block", width:6, height:6, borderRadius:"50%", background:"#2C5F3A", flexShrink:0 },
  aiLbl: { fontSize:9, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#2C5F3A", flexShrink:0 },
  aiTxt: { fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:15, fontStyle:"italic", color:"#555" },

  resultsBody: { flex:1, display:"flex", overflow:"hidden" },
  gridWrap: { flex:1, overflowY:"auto", padding:"22px 28px" },
  gridMeta: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 },
  gridCnt: { fontSize:11, color:"#bbb", letterSpacing:"1px", textTransform:"uppercase" },
  sortBtn: { fontSize:11, color:"#bbb", background:"none", border:"none", cursor:"pointer", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", padding:"4px 10px" },
  sortOn: { color:"#111", borderBottom:"1.5px solid #111" },

  grid: { display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(180px, 1fr))", gap:"22px 12px" },
  card: { cursor:"pointer" },
  cardImg: { width:"100%", paddingBottom:"116%", position:"relative", overflow:"hidden" },
  heartBtn: { position:"absolute", top:8, right:8, width:28, height:28, background:"rgba(255,255,255,0.9)", border:"none", fontSize:13, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" },
  cardBody: { paddingTop:10 },
  tierBadge: { fontSize:9, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", display:"inline-block", padding:"2px 8px", marginBottom:6 },
  tierGold: { color:"#7a5c20", background:"#fdf5e6", border:"1px solid #e8d5a0" },
  tierPlat: { color:"#2a4a7a", background:"#eef3fa", border:"1px solid #b8cce8" },
  tierSilv: { color:"#666", background:"#f5f5f5", border:"1px solid #e0e0e0" },
  cardName: { fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:16, fontWeight:400, color:"#111", marginTop:0, lineHeight:1.3, margin:"0 0 3px" },
  cardCat: { fontSize:10, letterSpacing:"1.5px", textTransform:"uppercase", color:"#bbb", margin:"0 0 6px" },
  cardPrice: { fontSize:14, fontWeight:600, color:"#111", margin:0 },

  // Right panel
  rightPanel: { width:264, background:"#fff", borderLeft:"1px solid #EDEBE6", display:"flex", flexDirection:"column", flexShrink:0 },
  tabBar: { display:"flex", borderBottom:"1px solid #EDEBE6", flexShrink:0 },
  tab: { flex:1, padding:"13px 0", fontSize:11, fontWeight:600, letterSpacing:"1px", textTransform:"uppercase", color:"#bbb", background:"none", border:"none", cursor:"pointer", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", display:"flex", alignItems:"center", justifyContent:"center", gap:5 },
  tabOn: { color:"#111", borderBottom:"2px solid #111" },
  tabBadge: { background:"#2C5F3A", color:"#fff", fontSize:9, padding:"1px 5px", borderRadius:99, lineHeight:1.6 },
  slRow: { display:"flex", alignItems:"center", gap:10, padding:"11px 18px", borderBottom:"1px solid #F5F0E8" },
  slFooter: { padding:18, borderTop:"1px solid #EDEBE6", flexShrink:0 },
  btnGreen: { width:"100%", background:"#2C5F3A", color:"#fff", border:"none", padding:14, fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", fontSize:11, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", cursor:"pointer", boxShadow:"0 4px 0 #a8d4b4", display:"block" },

  // Modal
  modalOverlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:500, padding:32 },
  modalBox: { background:"#fff", width:"100%", maxWidth:820, maxHeight:"90vh", overflow:"hidden", position:"relative", display:"flex", flexDirection:"column" },
  modalClose: { position:"absolute", top:12, right:16, background:"none", border:"none", fontSize:28, color:"#aaa", cursor:"pointer", lineHeight:1, zIndex:10 },
  modalInner: { display:"flex", flex:1, minHeight:480, overflow:"hidden" },
  modalImg: { width:340, minWidth:340, flexShrink:0, background:"#f5f0eb", overflow:"hidden" },
  modalContent: { flex:1, padding:"32px 28px", overflowY:"auto" },
};
