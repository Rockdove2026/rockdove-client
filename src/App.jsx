import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase.js";

const CATALOGUE_URL = import.meta.env.VITE_CATALOGUE_SERVICE_URL ||
  "https://ikka-catalogue-service-production.up.railway.app";

const BG_COLORS = ["#F5EFE8","#EDF2EE","#EEF0F7","#F7EEF0","#F0EDE8","#EEF5F2","#F5F0E8","#EEF1F7","#F2EEF5"];
const TIER_LABEL = { Gold:"Gold", Silver:"Silver", Platinum:"Platinum" };

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
  const [selectedProduct, setSelectedProduct] = useState(null);

  // Conversation
  const [messages, setMessages] = useState([]);
  const [doveHistory, setDoveHistory] = useState([]); // for Claude context
  const [inputText, setInputText] = useState("");
  const [doveTyping, setDoveTyping] = useState(false);
  const [curationDone, setCurationDone] = useState(false);
  const messagesEndRef = useRef(null);

  // Results
  const [view, setView] = useState("chat");
  const [chips, setChips] = useState([]);
  const [aiMessage, setAiMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState("rec");
  const [submitting, setSubmitting] = useState(false);
  const [askDoveOpen, setAskDoveOpen] = useState(false);
  const [askDoveText, setAskDoveText] = useState("");
  const [askDoveLoading, setAskDoveLoading] = useState(false);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token") ||
      window.location.pathname.split("/").pop();
    if (token && token !== "/") loadSession(token);
    else setNotFound(true);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, doveTyping]);

  const loadSession = async (token) => {
    const { data, error } = await supabase
      .from("rd_sessions").select("*").eq("token", token).single();
    if (error || !data) { setNotFound(true); return; }
    setSession(data);
    await supabase.from("rd_sessions").update({ last_active: new Date().toISOString() }).eq("id", data.id);
    await loadProducts();
    loadShortlist(data.id);
    const greeting = `Hello ${data.client_name.split(" ")[0]} — I'm Dove, your gifting concierge at Rock Dove.\n\nTell me about your gifting need. Who are you gifting, and what's the occasion?`;
    setTimeout(() => {
      setMessages([{ role: "dove", text: greeting }]);
      setDoveHistory([{ role: "assistant", content: greeting }]);
    }, 600);
  };

  const loadProducts = async () => {
    const { data } = await supabase.from("catalog")
      .select("*, pricing_tiers(*)")
      .eq("active", true)
      .order("popularity", { ascending: false });
    if (data) {
      productsRef.current = data.map((p, i) => ({
        ...p, _bg: BG_COLORS[i % BG_COLORS.length], _price: priceAtQty(p.pricing_tiers, 1),
      }));
    }
  };

  const loadShortlist = async (sessionId) => {
    const { data } = await supabase.from("rd_shortlists").select("product_id").eq("session_id", sessionId);
    if (data) setHearted(new Set(data.map(r => r.product_id)));
  };

  const logEvent = useCallback(async (type, pid=null, meta={}) => {
    if (!session) return;
    await supabase.from("rd_events").insert([{ session_id: session.id, event_type: type, product_id: pid, metadata: meta }]);
  }, [session]);

  const saveConvo = useCallback(async (role, message) => {
    if (!session) return;
    await supabase.from("rd_conversations").insert([{ session_id: session.id, role, message }]);
  }, [session]);

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || doveTyping || loading) return;
    setInputText("");

    // Add user message to UI
    setMessages(prev => [...prev, { role: "user", text }]);
    saveConvo("user", text);
    setDoveTyping(true);

    const newHistory = [...doveHistory, { role: "user", content: text }];

    try {
      const res = await fetch(CATALOGUE_URL + "/dove-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, conversation_history: doveHistory }),
      });
      const data = await res.json();

      setDoveTyping(false);
      setMessages(prev => [...prev, { role: "dove", text: data.response }]);
      setDoveHistory([...newHistory, { role: "assistant", content: data.response }]);
      saveConvo("dove", data.response);

      if (data.ready && data.filters) {
        setLoading(true);
        await runSearch(data.filters);
        setCurationDone(true);
        setLoading(false);
      }
    } catch (e) {
      console.error(e);
      setDoveTyping(false);
      setMessages(prev => [...prev, { role: "dove", text: "I'm sorry, I had a moment of difficulty. Could you tell me a bit more?" }]);
    }
  };

  const runSearch = async (filters) => {
    const allProducts = productsRef.current;
    const budget = filters.budget || Infinity;
    const qty = filters.qty || 1;

    try {
      // Also call /interpret-query with the rich query for tag matching
      const res = await fetch(CATALOGUE_URL + "/interpret-query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: filters.query || "" }),
      });
      const apiData = await res.json();

      const newChips = [];
      if (filters.occasion && filters.occasion !== "other") newChips.push(filters.occasion.toUpperCase().replace(/-/g," "));
      if (filters.audience && filters.audience !== "other") newChips.push(filters.audience.toUpperCase().replace(/-/g," "));
      if (budget < Infinity) newChips.push(`₹${budget.toLocaleString("en-IN")} / UNIT`);
      if (filters.exclude_edible) newChips.push({ label:"NON-EDIBLE", muted:true });
      if (filters.exclude_fragile) newChips.push({ label:"NON-FRAGILE", muted:true });
      setChips(newChips);

      const summary = apiData.summary || filters.query || "Here are your curated gifts.";
      setAiMessage(summary);
      saveConvo("assistant", summary);

      // Score by tag match
      const includeTags = [...(filters.include_tags||[]), ...(apiData.include_tags||[])];
      const excludeTags = [...(filters.exclude_tags||[]), ...(apiData.exclude_tags||[])];

      const scored = allProducts
        .filter(p => {
          const price = priceAtQty(p.pricing_tiers, qty);
          if (budget < Infinity && price > budget * 1.15) return false;
          if (filters.exclude_edible && p.edible) return false;
          if (filters.exclude_fragile && p.fragile) return false;
          // Check exclude tags
          const pTags = (p.tags || []).map(t => (typeof t==="string"?t:t.tag||"").toLowerCase());
          for (const tag of excludeTags) {
            if (pTags.includes(tag.toLowerCase())) return false;
          }
          return true;
        })
        .map(p => {
          const pTags = (p.tags || []).map(t => (typeof t==="string"?t:t.tag||"").toLowerCase());
          const score = includeTags.reduce((s, tag) => s + (pTags.includes(tag.toLowerCase()) ? 1 : 0), 0);
          return { ...p, _price: priceAtQty(p.pricing_tiers, qty), _score: score };
        })
        .sort((a,b) => b._score - a._score || (b.popularity||0)-(a.popularity||0));

      setResults(scored.slice(0, 12));
      setSort("rec");
    } catch(e) {
      console.error(e);
      const fallback = allProducts
        .filter(p => budget === Infinity || priceAtQty(p.pricing_tiers, qty) <= budget * 1.15)
        .map(p => ({ ...p, _price: priceAtQty(p.pricing_tiers, qty) }))
        .sort((a,b) => (b.popularity||0)-(a.popularity||0));
      setResults(fallback.slice(0, 12));
      setAiMessage("Here are some of our finest curated gifts.");
    }
  };

  const handleAskDove = async () => {
    const text = askDoveText.trim();
    if (!text || askDoveLoading) return;
    setAskDoveText("");
    setAskDoveOpen(false);
    setAskDoveLoading(true);

    setMessages(prev => [...prev, { role: "user", text }]);
    setDoveTyping(true);
    setView("chat");

    try {
      const res = await fetch(CATALOGUE_URL + "/dove-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, conversation_history: doveHistory }),
      });
      const data = await res.json();

      setDoveTyping(false);
      setMessages(prev => [...prev, { role: "dove", text: data.response }]);
      setDoveHistory(prev => [...prev, { role: "user", content: text }, { role: "assistant", content: data.response }]);
      saveConvo("dove", data.response);

      if (data.ready && data.filters) {
        setLoading(true);
        await runSearch(data.filters);
        setLoading(false);
        setView("results");
      } else {
        // Keep chat open for more info
        setTimeout(() => setView("chat"), 100);
      }
    } catch(e) {
      setDoveTyping(false);
    }
    setAskDoveLoading(false);
  };

  const toggleHeart = async (productId) => {
    if (!session) return;
    const isHearted = hearted.has(productId);
    const newHearted = new Set(hearted);
    if (isHearted) {
      newHearted.delete(productId);
      await supabase.from("rd_shortlists").delete().eq("session_id", session.id).eq("product_id", productId);
      logEvent("shortlist_remove", productId);
    } else {
      newHearted.add(productId);
      await supabase.from("rd_shortlists").insert([{ session_id: session.id, product_id: productId }]);
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
    if (sort==="asc") return a._price - b._price;
    if (sort==="desc") return b._price - a._price;
    return (b._score||0) - (a._score||0) || (b.popularity||0)-(a.popularity||0);
  });

  const shortlistedItems = results.filter(p => hearted.has(p.id));
  const totalEstimate = shortlistedItems.reduce((s,p) => s+p._price, 0);

  const S = styles;

  if (notFound) return (
    <div style={S.center}>
      <div style={S.logoWrap}><span style={S.logoR}>Rock </span><span style={S.logoD}>Dove</span></div>
      <p style={{ fontSize:16, color:"#555", marginTop:28 }}>This link is invalid or has expired.</p>
      <p style={{ fontSize:13, color:"#aaa", marginTop:8 }}>Please contact your Rock Dove curator for a new link.</p>
    </div>
  );

  if (!session) return (
    <div style={S.center}>
      <div style={S.logoWrap}><span style={S.logoR}>Rock </span><span style={S.logoD}>Dove</span></div>
      <p style={{ fontSize:12, color:"#bbb", letterSpacing:"2px", textTransform:"uppercase", marginTop:24 }}>Loading your experience…</p>
    </div>
  );

  if (view === "submitted") return (
    <div style={S.center}>
      <div style={{ width:56, height:56, borderRadius:"50%", background:"#2C5F3A", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:24, marginBottom:24 }}>✓</div>
      <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:32, fontWeight:500, color:"#1a1a1a", marginBottom:12 }}>Shortlist sent</div>
      <p style={{ fontSize:15, color:"#888", maxWidth:400, lineHeight:1.8, marginBottom:36, textAlign:"center" }}>
        Thank you, {session.client_name.split(" ")[0]}. We'll follow up within 24 hours with availability and final pricing.
      </p>
      <div style={{ width:"100%", maxWidth:400 }}>
        {shortlistedItems.map(p => (
          <div key={p.id} style={{ display:"flex", alignItems:"center", gap:16, padding:"14px 0", borderBottom:"1px solid #f0f0f0" }}>
            <div style={{ width:48, height:58, background:p._bg, flexShrink:0, overflow:"hidden" }}>
              {p.image_url && <img src={p.image_url} alt={p.name} style={{ width:"100%", height:"100%", objectFit:"cover" }} />}
            </div>
            <div>
              <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:17, fontWeight:500, color:"#1a1a1a", marginBottom:4 }}>{p.name}</div>
              <div style={{ fontSize:13, color:"#aaa" }}>₹{p._price.toLocaleString("en-IN")}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div style={S.app}>

      {/* Header */}
      <div style={S.hdr}>
        <div>
          <div style={S.logoWrap}><span style={S.logoR}>Rock </span><span style={S.logoD}>Dove</span></div>
          <div style={S.logoSub}>by Ikka Dukka · Gift Intelligence</div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:16 }}>
          {view === "results" && (
            <button style={S.doveNavBtn} onClick={() => setView("chat")}>
              <span style={S.doveNavDot}></span>
              BACK TO DOVE
            </button>
          )}
          <div style={S.av}>{initials(session.client_name)}</div>
          <div>
            <div style={S.cname}>{session.client_name}</div>
            {session.client_company && <div style={S.cco}>{session.client_company}</div>}
          </div>
        </div>
      </div>

      {/* ── CHAT VIEW ── */}
      {view === "chat" && (
        <div style={S.chatOuter}>
          <div style={S.chatInner}>
            <div style={S.messages}>
              {messages.map((m, i) => (
                <div key={i} style={{ display:"flex", flexDirection:"column", alignItems: m.role==="dove" ? "flex-start" : "flex-end", marginBottom:28 }}>
                  {m.role === "dove" && (
                    <div style={S.doveLabel}>
                      <span style={S.doveDot}></span>
                      DOVE
                    </div>
                  )}
                  <div style={m.role === "dove" ? S.doveBubble : S.userBubble}>
                    {m.text.split("\n").map((line, j, arr) => (
                      <span key={j}>{line}{j < arr.length-1 && <br/>}</span>
                    ))}
                  </div>
                </div>
              ))}

              {doveTyping && (
                <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-start", marginBottom:28 }}>
                  <div style={S.doveLabel}><span style={S.doveDot}></span>DOVE</div>
                  <div style={{ ...S.doveBubble, display:"flex", alignItems:"center", gap:6, padding:"18px 22px" }}>
                    <span className="td"></span>
                    <span className="td" style={{ animationDelay:"0.2s" }}></span>
                    <span className="td" style={{ animationDelay:"0.4s" }}></span>
                  </div>
                </div>
              )}

              {loading && (
                <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-start", marginBottom:28 }}>
                  <div style={S.doveLabel}><span style={S.doveDot}></span>DOVE</div>
                  <div style={S.doveBubble}>Searching through our curated catalogue…</div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div style={S.chatInputArea}>
              {curationDone && !loading && results.length > 0 && (
                <button style={S.viewGiftsBtn} onClick={() => setView("results")}>
                  VIEW {results.length} CURATED GIFTS →
                </button>
              )}
              <div style={S.chatInputBox}>
                <input
                  style={S.chatInput}
                  value={inputText}
                  onChange={e => setInputText(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleSend()}
                  placeholder="Tell Dove…"
                  disabled={doveTyping || loading}
                  autoFocus
                />
                <button
                  style={{ ...S.chatSendBtn, ...(!inputText.trim()||doveTyping||loading ? { opacity:0.3, cursor:"not-allowed" } : {}) }}
                  onClick={handleSend}
                  disabled={!inputText.trim()||doveTyping||loading}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                  </svg>
                </button>
              </div>
              <p style={{ fontSize:10, color:"#ccc", letterSpacing:"1.5px", textTransform:"uppercase", textAlign:"center", marginTop:10, margin:"10px 0 0" }}>
                Your conversation is private and shared only with Rock Dove
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── RESULTS VIEW ── */}
      {view === "results" && (
        <>
          {chips.length > 0 && (
            <div style={S.chipsRow}>
              {chips.map((c,i) => (
                <div key={i} style={typeof c==="string" ? S.chip : S.chipMuted}>
                  {typeof c==="string" ? c : c.label}
                </div>
              ))}
            </div>
          )}

          {aiMessage && (
            <div style={S.aiBar}>
              <span style={S.aiDot}></span>
              <span style={S.aiLbl}>Dove</span>
              <span style={S.aiTxt}>{aiMessage}</span>
            </div>
          )}

          <div style={S.body}>
            <div style={S.gridWrap}>
              <div style={S.meta}>
                <div style={S.cnt}>{results.length} GIFTS CURATED</div>
                <div style={{ display:"flex" }}>
                  {[["rec","RECOMMENDED"],["asc","PRICE ↑"],["desc","PRICE ↓"]].map(([v,l]) => (
                    <button key={v} style={{ ...S.sortBtn, ...(sort===v ? S.sortOn : {}) }} onClick={() => setSort(v)}>{l}</button>
                  ))}
                </div>
              </div>

              {results.length === 0 ? (
                <div style={{ textAlign:"center", padding:"80px 0" }}>
                  <p style={{ fontSize:13, color:"#aaa", letterSpacing:"2px", textTransform:"uppercase", marginBottom:20 }}>No gifts match this search.</p>
                  <button style={S.doveNavBtn} onClick={() => setView("chat")}>
                    <span style={S.doveNavDot}></span>REFINE WITH DOVE
                  </button>
                </div>
              ) : (
                <div style={S.grid}>
                  {sortedResults.map(p => (
                    <div key={p.id} style={S.card}>
                      <div style={{ ...S.cardImg, background:p._bg }}
                        onClick={() => { setSelectedProduct(p); logEvent("product_view", p.id); }}>
                        {p.image_url ? (
                          <img src={p.image_url} alt={p.name} style={{ position:"absolute", inset:0, width:"100%", height:"100%", objectFit:"cover" }} />
                        ) : (
                          <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                            <span style={{ fontSize:11, letterSpacing:"2px", color:"#bbb", textTransform:"uppercase" }}>{p.category}</span>
                          </div>
                        )}
                        <button
                          style={{ ...S.hbtn, ...(hearted.has(p.id) ? S.hbtnOn : {}) }}
                          onClick={e => { e.stopPropagation(); toggleHeart(p.id); }}
                        >{hearted.has(p.id) ? "♥" : "♡"}</button>
                      </div>
                      <div onClick={() => { setSelectedProduct(p); logEvent("product_view", p.id); }}>
                        <div style={{ marginTop:12 }}>
                          <span style={{ ...S.tier, ...(p.tier==="Gold"?S.tierGold:p.tier==="Platinum"?S.tierPlat:S.tierSilv) }}>
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

            {/* Shortlist panel */}
            <div style={S.sl}>
              <div style={S.slHdr}>
                <div style={S.slTitle}>SHORTLIST</div>
                <div style={S.slCount}>{hearted.size===0 ? "EMPTY" : `${hearted.size} GIFT${hearted.size!==1?"S":""}`}</div>
              </div>
              <div style={{ flex:1, overflowY:"auto" }}>
                {hearted.size===0 ? (
                  <div style={S.slEmpty}>HEART A GIFT<br/>TO SAVE IT HERE.</div>
                ) : shortlistedItems.map(p => (
                  <div key={p.id} style={S.slRow}>
                    <div style={{ width:46, height:54, background:p._bg, flexShrink:0, overflow:"hidden", cursor:"pointer" }}
                      onClick={() => setSelectedProduct(p)}>
                      {p.image_url && <img src={p.image_url} alt={p.name} style={{ width:"100%", height:"100%", objectFit:"cover" }} />}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={S.slName}>{p.name}</div>
                      <div style={S.slPrice}>₹{p._price.toLocaleString("en-IN")}</div>
                    </div>
                    <button style={S.slRm} onClick={() => toggleHeart(p.id)}>×</button>
                  </div>
                ))}
              </div>
              <div style={S.slFooter}>
                <div style={S.slTotalRow}>
                  <div style={S.slTotalLbl}>TOTAL</div>
                  <div style={S.slTotalVal}>{hearted.size===0 ? "—" : `₹${totalEstimate.toLocaleString("en-IN")}`}</div>
                </div>
                <button
                  style={{ ...S.btnGreen, ...(hearted.size===0 ? { opacity:0.4, cursor:"not-allowed", boxShadow:"none" } : {}) }}
                  onClick={submitShortlist}
                  disabled={hearted.size===0 || submitting}
                >
                  {submitting ? "SENDING…" : "SEND TO ROCK DOVE →"}
                </button>
                <div style={S.slNote}>WE FOLLOW UP WITHIN 24 HRS</div>
              </div>
            </div>
          </div>

          {/* Floating Ask Dove */}
          <div style={S.floatingWrap}>
            {askDoveOpen ? (
              <div style={S.askDovePanel}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={S.doveNavDot}></span>
                    <span style={{ fontSize:11, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#2C5F3A" }}>Ask Dove</span>
                  </div>
                  <button style={{ background:"none", border:"none", fontSize:20, color:"#aaa", cursor:"pointer" }} onClick={() => setAskDoveOpen(false)}>×</button>
                </div>
                {aiMessage && (
                  <p style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:14, fontStyle:"italic", color:"#999", marginBottom:12, lineHeight:1.6 }}>
                    {aiMessage}
                  </p>
                )}
                <div style={{ display:"flex", gap:8 }}>
                  <input
                    style={S.askDoveInput}
                    value={askDoveText}
                    onChange={e => setAskDoveText(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleAskDove()}
                    placeholder="e.g. Nothing edible, prefer something for the home…"
                    autoFocus
                  />
                  <button
                    style={{ ...S.chatSendBtn, width:46, height:46, boxShadow:"none", ...(!askDoveText.trim() ? { opacity:0.3, cursor:"not-allowed" } : {}) }}
                    onClick={handleAskDove}
                    disabled={!askDoveText.trim() || askDoveLoading}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                    </svg>
                  </button>
                </div>
              </div>
            ) : (
              <button style={S.askDoveBtn} onClick={() => setAskDoveOpen(true)}>
                <span style={S.doveNavDot}></span>
                ASK DOVE TO REFINE
              </button>
            )}
          </div>
        </>
      )}

      {/* ── PRODUCT DETAIL MODAL ── */}
      {selectedProduct && (
        <div style={S.modalOverlay} onClick={() => setSelectedProduct(null)}>
          <div style={S.modalBox} onClick={e => e.stopPropagation()}>
            <button style={S.modalClose} onClick={() => setSelectedProduct(null)}>×</button>
            <div style={S.modalInner}>
              {/* Image — full height left panel */}
              <div style={S.modalImgWrap}>
                {selectedProduct.image_url ? (
                  <img
                    src={selectedProduct.image_url}
                    alt={selectedProduct.name}
                    style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }}
                  />
                ) : (
                  <div style={{ width:"100%", height:"100%", background:selectedProduct._bg, display:"flex", alignItems:"center", justifyContent:"center" }}>
                    <span style={{ fontSize:12, letterSpacing:"2px", color:"#bbb", textTransform:"uppercase" }}>{selectedProduct.category}</span>
                  </div>
                )}
              </div>

              {/* Content */}
              <div style={S.modalContent}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
                  <span style={{ ...S.tier, ...(selectedProduct.tier==="Gold"?S.tierGold:selectedProduct.tier==="Platinum"?S.tierPlat:S.tierSilv) }}>
                    {TIER_LABEL[selectedProduct.tier]||selectedProduct.tier}
                  </span>
                  <button
                    style={{ background:"none", border:"none", fontSize:26, color: hearted.has(selectedProduct.id) ? "#9B3A2A" : "#ddd", cursor:"pointer", lineHeight:1 }}
                    onClick={() => toggleHeart(selectedProduct.id)}
                  >{hearted.has(selectedProduct.id) ? "♥" : "♡"}</button>
                </div>

                <h2 style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:26, fontWeight:500, color:"#1a1a1a", lineHeight:1.25, marginBottom:6, margin:"0 0 6px" }}>
                  {selectedProduct.name}
                </h2>
                <p style={{ fontSize:11, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", marginBottom:20 }}>
                  {selectedProduct.category}
                </p>
                <p style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:30, fontWeight:500, color:"#1a1a1a", marginBottom:24 }}>
                  ₹{selectedProduct._price.toLocaleString("en-IN")}
                </p>

                {selectedProduct.description && (
                  <p style={{ fontSize:14, color:"#555", lineHeight:1.8, marginBottom:24 }}>{selectedProduct.description}</p>
                )}

                {selectedProduct.whats_in_box && (
                  <div style={{ marginBottom:22, paddingBottom:20, borderBottom:"1px solid #f0f0f0" }}>
                    <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", marginBottom:10 }}>What's in the box</p>
                    <p style={{ fontSize:14, color:"#555", lineHeight:1.8 }}>
                      {formatBoxContents(selectedProduct.whats_in_box)}
                    </p>
                  </div>
                )}

                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"14px 24px", marginBottom:28 }}>
                  {selectedProduct.moq && (
                    <div>
                      <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", marginBottom:5 }}>Min. Order</p>
                      <p style={{ fontSize:14, color:"#333" }}>{selectedProduct.moq} units</p>
                    </div>
                  )}
                  {selectedProduct.lead_time && (
                    <div>
                      <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", marginBottom:5 }}>Lead Time</p>
                      <p style={{ fontSize:14, color:"#333" }}>{selectedProduct.lead_time}</p>
                    </div>
                  )}
                  {selectedProduct.box_dimensions && (
                    <div>
                      <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", marginBottom:5 }}>Dimensions</p>
                      <p style={{ fontSize:14, color:"#333" }}>{selectedProduct.box_dimensions}</p>
                    </div>
                  )}
                  {selectedProduct.weight_grams && (
                    <div>
                      <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", marginBottom:5 }}>Weight</p>
                      <p style={{ fontSize:14, color:"#333" }}>{selectedProduct.weight_grams}g</p>
                    </div>
                  )}
                </div>

                <button
                  style={{ ...S.btnGreen, ...(hearted.has(selectedProduct.id) ? { background:"#9B3A2A", boxShadow:"0 5px 0 #e8b4a8" } : {}) }}
                  onClick={() => toggleHeart(selectedProduct.id)}
                >
                  {hearted.has(selectedProduct.id) ? "♥  SAVED TO SHORTLIST" : "♡  SAVE TO SHORTLIST"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  app: { background:"#fff", minHeight:"100vh", display:"flex", flexDirection:"column", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", letterSpacing:"0.02em" },
  center: { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:"100vh", textAlign:"center", padding:32 },

  logoWrap: { display:"flex", alignItems:"baseline", gap:5 },
  logoR: { fontSize:15, fontWeight:600, letterSpacing:5, textTransform:"uppercase", color:"#1a1a1a" },
  logoD: { fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:21, fontStyle:"italic", color:"#2C5F3A", fontWeight:500 },
  logoSub: { fontSize:10, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", marginTop:3, fontWeight:300 },

  hdr: { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 40px", height:64, background:"#fff", borderBottom:"1px solid #e8e2d8", flexShrink:0, zIndex:10 },
  av: { width:36, height:36, borderRadius:"50%", background:"#7A90B0", fontSize:12, fontWeight:600, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center" },
  cname: { fontSize:12, fontWeight:600, letterSpacing:"1px", textTransform:"uppercase", color:"#1a1a1a" },
  cco: { fontSize:11, fontWeight:300, color:"#aaa" },
  doveNavBtn: { display:"flex", alignItems:"center", gap:8, background:"#2C5F3A", border:"none", padding:"10px 18px", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", fontSize:11, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:"#fff", cursor:"pointer", boxShadow:"0 4px 0 #a8d4b4" },
  doveNavDot: { display:"inline-block", width:7, height:7, borderRadius:"50%", background:"#fff", flexShrink:0 },

  // Chat
  chatOuter: { flex:1, display:"flex", flexDirection:"column", overflow:"hidden" },
  chatInner: { flex:1, display:"flex", flexDirection:"column", maxWidth:700, width:"100%", margin:"0 auto", padding:"0 32px", overflow:"hidden" },
  messages: { flex:1, overflowY:"auto", padding:"48px 0 16px" },

  doveLabel: { display:"flex", alignItems:"center", gap:7, marginBottom:10, fontSize:10, fontWeight:600, letterSpacing:"2.5px", color:"#2C5F3A" },
  doveDot: { display:"inline-block", width:7, height:7, borderRadius:"50%", background:"#2C5F3A", flexShrink:0 },

  doveBubble: {
    display:"block",
    background:"#FAFAF8",
    borderLeft:"3px solid #2C5F3A",
    padding:"20px 24px",
    fontSize:16,
    color:"#2a2a2a",
    lineHeight:1.9,
    maxWidth:"84%",
    fontWeight:400,
    letterSpacing:"0.01em",
  },

  userBubble: {
    display:"block",
    background:"#1a1a1a",
    padding:"13px 18px",
    fontSize:14,
    color:"#fff",
    lineHeight:1.65,
    maxWidth:"70%",
    fontWeight:300,
    letterSpacing:"0.3px",
  },

  chatInputArea: { borderTop:"1px solid #eeebe6", padding:"18px 0 24px", flexShrink:0 },
  viewGiftsBtn: { width:"100%", background:"#2C5F3A", color:"#fff", border:"none", padding:15, fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", fontSize:12, fontWeight:600, letterSpacing:"2.5px", textTransform:"uppercase", cursor:"pointer", boxShadow:"0 5px 0 #a8d4b4", marginBottom:14, display:"block" },

  chatInputBox: { display:"flex", alignItems:"center", border:"1.5px solid #1a1a1a", background:"#fff" },
  chatInput: { flex:1, fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", fontSize:15, fontWeight:300, color:"#1a1a1a", border:"none", outline:"none", background:"transparent", padding:"13px 18px", letterSpacing:"0.3px" },
  chatSendBtn: { width:50, height:50, background:"#2C5F3A", border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", flexShrink:0 },

  // Results
  chipsRow: { padding:"10px 40px", display:"flex", gap:6, flexWrap:"wrap", borderBottom:"1px solid #eeebe6", flexShrink:0 },
  chip: { fontSize:10, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:"#2C5F3A", padding:"5px 12px", border:"1px solid #a8c8b4", background:"#eaf2ec" },
  chipMuted: { fontSize:10, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:"#bbb", padding:"5px 12px", border:"1px solid #eee", background:"#fafafa" },

  aiBar: { padding:"13px 40px", background:"#f9f7f4", borderBottom:"1px solid #eeebe6", display:"flex", gap:12, alignItems:"center", flexShrink:0 },
  aiDot: { display:"inline-block", width:6, height:6, borderRadius:"50%", background:"#2C5F3A", flexShrink:0 },
  aiLbl: { fontSize:9, fontWeight:600, letterSpacing:"2.5px", textTransform:"uppercase", color:"#2C5F3A", flexShrink:0 },
  aiTxt: { fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:16, fontStyle:"italic", color:"#555" },

  body: { display:"flex", flex:1, overflow:"hidden" },
  gridWrap: { flex:1, padding:"28px 40px 120px", overflowY:"auto" },
  meta: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 },
  cnt: { fontSize:11, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#aaa" },
  sortBtn: { fontSize:11, fontWeight:600, letterSpacing:"1px", textTransform:"uppercase", color:"#bbb", background:"none", border:"none", cursor:"pointer", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", padding:"5px 12px" },
  sortOn: { color:"#1a1a1a", borderBottom:"1.5px solid #1a1a1a" },

  grid: { display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(190px, 1fr))", gap:"28px 16px" },
  card: { cursor:"pointer" },
  cardImg: { width:"100%", paddingBottom:"116%", position:"relative", overflow:"hidden" },
  hbtn: { position:"absolute", top:10, right:10, width:30, height:30, background:"rgba(255,255,255,0.92)", border:"none", fontSize:14, color:"#ccc", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" },
  hbtnOn: { color:"#9B3A2A" },
  tier: { fontSize:9, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", display:"inline-block", padding:"3px 8px" },
  tierGold: { color:"#7a5c20", background:"#fdf5e6", border:"1px solid #e8d5a0" },
  tierPlat: { color:"#2a4a7a", background:"#eef3fa", border:"1px solid #b8cce8" },
  tierSilv: { color:"#666", background:"#f5f5f5", border:"1px solid #e0e0e0" },
  cardName: { fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:17, fontWeight:500, color:"#1a1a1a", marginTop:8, lineHeight:1.3 },
  cardCat: { fontSize:11, fontWeight:300, letterSpacing:"1.5px", textTransform:"uppercase", color:"#bbb", marginTop:4 },
  cardPrice: { fontSize:14, fontWeight:600, color:"#1a1a1a", marginTop:10 },

  // Shortlist
  sl: { width:256, background:"#fff", borderLeft:"1px solid #e8e2d8", display:"flex", flexDirection:"column", flexShrink:0 },
  slHdr: { padding:"22px 20px 16px", borderBottom:"1px solid #eeebe6", display:"flex", alignItems:"baseline", justifyContent:"space-between", flexShrink:0 },
  slTitle: { fontSize:11, fontWeight:600, letterSpacing:"2.5px", textTransform:"uppercase", color:"#1a1a1a" },
  slCount: { fontSize:11, fontWeight:400, letterSpacing:"1px", textTransform:"uppercase", color:"#bbb" },
  slEmpty: { padding:"32px 20px", fontSize:11, letterSpacing:"2px", textTransform:"uppercase", color:"#ccc", lineHeight:1.8, textAlign:"center" },
  slRow: { display:"flex", alignItems:"center", gap:12, padding:"12px 20px", borderBottom:"1px solid #f5f0e8" },
  slName: { fontSize:12, fontWeight:600, color:"#1a1a1a", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", marginBottom:3 },
  slPrice: { fontSize:12, fontWeight:300, color:"#888" },
  slRm: { background:"none", border:"none", color:"#ccc", cursor:"pointer", fontSize:20, padding:0, lineHeight:1, flexShrink:0 },
  slFooter: { padding:20, borderTop:"1px solid #eeebe6", flexShrink:0 },
  slTotalRow: { display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:16, paddingBottom:14, borderBottom:"1px solid #f0ece4" },
  slTotalLbl: { fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#aaa" },
  slTotalVal: { fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:24, fontWeight:500, color:"#1a1a1a" },
  slNote: { fontSize:10, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:"#ccc", textAlign:"center", marginTop:12 },
  btnGreen: { width:"100%", background:"#2C5F3A", color:"#fff", border:"none", padding:14, fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", fontSize:11, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", cursor:"pointer", boxShadow:"0 5px 0 #a8d4b4", display:"block" },

  // Floating Ask Dove
  floatingWrap: { position:"fixed", bottom:28, left:"50%", transform:"translateX(-50%)", zIndex:100, maxWidth:500, width:"calc(100% - 320px)" },
  askDoveBtn: { display:"flex", alignItems:"center", gap:10, background:"#2C5F3A", border:"none", padding:"13px 28px", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", fontSize:12, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#fff", cursor:"pointer", boxShadow:"0 6px 24px rgba(44,95,58,0.35)", margin:"0 auto" },
  askDovePanel: { background:"#fff", border:"2px solid #2C5F3A", padding:"20px 24px", boxShadow:"0 8px 32px rgba(0,0,0,0.15)" },
  askDoveInput: { flex:1, fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif", fontSize:14, fontWeight:300, color:"#1a1a1a", border:"1px solid #ddd", padding:"11px 14px", outline:"none", background:"transparent" },

  // Modal
  modalOverlay: { position:"fixed", inset:0, background:"rgba(10,10,10,0.7)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:300, padding:32 },
  modalBox: { background:"#fff", width:"100%", maxWidth:860, maxHeight:"90vh", overflowY:"auto", position:"relative" },
  modalClose: { position:"absolute", top:14, right:18, background:"none", border:"none", fontSize:28, color:"#999", cursor:"pointer", lineHeight:1, zIndex:10 },
  modalInner: { display:"flex" },
  modalImgWrap: { width:380, minWidth:380, flexShrink:0, minHeight:520, background:"#f5f0eb", overflow:"hidden" },
  modalContent: { flex:1, padding:"40px 36px", overflowY:"auto" },
};
