import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase.js";

const CATALOGUE_URL = import.meta.env.VITE_CATALOGUE_SERVICE_URL ||
  "https://ikka-catalogue-service-production.up.railway.app";

const BG_COLORS = ["#F5EFE8","#EDF2EE","#EEF0F7","#F7EEF0","#F0EDE8","#EEF5F2","#F5F0E8","#EEF1F7","#F2EEF5"];
const TIER_LABEL = { Gold:"Gold", Silver:"Silver", Platinum:"Platinum" };

const SUGGESTIONS = [
  "Diwali gifts for senior leadership, around ₹3,000",
  "Client thank-you gift, something premium and personal",
  "Onboarding gifts for new joiners under ₹1,500",
  "Work anniversary gift for a long-serving employee",
];

function priceAtQty(tiers, qty) {
  if (!tiers?.length) return 0;
  const match = tiers
    .filter(t => qty >= t.min_qty && (t.max_qty === null || qty <= t.max_qty))
    .sort((a, b) => b.min_qty - a.min_qty)[0];
  return match ? parseFloat(match.price_per_unit) : parseFloat(tiers[0].price_per_unit);
}

function initials(name) {
  return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function formatBoxContents(text) {
  if (!text) return "";
  return text.replace(/([a-z])([A-Z])/g, "$1 · $2").replace(/\s*,\s*/g, " · ").replace(/\s*\|\s*/g, " · ");
}

export default function App() {
  const [session, setSession] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const productsRef = useRef([]);
  const [results, setResults] = useState([]);
  const [hearted, setHearted] = useState(new Set());
  const heartedProductsRef = useRef({});
  const [selectedProduct, setSelectedProduct] = useState(null);

  // Chat
  const [messages, setMessages] = useState([]);
  const [doveHistory, setDoveHistory] = useState([]);
  const [inputText, setInputText] = useState("");
  const [doveTyping, setDoveTyping] = useState(false);
  const [lastFilters, setLastFilters] = useState(null);
  const [queryHistory, setQueryHistory] = useState([]); // sidebar history
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);

  // View
  const [view, setView] = useState("chat");
  const [rightTab, setRightTab] = useState("shortlist");
  const [chips, setChips] = useState([]);
  const [aiMessage, setAiMessage] = useState("");
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

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, doveTyping]);

  const loadSession = async (token) => {
    const { data, error } = await supabase
      .from("rd_sessions").select("*").eq("token", token).single();
    if (error || !data) { setNotFound(true); return; }
    setSession(data);
    await supabase.from("rd_sessions").update({ last_active: new Date().toISOString() }).eq("id", data.id);
    await loadProducts();
    loadShortlist(data.id);
    const greeting = `Hello ${data.client_name.split(" ")[0]} — I'm Dove, your gifting concierge.\n\nTell me about your gifting need. Who are you gifting, and what's the occasion?`;
    setTimeout(() => {
      setMessages([{ role: "dove", text: greeting }]);
      setDoveHistory([{ role: "assistant", content: greeting }]);
    }, 400);
  };

  const loadProducts = async () => {
    const { data } = await supabase.from("catalog")
      .select("*, pricing_tiers(*), product_tags(tag, dimension)")
      .eq("active", true)
      .order("popularity", { ascending: false });
    if (data) {
      productsRef.current = data.map((p, i) => ({
        ...p,
        _bg: BG_COLORS[i % BG_COLORS.length],
        _price: priceAtQty(p.pricing_tiers, 1),
        _tags: (p.product_tags || []).map(t => t.tag.toLowerCase()),
      }));
    }
  };

  const loadShortlist = async (sessionId) => {
    const { data } = await supabase.from("rd_shortlists").select("product_id").eq("session_id", sessionId);
    if (data) {
      const ids = new Set(data.map(r => r.product_id));
      setHearted(ids);
    }
  };

  const logEvent = useCallback(async (type, pid=null, meta={}) => {
    if (!session) return;
    await supabase.from("rd_events").insert([{ session_id: session.id, event_type: type, product_id: pid, metadata: meta }]);
  }, [session]);

  const saveConvo = useCallback(async (role, message) => {
    if (!session) return;
    await supabase.from("rd_conversations").insert([{ session_id: session.id, role, message }]);
  }, [session]);

  const callDove = async (userMessage, history) => {
    const res = await fetch(CATALOGUE_URL + "/dove-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

    // Build chips
    const newChips = [];
    if (filters.occasion && filters.occasion !== "other") newChips.push(filters.occasion.toUpperCase().replace(/-/g," "));
    if (filters.audience && filters.audience !== "other") newChips.push(filters.audience.toUpperCase().replace(/-/g," "));
    if (budget) newChips.push(`₹${budget.toLocaleString("en-IN")} / UNIT`);
    if (filters.exclude_edible) newChips.push({ label:"NON-EDIBLE", muted:true });
    if (filters.exclude_fragile) newChips.push({ label:"NON-FRAGILE", muted:true });
    setChips(newChips);

    try {
      // Pre-filter hard constraints
      const candidates = allProducts.filter(p => {
        const price = priceAtQty(p.pricing_tiers, qty);
        if (budget && price > budget * 1.2) return false;
        if (filters.exclude_edible && p.edible) return false;
        if (filters.exclude_fragile && p.fragile) return false;
        return true;
      }).map(p => ({
        id: p.id,
        name: p.name,
        category: p.category || "",
        description: p.description || "",
        whats_in_box: p.whats_in_box || "",
        price: priceAtQty(p.pricing_tiers, qty),
        tier: p.tier || "",
        tags: p._tags.join(", "),
      }));

      // Ask Claude to rank
      const rankRes = await fetch(CATALOGUE_URL + "/dove-rank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brief: filters.query || "",
          budget: filters.budget || null,
          exclude_edible: filters.exclude_edible || false,
          exclude_fragile: filters.exclude_fragile || false,
          products: candidates,
        }),
      });
      const ranked = await rankRes.json();

      setAiMessage(ranked.summary || "Here are your curated gifts.");
      saveConvo("assistant", ranked.summary || "");

      const idOrder = ranked.ranked_ids || [];
      const productMap = {};
      allProducts.forEach(p => { productMap[p.id] = { ...p, _price: priceAtQty(p.pricing_tiers, qty) }; });

      const ordered = idOrder.map(id => productMap[id]).filter(Boolean);
      const rankedSet = new Set(idOrder);
      const rest = candidates
        .filter(c => !rankedSet.has(c.id))
        .map(c => productMap[c.id])
        .filter(Boolean);

      setResults([...ordered, ...rest]);
      setSort("rec");
    } catch(e) {
      console.error(e);
      const fallback = allProducts
        .filter(p => !budget || priceAtQty(p.pricing_tiers, qty) <= budget * 1.2)
        .map(p => ({ ...p, _price: priceAtQty(p.pricing_tiers, qty) }));
      setResults(fallback);
      setAiMessage("Here are our curated gifts for you.");
    }
    setRanking(false);
  };

  const handleSend = async (text) => {
    const msg = (text || inputText).trim();
    if (!msg || doveTyping || ranking) return;
    setInputText("");
    setMessages(prev => [...prev, { role: "user", text: msg }]);
    setQueryHistory(prev => [msg, ...prev.filter(q => q !== msg)].slice(0, 8));
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
        : lastFilters ? { ...lastFilters, query: (lastFilters.query||"") + ". " + text }
        : null;
      if (filters) { setLastFilters(filters); await runCuration(filters); }
    } catch(e) {
      setMessages(prev => [...prev, { role:"dove", text:"Let me try again — could you describe what you're looking for?" }]);
    }
    setRefineLoading(false);
  };

  const toggleHeart = async (productId, productObj) => {
    if (!session) return;
    const isHearted = hearted.has(productId);
    const newHearted = new Set(hearted);
    if (isHearted) {
      newHearted.delete(productId);
      delete heartedProductsRef.current[productId];
      await supabase.from("rd_shortlists").delete().eq("session_id", session.id).eq("product_id", productId);
      logEvent("shortlist_remove", productId);
    } else {
      newHearted.add(productId);
      if (productObj) heartedProductsRef.current[productId] = productObj;
      await supabase.from("rd_shortlists").insert([{ session_id: session.id, product_id: productId }]);
      logEvent("shortlist_add", productId);
    }
    setHearted(newHearted);
  };

  const submitShortlist = async () => {
    if (!session || hearted.size === 0) return;
    setSubmitting(true);
    const items = Object.values(heartedProductsRef.current);
    logEvent("shortlist_submit", null, { product_ids: [...hearted], count: hearted.size });
    saveConvo("user", `Submitted shortlist: ${items.map(p=>p.name).join(", ")}`);
    setTimeout(() => { setView("submitted"); setSubmitting(false); }, 800);
  };

  const sortedResults = [...results].sort((a,b) => {
    if (sort==="asc") return a._price - b._price;
    if (sort==="desc") return b._price - a._price;
    return 0;
  });

  const shortlistItems = [...hearted].map(id =>
    heartedProductsRef.current[id] || results.find(p => p.id === id)
  ).filter(Boolean);
  const totalEstimate = shortlistItems.reduce((s,p) => s+(p._price||0), 0);

  const S = styles;

  if (notFound) return (
    <div style={S.fullCenter}>
      <Logo />
      <p style={{ fontSize:15, color:"#666", marginTop:24 }}>This link is invalid or has expired.</p>
      <p style={{ fontSize:13, color:"#bbb", marginTop:8 }}>Please contact your Rock Dove curator for a new link.</p>
    </div>
  );

  if (!session) return (
    <div style={S.fullCenter}>
      <Logo />
      <p style={{ fontSize:11, color:"#bbb", letterSpacing:"2px", textTransform:"uppercase", marginTop:20 }}>Loading your experience…</p>
    </div>
  );

  if (view === "submitted") return (
    <div style={S.fullCenter}>
      <div style={{ width:52, height:52, borderRadius:"50%", background:"#2C5F3A", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, marginBottom:22 }}>✓</div>
      <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:30, fontWeight:500, color:"#111", marginBottom:10 }}>Shortlist sent</div>
      <p style={{ fontSize:14, color:"#888", maxWidth:380, lineHeight:1.8, marginBottom:32, textAlign:"center" }}>
        Thank you, {session.client_name.split(" ")[0]}. We'll follow up within 24 hours with availability and final pricing.
      </p>
      <div style={{ width:"100%", maxWidth:380 }}>
        {shortlistItems.map(p => (
          <div key={p.id} style={{ display:"flex", alignItems:"center", gap:14, padding:"13px 0", borderBottom:"1px solid #f0f0f0" }}>
            <div style={{ width:46, height:56, background:p._bg||"#f5f0eb", flexShrink:0, overflow:"hidden" }}>
              {p.image_url && <img src={p.image_url} alt={p.name} style={{ width:"100%", height:"100%", objectFit:"cover" }} />}
            </div>
            <div>
              <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:16, fontWeight:500, color:"#111", marginBottom:3 }}>{p.name}</div>
              <div style={{ fontSize:13, color:"#aaa" }}>₹{(p._price||0).toLocaleString("en-IN")}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div style={S.app}>

      {/* ── LEFT SIDEBAR ── */}
      <div style={S.sidebar}>
        <div style={S.sideTop}>
          <Logo small />
          <div style={S.sideClient}>
            <div style={S.av}>{initials(session.client_name)}</div>
            <div>
              <div style={S.cname}>{session.client_name}</div>
              {session.client_company && <div style={S.cco}>{session.client_company}</div>}
            </div>
          </div>
        </div>

        {view === "results" && (
          <button style={S.sideNewBtn} onClick={() => { setView("chat"); setResults([]); setChips([]); setAiMessage(""); }}>
            + New search
          </button>
        )}

        {queryHistory.length > 0 && (
          <div style={S.sideSection}>
            <div style={S.sideSectionLabel}>This session</div>
            {queryHistory.map((q, i) => (
              <button key={i} style={S.sideQuery} onClick={() => {
                setView("chat");
                setTimeout(() => handleSend(q), 100);
              }}>
                <span style={S.sideQueryIcon}>↺</span>
                <span style={S.sideQueryText}>{q.length > 38 ? q.slice(0, 38) + "…" : q}</span>
              </button>
            ))}
          </div>
        )}

        <div style={S.sideFooter}>
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <span style={{ ...S.doveDot, background:"#2C5F3A" }}></span>
            <span style={{ fontSize:10, color:"#bbb", letterSpacing:"1.5px", textTransform:"uppercase" }}>Rock Dove · Gift Intelligence</span>
          </div>
        </div>
      </div>

      {/* ── MAIN AREA ── */}
      <div style={S.main}>

        {/* CHAT VIEW */}
        {view === "chat" && (
          <div style={S.chatOuter}>
            {/* Messages */}
            <div style={S.chatMessages}>
              <div style={S.chatMessagesInner}>
                {messages.map((m, i) => (
                  <div key={i} style={m.role==="dove" ? S.doveRow : S.userRow}>
                    {m.role === "dove" && (
                      <div style={S.doveAvatar}><span style={S.doveDot}></span></div>
                    )}
                    <div style={m.role==="dove" ? S.doveMsg : S.userMsg}>
                      {m.text.split("\n").map((line,j,arr) => (
                        <span key={j}>{line}{j<arr.length-1&&<br/>}</span>
                      ))}
                    </div>
                  </div>
                ))}

                {doveTyping && (
                  <div style={S.doveRow}>
                    <div style={S.doveAvatar}><span style={S.doveDot}></span></div>
                    <div style={{ ...S.doveMsg, display:"flex", gap:5, alignItems:"center", padding:"14px 18px" }}>
                      <span className="td"></span>
                      <span className="td" style={{ animationDelay:"0.2s" }}></span>
                      <span className="td" style={{ animationDelay:"0.4s" }}></span>
                    </div>
                  </div>
                )}

                {ranking && (
                  <div style={S.doveRow}>
                    <div style={S.doveAvatar}><span style={S.doveDot}></span></div>
                    <div style={S.doveMsg}>Curating your selection from our catalogue…</div>
                  </div>
                )}

                {results.length > 0 && !ranking && (
                  <div style={{ textAlign:"center", margin:"24px 0" }}>
                    <button style={S.viewGiftsBtn} onClick={() => setView("results")}>
                      View {results.length} curated gifts →
                    </button>
                  </div>
                )}

                <div ref={chatEndRef} />
              </div>
            </div>

            {/* Input area */}
            <div style={S.chatInputOuter}>
              <div style={S.chatInputWrap}>
                <textarea
                  ref={inputRef}
                  style={S.chatTextarea}
                  value={inputText}
                  onChange={e => setInputText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder="Tell Dove about your gifting need…"
                  disabled={doveTyping || ranking}
                  rows={1}
                />
                <button
                  style={{ ...S.sendBtn, ...(!inputText.trim()||doveTyping||ranking ? { opacity:0.35, cursor:"not-allowed" } : {}) }}
                  onClick={() => handleSend()}
                  disabled={!inputText.trim()||doveTyping||ranking}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                  </svg>
                </button>
              </div>

              {/* Suggestions — show when conversation is just starting */}
              {messages.length <= 1 && (
                <div style={S.suggestions}>
                  {SUGGESTIONS.map((s, i) => (
                    <button key={i} style={S.suggestionChip} onClick={() => handleSend(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              )}

              <p style={S.privacyNote}>Your conversation is private and shared only with Rock Dove</p>
            </div>
          </div>
        )}

        {/* RESULTS VIEW */}
        {view === "results" && (
          <div style={S.resultsOuter}>
            {/* Context bar */}
            {(chips.length > 0 || aiMessage) && (
              <div style={S.contextBar}>
                <div style={S.chipsRow}>
                  {chips.map((c,i) => (
                    <div key={i} style={typeof c==="string"?S.chip:S.chipMuted}>
                      {typeof c==="string"?c:c.label}
                    </div>
                  ))}
                </div>
                {aiMessage && (
                  <div style={S.aiMsg}>
                    <span style={S.doveDot}></span>
                    <span style={S.aiLbl}>Dove</span>
                    <span style={S.aiTxt}>{aiMessage}</span>
                  </div>
                )}
              </div>
            )}

            <div style={S.resultsBody}>
              {/* Grid */}
              <div style={S.gridWrap}>
                <div style={S.gridMeta}>
                  <div style={S.gridCnt}>{ranking ? "Curating…" : `${results.length} gifts curated`}</div>
                  <div style={{ display:"flex", gap:4 }}>
                    {[["rec","Recommended"],["asc","Price ↑"],["desc","Price ↓"]].map(([v,l]) => (
                      <button key={v} style={{ ...S.sortBtn, ...(sort===v?S.sortBtnOn:{}) }} onClick={() => setSort(v)}>{l}</button>
                    ))}
                  </div>
                </div>

                {ranking ? (
                  <div style={{ textAlign:"center", padding:"80px 0", color:"#bbb", fontSize:13, letterSpacing:"1px" }}>
                    Dove is reviewing our catalogue for you…
                  </div>
                ) : (
                  <div style={S.grid}>
                    {sortedResults.map(p => (
                      <div key={p.id} style={S.card}>
                        <div style={{ ...S.cardImg, background:p._bg||"#f5f0eb" }}
                          onClick={() => { setSelectedProduct(p); logEvent("product_view", p.id); }}>
                          {p.image_url ? (
                            <img src={p.image_url} alt={p.name} style={{ position:"absolute", inset:0, width:"100%", height:"100%", objectFit:"cover" }} />
                          ) : (
                            <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                              <span style={{ fontSize:10, letterSpacing:"2px", color:"#bbb", textTransform:"uppercase" }}>{p.category}</span>
                            </div>
                          )}
                          <button style={{ ...S.heartBtn, ...(hearted.has(p.id)?S.heartBtnOn:{}) }}
                            onClick={e => { e.stopPropagation(); toggleHeart(p.id, p); }}>
                            {hearted.has(p.id)?"♥":"♡"}
                          </button>
                        </div>
                        <div style={S.cardBody} onClick={() => { setSelectedProduct(p); logEvent("product_view", p.id); }}>
                          <div style={{ marginBottom:6 }}>
                            <span style={{ ...S.tierBadge, ...(p.tier==="Gold"?S.tierGold:p.tier==="Platinum"?S.tierPlat:S.tierSilv) }}>
                              {TIER_LABEL[p.tier]||p.tier}
                            </span>
                          </div>
                          <div style={S.cardName}>{p.name}</div>
                          <div style={S.cardCat}>{p.category}</div>
                          <div style={S.cardPrice}>₹{p._price.toLocaleString("en-IN")}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Right panel */}
              <div style={S.rightPanel}>
                <div style={S.tabBar}>
                  <button style={{ ...S.tab, ...(rightTab==="shortlist"?S.tabActive:{}) }} onClick={() => setRightTab("shortlist")}>
                    Shortlist {hearted.size > 0 && <span style={S.tabBadge}>{hearted.size}</span>}
                  </button>
                  <button style={{ ...S.tab, ...(rightTab==="dove"?S.tabActive:{}) }} onClick={() => setRightTab("dove")}>
                    <span style={{ ...S.doveDot, background:rightTab==="dove"?"#2C5F3A":"#ccc", marginRight:5 }}></span>
                    Dove
                  </button>
                </div>

                {/* Shortlist tab */}
                {rightTab === "shortlist" && (
                  <>
                    <div style={{ flex:1, overflowY:"auto" }}>
                      {hearted.size === 0 ? (
                        <div style={S.slEmpty}>Heart a gift<br/>to save it here</div>
                      ) : shortlistItems.map(p => (
                        <div key={p.id} style={S.slRow}>
                          <div style={{ width:44, height:52, background:p._bg||"#f5f0eb", flexShrink:0, overflow:"hidden", cursor:"pointer" }}
                            onClick={() => setSelectedProduct(p)}>
                            {p.image_url && <img src={p.image_url} alt={p.name} style={{ width:"100%", height:"100%", objectFit:"cover" }} />}
                          </div>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={S.slName}>{p.name}</div>
                            <div style={S.slPrice}>₹{(p._price||0).toLocaleString("en-IN")}</div>
                          </div>
                          <button style={S.slRm} onClick={() => toggleHeart(p.id, p)}>×</button>
                        </div>
                      ))}
                    </div>
                    <div style={S.slFooter}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:14, paddingBottom:14, borderBottom:"1px solid #f0ece4" }}>
                        <span style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#aaa" }}>Total</span>
                        <span style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:22, fontWeight:500, color:"#111" }}>
                          {hearted.size===0?"—":`₹${totalEstimate.toLocaleString("en-IN")}`}
                        </span>
                      </div>
                      <button
                        style={{ ...S.btnGreen, ...(hearted.size===0?{ opacity:0.4, cursor:"not-allowed", boxShadow:"none" }:{}) }}
                        onClick={submitShortlist} disabled={hearted.size===0||submitting}
                      >
                        {submitting?"Sending…":"Send to Rock Dove →"}
                      </button>
                      <p style={{ fontSize:10, color:"#bbb", textAlign:"center", marginTop:10, letterSpacing:"0.5px" }}>We follow up within 24 hours</p>
                    </div>
                  </>
                )}

                {/* Dove tab */}
                {rightTab === "dove" && (
                  <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
                    <div style={{ flex:1, overflowY:"auto", padding:"16px" }}>
                      {messages.map((m,i) => (
                        <div key={i} style={{ marginBottom:14, display:"flex", flexDirection:"column", alignItems: m.role==="dove"?"flex-start":"flex-end" }}>
                          {m.role==="dove" && (
                            <div style={{ ...S.doveLbl, marginBottom:5 }}><span style={S.doveDot}></span>Dove</div>
                          )}
                          <div style={m.role==="dove"
                            ? { fontSize:13, color:"#333", lineHeight:1.7, maxWidth:"95%", padding:"10px 0" }
                            : { fontSize:13, background:"#f5f5f3", color:"#111", lineHeight:1.65, maxWidth:"90%", padding:"10px 14px" }
                          }>
                            {m.text.split("\n").map((line,j,arr) => (
                              <span key={j}>{line}{j<arr.length-1&&<br/>}</span>
                            ))}
                          </div>
                        </div>
                      ))}
                      {(refineLoading) && (
                        <div style={{ marginBottom:14 }}>
                          <div style={{ ...S.doveLbl, marginBottom:5 }}><span style={S.doveDot}></span>Dove</div>
                          <div style={{ display:"flex", gap:4, alignItems:"center", padding:"8px 0" }}>
                            <span className="td"></span><span className="td" style={{ animationDelay:"0.2s" }}></span><span className="td" style={{ animationDelay:"0.4s" }}></span>
                          </div>
                        </div>
                      )}
                    </div>
                    <div style={{ padding:"12px 14px", borderTop:"1px solid #eeebe6" }}>
                      <div style={{ display:"flex", border:"1px solid #ddd", background:"#fff" }}>
                        <input
                          style={{ flex:1, border:"none", outline:"none", padding:"10px 14px", fontSize:13, background:"transparent", color:"#111" }}
                          value={refineText}
                          onChange={e => setRefineText(e.target.value)}
                          onKeyDown={e => e.key==="Enter" && handleRefine()}
                          placeholder="Refine your search…"
                          disabled={refineLoading}
                        />
                        <button
                          style={{ width:40, background:"#2C5F3A", border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", ...(!refineText.trim()||refineLoading?{ opacity:0.3, cursor:"not-allowed" }:{}) }}
                          onClick={handleRefine} disabled={!refineText.trim()||refineLoading}
                        >
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

      {/* PRODUCT MODAL */}
      {selectedProduct && (
        <div style={S.modalOverlay} onClick={() => setSelectedProduct(null)}>
          <div style={S.modalBox} onClick={e => e.stopPropagation()}>
            <button style={S.modalClose} onClick={() => setSelectedProduct(null)}>×</button>
            <div style={S.modalInner}>
              <div style={S.modalImg}>
                {selectedProduct.image_url ? (
                  <img src={selectedProduct.image_url} alt={selectedProduct.name}
                    style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} />
                ) : (
                  <div style={{ width:"100%", height:"100%", background:selectedProduct._bg||"#f5f0eb", display:"flex", alignItems:"center", justifyContent:"center" }}>
                    <span style={{ fontSize:11, letterSpacing:"2px", color:"#bbb", textTransform:"uppercase" }}>{selectedProduct.category}</span>
                  </div>
                )}
              </div>
              <div style={S.modalContent}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
                  <span style={{ ...S.tierBadge, ...(selectedProduct.tier==="Gold"?S.tierGold:selectedProduct.tier==="Platinum"?S.tierPlat:S.tierSilv) }}>
                    {TIER_LABEL[selectedProduct.tier]||selectedProduct.tier}
                  </span>
                  <button style={{ background:"none", border:"none", fontSize:24, color: hearted.has(selectedProduct.id)?"#9B3A2A":"#ddd", cursor:"pointer" }}
                    onClick={() => toggleHeart(selectedProduct.id, selectedProduct)}>
                    {hearted.has(selectedProduct.id)?"♥":"♡"}
                  </button>
                </div>
                <h2 style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:26, fontWeight:500, color:"#111", lineHeight:1.25, margin:"0 0 6px" }}>
                  {selectedProduct.name}
                </h2>
                <p style={{ fontSize:11, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 18px" }}>
                  {selectedProduct.category}
                </p>
                <p style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:28, fontWeight:500, color:"#111", margin:"0 0 22px" }}>
                  ₹{(selectedProduct._price||0).toLocaleString("en-IN")}
                </p>
                {selectedProduct.description && (
                  <p style={{ fontSize:14, color:"#555", lineHeight:1.8, margin:"0 0 22px" }}>{selectedProduct.description}</p>
                )}
                {selectedProduct.whats_in_box && (
                  <div style={{ marginBottom:20, paddingBottom:18, borderBottom:"1px solid #f0f0f0" }}>
                    <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 8px" }}>What's in the box</p>
                    <p style={{ fontSize:14, color:"#555", lineHeight:1.8, margin:0 }}>{formatBoxContents(selectedProduct.whats_in_box)}</p>
                  </div>
                )}
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"12px 24px", marginBottom:24 }}>
                  {selectedProduct.moq && <div>
                    <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 4px" }}>Min. Order</p>
                    <p style={{ fontSize:14, color:"#333", margin:0 }}>{selectedProduct.moq} units</p>
                  </div>}
                  {selectedProduct.lead_time && <div>
                    <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 4px" }}>Lead Time</p>
                    <p style={{ fontSize:14, color:"#333", margin:0 }}>{selectedProduct.lead_time}</p>
                  </div>}
                  {selectedProduct.box_dimensions && <div>
                    <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 4px" }}>Dimensions</p>
                    <p style={{ fontSize:14, color:"#333", margin:0 }}>{selectedProduct.box_dimensions}</p>
                  </div>}
                  {selectedProduct.weight_grams && <div>
                    <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 4px" }}>Weight</p>
                    <p style={{ fontSize:14, color:"#333", margin:0 }}>{selectedProduct.weight_grams}g</p>
                  </div>}
                </div>
                <button
                  style={{ ...S.btnGreen, ...(hearted.has(selectedProduct.id)?{ background:"#9B3A2A", boxShadow:"0 4px 0 #e8b4a8" }:{}) }}
                  onClick={() => toggleHeart(selectedProduct.id, selectedProduct)}
                >
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

function Logo({ small }) {
  return (
    <div style={{ lineHeight:1 }}>
      <div style={{ display:"flex", alignItems:"baseline", gap:4 }}>
        <span style={{ fontSize: small?13:18, fontWeight:600, letterSpacing: small?4:5, textTransform:"uppercase", color:"#111", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif" }}>Rock</span>
        <span style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize: small?18:24, fontStyle:"italic", color:"#2C5F3A", fontWeight:500 }}>Dove</span>
      </div>
      {!small && <div style={{ fontSize:9, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", marginTop:3 }}>by Ikka Dukka · Gift Intelligence</div>}
    </div>
  );
}

const styles = {
  app: { display:"flex", height:"100vh", overflow:"hidden", background:"#fff", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", color:"#111" },
  fullCenter: { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100vh", textAlign:"center", padding:32, fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif" },

  // Sidebar
  sidebar: { width:220, background:"#FAFAF8", borderRight:"1px solid #EDEBE6", display:"flex", flexDirection:"column", flexShrink:0, padding:"24px 0" },
  sideTop: { padding:"0 16px 20px", borderBottom:"1px solid #EDEBE6", marginBottom:16 },
  sideClient: { display:"flex", alignItems:"center", gap:10, marginTop:20, padding:"12px 0 0" },
  av: { width:34, height:34, borderRadius:"50%", background:"#7A90B0", fontSize:11, fontWeight:600, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  cname: { fontSize:12, fontWeight:600, color:"#111", letterSpacing:"0.3px", lineHeight:1.3 },
  cco: { fontSize:11, color:"#aaa", marginTop:1 },
  sideNewBtn: { margin:"0 12px 16px", padding:"9px 14px", background:"transparent", border:"1px solid #DDD", fontSize:12, fontWeight:500, color:"#444", cursor:"pointer", textAlign:"left", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", letterSpacing:"0.3px" },
  sideSection: { padding:"0 12px", flex:1, overflowY:"auto" },
  sideSectionLabel: { fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", marginBottom:8, padding:"0 4px" },
  sideQuery: { display:"flex", alignItems:"flex-start", gap:8, width:"100%", padding:"8px 8px", background:"none", border:"none", cursor:"pointer", textAlign:"left", borderRadius:4, marginBottom:2, fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif" },
  sideQueryIcon: { fontSize:12, color:"#bbb", flexShrink:0, marginTop:1 },
  sideQueryText: { fontSize:12, color:"#555", lineHeight:1.5 },
  sideFooter: { padding:"16px 16px 0", borderTop:"1px solid #EDEBE6", marginTop:"auto" },

  // Main
  main: { flex:1, display:"flex", flexDirection:"column", overflow:"hidden" },

  // Chat
  chatOuter: { flex:1, display:"flex", flexDirection:"column", overflow:"hidden" },
  chatMessages: { flex:1, overflowY:"auto" },
  chatMessagesInner: { maxWidth:720, margin:"0 auto", padding:"40px 40px 20px" },

  doveRow: { display:"flex", alignItems:"flex-start", gap:10, marginBottom:24 },
  userRow: { display:"flex", justifyContent:"flex-end", marginBottom:24 },
  doveAvatar: { width:20, height:20, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", marginTop:4 },
  doveDot: { display:"inline-block", width:8, height:8, borderRadius:"50%", background:"#2C5F3A", flexShrink:0 },
  doveMsg: { flex:1, fontSize:16, color:"#1a1a1a", lineHeight:1.85, fontWeight:400, maxWidth:"92%" },
  userMsg: { background:"#F5F5F3", padding:"12px 16px", fontSize:15, color:"#111", lineHeight:1.65, maxWidth:"72%", fontWeight:400 },

  doveLbl: { display:"flex", alignItems:"center", gap:6, fontSize:10, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:"#2C5F3A" },

  chatInputOuter: { borderTop:"1px solid #EDEBE6", padding:"20px 40px 24px", flexShrink:0 },
  chatInputWrap: { maxWidth:720, margin:"0 auto", display:"flex", alignItems:"flex-end", border:"1.5px solid #CDCAC4", background:"#fff", gap:0 },
  chatTextarea: { flex:1, border:"none", outline:"none", resize:"none", padding:"14px 18px", fontSize:15, color:"#111", background:"transparent", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", lineHeight:1.6, minHeight:50 },
  sendBtn: { width:50, height:50, background:"#2C5F3A", border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", flexShrink:0, alignSelf:"flex-end" },

  suggestions: { maxWidth:720, margin:"16px auto 0", display:"flex", flexWrap:"wrap", gap:8 },
  suggestionChip: { fontSize:12, color:"#666", background:"#F5F5F3", border:"1px solid #E8E5DF", padding:"7px 14px", cursor:"pointer", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", textAlign:"left" },
  privacyNote: { maxWidth:720, margin:"12px auto 0", fontSize:10, color:"#bbb", letterSpacing:"1px", textTransform:"uppercase", textAlign:"center" },
  viewGiftsBtn: { background:"#2C5F3A", color:"#fff", border:"none", padding:"13px 28px", fontSize:13, fontWeight:600, letterSpacing:"1px", textTransform:"uppercase", cursor:"pointer", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", boxShadow:"0 4px 0 #a8d4b4" },

  // Results
  resultsOuter: { flex:1, display:"flex", flexDirection:"column", overflow:"hidden" },
  contextBar: { borderBottom:"1px solid #EDEBE6", flexShrink:0 },
  chipsRow: { padding:"10px 28px", display:"flex", gap:6, flexWrap:"wrap" },
  chip: { fontSize:10, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:"#2C5F3A", padding:"5px 12px", border:"1px solid #a8c8b4", background:"#eaf2ec" },
  chipMuted: { fontSize:10, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:"#bbb", padding:"5px 12px", border:"1px solid #eee", background:"#fafafa" },
  aiMsg: { padding:"10px 28px 14px", display:"flex", gap:10, alignItems:"center", background:"#F9F7F4" },
  aiLbl: { fontSize:9, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#2C5F3A" },
  aiTxt: { fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:15, fontStyle:"italic", color:"#555" },

  resultsBody: { flex:1, display:"flex", overflow:"hidden" },
  gridWrap: { flex:1, overflowY:"auto", padding:"24px 28px" },
  gridMeta: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 },
  gridCnt: { fontSize:11, color:"#bbb", letterSpacing:"1px", textTransform:"uppercase" },
  sortBtn: { fontSize:11, color:"#bbb", background:"none", border:"none", cursor:"pointer", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", padding:"5px 10px", letterSpacing:"0.5px" },
  sortBtnOn: { color:"#111", borderBottom:"1.5px solid #111" },

  grid: { display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(185px, 1fr))", gap:"24px 14px" },
  card: { cursor:"pointer" },
  cardImg: { width:"100%", paddingBottom:"116%", position:"relative", overflow:"hidden" },
  heartBtn: { position:"absolute", top:8, right:8, width:28, height:28, background:"rgba(255,255,255,0.9)", border:"none", fontSize:13, color:"#ccc", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" },
  heartBtnOn: { color:"#9B3A2A" },
  cardBody: { paddingTop:10 },
  tierBadge: { fontSize:9, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", display:"inline-block", padding:"3px 8px" },
  tierGold: { color:"#7a5c20", background:"#fdf5e6", border:"1px solid #e8d5a0" },
  tierPlat: { color:"#2a4a7a", background:"#eef3fa", border:"1px solid #b8cce8" },
  tierSilv: { color:"#666", background:"#f5f5f5", border:"1px solid #e0e0e0" },
  cardName: { fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:16, fontWeight:500, color:"#111", marginTop:6, lineHeight:1.3 },
  cardCat: { fontSize:10, letterSpacing:"1.5px", textTransform:"uppercase", color:"#bbb", marginTop:3 },
  cardPrice: { fontSize:14, fontWeight:600, color:"#111", marginTop:8 },

  // Right panel
  rightPanel: { width:268, background:"#fff", borderLeft:"1px solid #EDEBE6", display:"flex", flexDirection:"column", flexShrink:0 },
  tabBar: { display:"flex", borderBottom:"1px solid #EDEBE6", flexShrink:0 },
  tab: { flex:1, padding:"13px 0", fontSize:11, fontWeight:600, letterSpacing:"1px", textTransform:"uppercase", color:"#bbb", background:"none", border:"none", cursor:"pointer", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", display:"flex", alignItems:"center", justifyContent:"center", gap:5 },
  tabActive: { color:"#111", borderBottom:"2px solid #111" },
  tabBadge: { background:"#2C5F3A", color:"#fff", fontSize:9, padding:"1px 5px", borderRadius:99, lineHeight:1.6 },
  slEmpty: { padding:"36px 20px", fontSize:12, color:"#ccc", textAlign:"center", lineHeight:1.8 },
  slRow: { display:"flex", alignItems:"center", gap:10, padding:"11px 18px", borderBottom:"1px solid #F5F0E8" },
  slName: { fontSize:12, fontWeight:500, color:"#111", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", marginBottom:2 },
  slPrice: { fontSize:11, color:"#aaa" },
  slRm: { background:"none", border:"none", color:"#ccc", cursor:"pointer", fontSize:18, padding:0, lineHeight:1, flexShrink:0 },
  slFooter: { padding:18, borderTop:"1px solid #EDEBE6", flexShrink:0 },
  btnGreen: { width:"100%", background:"#2C5F3A", color:"#fff", border:"none", padding:14, fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", fontSize:11, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", cursor:"pointer", boxShadow:"0 4px 0 #a8d4b4", display:"block" },

  // Modal
  modalOverlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:500, padding:32 },
  modalBox: { background:"#fff", width:"100%", maxWidth:840, maxHeight:"90vh", overflow:"hidden", position:"relative", display:"flex", flexDirection:"column" },
  modalClose: { position:"absolute", top:12, right:16, background:"none", border:"none", fontSize:28, color:"#aaa", cursor:"pointer", lineHeight:1, zIndex:10 },
  modalInner: { display:"flex", flex:1, minHeight:500, overflow:"hidden" },
  modalImg: { width:360, minWidth:360, flexShrink:0, background:"#f5f0eb", overflow:"hidden" },
  modalContent: { flex:1, padding:"36px 32px", overflowY:"auto" },
};
