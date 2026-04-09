import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase.js";

const CATALOGUE_URL = import.meta.env.VITE_CATALOGUE_SERVICE_URL ||
  "https://ikka-catalogue-service-production.up.railway.app";

const BG_COLORS = ["#F5EFE8","#EDF2EE","#EEF0F7","#F7EEF0","#F0EDE8","#EEF5F2","#F5F0E8","#EEF1F7","#F2EEF5"];
const TIER_LABEL = { Gold:"Gold", Silver:"Silver", Platinum:"Platinum" };
const DOVE_BLUE = "#6B8CAE";

const INTAKE_SYSTEM = `You are Dove, gifting concierge for Rock Dove by Ikka Dukka — a premium Indian gifting platform.

Your job: Extract a gifting brief from what the client says. Be warm, brief, and specific. Replies max 2 sentences.

FIRST: Check if this is a gifting query. If it's clearly not (weather, news, general questions), reply with a gentle redirect. Do not generate gift results for non-gifting queries.

If it IS a gifting query, extract:
- recipient: who they're gifting
- quantity: how many gifts
- occasion: the occasion or reason
- deadline: when needed by (if mentioned)
- budget: per-unit budget in INR (if mentioned)
- restrictions: anything to avoid

If the query is a valid gifting brief with enough info (at minimum: who + occasion), set ready: true.
If key info is missing, set ready: false and ask ONE specific follow-up question.

Always respond with valid JSON only — no markdown, no preamble:
{
  "response": "Your warm reply here (max 2 sentences)",
  "ready": true or false,
  "is_gifting_query": true or false,
  "filters": {
    "occasion": "diwali|birthday|anniversary|corporate|thank-you|welcome|other",
    "audience": "senior-management|employees-mass|client|colleague|family|other",
    "budget": 3000,
    "qty": 50,
    "deadline": "October 20" or null,
    "exclude_edible": false,
    "exclude_fragile": false,
    "include_tags": [],
    "exclude_tags": [],
    "query": "rich natural language query capturing all context for product ranking"
  }
}`;

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

function BigLogo() {
  return (
    <div style={{ display:"flex", alignItems:"baseline", justifyContent:"center", gap:6 }}>
      <span style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:58, fontWeight:700, letterSpacing:14, textTransform:"uppercase", color:"#111", lineHeight:1 }}>Rock</span>
      <span style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:66, fontStyle:"italic", color:DOVE_BLUE, fontWeight:400, letterSpacing:2, lineHeight:1 }}>Dove</span>
    </div>
  );
}

function SmallLogo({ onClick }) {
  return (
    <button onClick={onClick} style={{ background:"none", border:"none", cursor:"pointer", display:"flex", alignItems:"baseline", gap:2, padding:0 }}>
      <span style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:14, fontWeight:700, letterSpacing:4, textTransform:"uppercase", color:"#111" }}>Rock</span>
      <span style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:16, fontStyle:"italic", color:DOVE_BLUE, fontWeight:400, marginLeft:2 }}>Dove</span>
    </button>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const productsRef = useRef([]);

  const [intakeInput, setIntakeInput] = useState("");
  const [intakeMessages, setIntakeMessages] = useState([]);
  const [intakeHistory, setIntakeHistory] = useState([]);
  const [intakeLoading, setIntakeLoading] = useState(false);
  const [pastQueries, setPastQueries] = useState([]);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [aiSummary, setAiSummary] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [chips, setChips] = useState([]);
  const [lastFilters, setLastFilters] = useState(null);
  const [sort, setSort] = useState("rec");
  const [view, setView] = useState("intake");

  const [hearted, setHearted] = useState(new Set());
  const heartedRef = useRef({});
  const [shortlistOpen, setShortlistOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);

  const intakeEndRef = useRef(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token") ||
      window.location.pathname.split("/").pop();
    if (token && token !== "/") loadSession(token);
    else setNotFound(true);
  }, []);

  useEffect(() => { intakeEndRef.current?.scrollIntoView({ behavior:"smooth" }); }, [intakeMessages, intakeLoading]);

  const loadSession = async (token) => {
    try {
      const { data, error } = await supabase.from("rd_sessions").select("*").eq("token", token).single();
      if (error || !data) { setNotFound(true); return; }
      setSession(data);
      supabase.from("rd_sessions").update({ last_active: new Date().toISOString() }).eq("id", data.id);
      await Promise.all([loadProducts(), loadShortlist(data.id), loadPastQueries(data.id)]);
      const opening = `Hello ${data.client_name.split(" ")[0]}. To find the right gifts, tell me: who are you gifting, what's the occasion, how many, and when do you need them by?`;
      setIntakeMessages([{ role:"dove", text: opening }]);
      setIntakeHistory([{ role:"assistant", content: opening }]);
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
          ...p, _bg: BG_COLORS[i%BG_COLORS.length], _price: priceAtQty(p.pricing_tiers, 1),
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

  const loadPastQueries = async (sessionId) => {
    try {
      const { data } = await supabase.from("rd_conversations")
        .select("message").eq("session_id", sessionId).eq("role", "user")
        .order("created_at", { ascending: false }).limit(10);
      if (data?.length > 0) {
        // Only show substantive gifting queries — min 5 words and 30 chars
        setPastQueries(
          data.map(d => d.message)
            .filter(m => !m.startsWith("Submitted") && m.length > 30 && m.trim().split(" ").length >= 5)
            .slice(0, 4)
        );
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

  const handleIntakeSend = async () => {
    const text = intakeInput.trim();
    if (!text || intakeLoading) return;
    setIntakeInput("");
    const newMessages = [...intakeMessages, { role:"user", text }];
    setIntakeMessages(newMessages);
    setIntakeLoading(true);
    // Only save substantive messages
    if (text.length > 20) saveConvo("user", text);

    try {
      const res = await fetch(CATALOGUE_URL + "/dove-chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, conversation_history: intakeHistory, system_override: INTAKE_SYSTEM }),
      });
      const data = await res.json();
      const doveReply = data.response || "Tell me more about what you're looking for.";
      setIntakeMessages([...newMessages, { role:"dove", text: doveReply }]);
      const newHistory = [...intakeHistory, { role:"user", content:text }, { role:"assistant", content:doveReply }];
      setIntakeHistory(newHistory);
      saveConvo("dove", doveReply);

      if (!data.is_gifting_query) {
        setIntakeLoading(false);
        return;
      }

      if (data.ready && data.filters) {
        const filters = data.filters;
        const briefQuery = filters.query || text;
        setLastFilters(filters);
        setQuery(briefQuery);
        if (text.length > 30) setPastQueries(prev => [text, ...prev.filter(p=>p!==text)].slice(0,4));

        // Switch to results immediately, then load in background
        setIntakeLoading(false);
        setView("results");
        setSearching(true);
        try { await runCuration(filters, briefQuery); } catch(e) { console.error(e); }
        setSearching(false);
      } else {
        setIntakeLoading(false);
      }
    } catch(e) {
      console.error(e);
      setIntakeMessages(prev => [...prev, { role:"dove", text:"I had a moment of difficulty. Could you tell me more about who you're gifting?" }]);
      setIntakeLoading(false);
    }
  };

  const handleRefine = async (newQuery) => {
    const q = (newQuery || query).trim();
    if (!q || searching) return;
    setQuery(q);
    setSearching(true);
    setFollowUp("");
    if (q.length > 20) saveConvo("user", q);

    try {
      const res = await fetch(CATALOGUE_URL + "/dove-chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q, conversation_history: intakeHistory, system_override: INTAKE_SYSTEM }),
      });
      const data = await res.json();
      const newHistory = [...intakeHistory, { role:"user", content:q }, { role:"assistant", content:data.response }];
      setIntakeHistory(newHistory);
      saveConvo("dove", data.response);

      if (!data.is_gifting_query) {
        setFollowUp("I'm your gifting concierge — please tell me about a gift you'd like to find.");
        setSearching(false);
        return;
      }
      const filters = data.filters || lastFilters || {};
      if (data.filters) setLastFilters(data.filters);
      setFollowUp(!data.ready && data.response ? data.response : "");
      await runCuration(filters, filters.query || q);
    } catch(e) { console.error(e); }
    setSearching(false);
  };

  const runCuration = async (filters, briefQuery) => {
    const allProducts = productsRef.current;
    const qty = filters.qty || 1;
    const budget = filters.budget || null;

    const newChips = [];
    if (filters.occasion && filters.occasion !== "other") newChips.push(filters.occasion.toUpperCase().replace(/-/g," "));
    if (filters.audience && filters.audience !== "other") newChips.push(filters.audience.toUpperCase().replace(/-/g," "));
    if (budget) newChips.push(`₹${budget.toLocaleString("en-IN")} / UNIT`);
    if (filters.qty) newChips.push(`${filters.qty} GIFTS`);
    if (filters.deadline) newChips.push(`BY ${filters.deadline.toUpperCase()}`);
    if (filters.exclude_edible) newChips.push({ label:"NON-EDIBLE", muted:true });
    if (filters.exclude_fragile) newChips.push({ label:"NON-FRAGILE", muted:true });
    setChips(newChips);

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

    try {
      const rankRes = await fetch(CATALOGUE_URL + "/dove-rank", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brief: briefQuery,
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
    } catch(e) {
      console.error(e);
      const fallback = allProducts.filter(p => !budget || priceAtQty(p.pricing_tiers,qty)<=budget*1.2)
        .map(p=>({...p, _price:priceAtQty(p.pricing_tiers,qty)}));
      setResults(fallback);
      setAiSummary("Here are our curated gifts.");
    }
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
    logEvent("shortlist_submit", null, { product_ids:[...hearted], count:hearted.size });
    setTimeout(() => { setView("submitted"); setSubmitting(false); }, 800);
  };

  const sortedResults = [...results].sort((a,b) => {
    if (sort==="asc") return (a._price||0)-(b._price||0);
    if (sort==="desc") return (b._price||0)-(a._price||0);
    return 0;
  });

  const shortlistItems = [...hearted].map(id => heartedRef.current[id]||results.find(p=>p.id===id)).filter(Boolean);
  const totalEstimate = shortlistItems.reduce((s,p)=>s+(p._price||0),0);

  const S = styles;

  if (notFound) return (
    <div style={S.fullCenter}><BigLogo />
      <p style={{ fontFamily:"Georgia,serif", fontSize:16, fontWeight:300, color:"#888", marginTop:28 }}>This link is invalid or has expired.</p>
    </div>
  );

  if (!session) return (
    <div style={S.fullCenter}><BigLogo />
      <p style={{ fontSize:11, color:"#bbb", letterSpacing:"3px", textTransform:"uppercase", marginTop:24 }}>Loading…</p>
    </div>
  );

  if (view === "submitted") return (
    <div style={S.fullCenter}>
      <div style={{ width:52, height:52, borderRadius:"50%", background:"#2C5F3A", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, marginBottom:24 }}>✓</div>
      <p style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:28, fontWeight:400, color:"#111", margin:"0 0 10px" }}>Shortlist sent</p>
      <p style={{ fontFamily:"Georgia,serif", fontSize:16, fontWeight:300, color:"#888", maxWidth:380, lineHeight:1.8, margin:"0 0 32px", textAlign:"center" }}>
        Thank you, {session.client_name.split(" ")[0]}. We'll follow up within 24 hours.
      </p>
      {shortlistItems.map(p=>(
        <div key={p.id} style={{ display:"flex", alignItems:"center", gap:14, padding:"12px 0", borderBottom:"1px solid #f0f0f0", width:"100%", maxWidth:400 }}>
          <div style={{ width:44, height:54, background:p._bg||"#f5f0eb", flexShrink:0, overflow:"hidden" }}>
            {p.image_url && <img src={p.image_url} alt={p.name} style={{ width:"100%", height:"100%", objectFit:"cover" }} />}
          </div>
          <div>
            <p style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:15, fontWeight:400, color:"#111", margin:"0 0 3px" }}>{p.name}</p>
            <p style={{ fontSize:13, color:"#aaa", margin:0 }}>₹{(p._price||0).toLocaleString("en-IN")}</p>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div style={S.app}>

      {/* ── INTAKE ── */}
      {view === "intake" && (
        <div style={S.intakePage}>
          {/* Client badge — caps, larger */}
          <div style={S.clientBadge}>
            <div style={S.av}>{initials(session.client_name)}</div>
            <div>
              <p style={S.clientName}>{session.client_name.toUpperCase()}</p>
              {session.client_company && <p style={S.clientCompany}>{session.client_company}</p>}
            </div>
          </div>

          <div style={S.intakeCenter}>
            <div style={{ marginBottom:48 }}>
              <BigLogo />
              <p style={S.tagline}>by Ikka Dukka · Gift Intelligence</p>
            </div>

            <div style={S.intakeMessages}>
              {intakeMessages.map((m,i) => (
                <div key={i} style={{ marginBottom:28, display:"flex", flexDirection:"column", alignItems: m.role==="dove"?"flex-start":"flex-end" }}>
                  {m.role === "dove" && (
                    <div style={S.doveLabel}>
                      <span style={{ display:"inline-block", width:6, height:6, borderRadius:"50%", background:DOVE_BLUE }}></span>
                      <span style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:DOVE_BLUE }}>Dove</span>
                    </div>
                  )}
                  {/* Both Dove and user messages use Georgia serif — same font family, different style */}
                  <p style={m.role==="dove" ? S.doveMessage : S.userMessage}>
                    {m.text.split("\n").map((line,j,arr)=>(
                      <span key={j}>{line}{j<arr.length-1&&<br/>}</span>
                    ))}
                  </p>
                </div>
              ))}

              {intakeLoading && (
                <div style={{ marginBottom:28 }}>
                  <div style={S.doveLabel}>
                    <span style={{ display:"inline-block", width:6, height:6, borderRadius:"50%", background:DOVE_BLUE }}></span>
                    <span style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:DOVE_BLUE }}>Dove</span>
                  </div>
                  <div style={{ display:"flex", gap:5, alignItems:"center", marginTop:10 }}>
                    <span className="td"></span>
                    <span className="td" style={{ animationDelay:"0.2s" }}></span>
                    <span className="td" style={{ animationDelay:"0.4s" }}></span>
                  </div>
                </div>
              )}
              <div ref={intakeEndRef} />
            </div>

            <div style={S.intakeInputWrap}>
              <textarea
                style={S.intakeTextarea}
                value={intakeInput}
                onChange={e => setIntakeInput(e.target.value)}
                onKeyDown={e => { if (e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); handleIntakeSend(); }}}
                placeholder="e.g. 50 senior bankers, Diwali gifts, budget ₹3,000 each, need by October 20"
                disabled={intakeLoading}
                rows={2}
                autoFocus
              />
              <button
                style={{ ...S.intakeSendBtn, ...(!intakeInput.trim()||intakeLoading?{ opacity:0.35, cursor:"not-allowed" }:{}) }}
                onClick={handleIntakeSend}
                disabled={!intakeInput.trim()||intakeLoading}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
              </button>
            </div>

            {pastQueries.length > 0 && (
              <div style={S.pastSearches}>
                <p style={S.pastLabel}>Recent searches</p>
                {pastQueries.map((q,i) => (
                  <button key={i} style={S.pastItem} onClick={() => { setIntakeInput(q); setTimeout(handleIntakeSend, 50); }}>
                    ↺ {q}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── RESULTS ── */}
      {view === "results" && (
        <div style={S.resultsPage}>
          <div style={S.topBar}>
            <SmallLogo onClick={() => setView("intake")} />
            <div style={S.searchBarWrap}>
              <textarea
                style={S.searchBar}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); handleRefine(); }}}
                rows={1}
                placeholder="Refine your search…"
              />
              <button
                style={{ ...S.searchBarBtn, ...(searching?{ opacity:0.5, cursor:"not-allowed" }:{}) }}
                onClick={() => handleRefine()}
                disabled={searching}
              >{searching?"…":"→"}</button>
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

          {(chips.length > 0 || aiSummary) && (
            <div style={S.contextStrip}>
              {chips.map((c,i)=>(
                <span key={i} style={typeof c==="string"?S.chip:S.chipMuted}>{typeof c==="string"?c:c.label}</span>
              ))}
              {aiSummary && <span style={S.aiText}>— {aiSummary}</span>}
            </div>
          )}

          <div style={S.resultsBody}>
            <div style={{ flex:1, overflowY:"auto" }}>
              <div style={S.gridWrap}>
                <div style={S.gridMeta}>
                  <span style={S.gridCnt}>{searching?"Searching…":`${results.length} gifts curated`}</span>
                  <div style={{ display:"flex", gap:4 }}>
                    {[["rec","Recommended"],["asc","Price ↑"],["desc","Price ↓"]].map(([v,l])=>(
                      <button key={v} style={{ ...S.sortBtn, ...(sort===v?S.sortOn:{}) }} onClick={()=>setSort(v)}>{l}</button>
                    ))}
                  </div>
                </div>

                {searching ? (
                  <div style={{ textAlign:"center", padding:"80px 0", fontFamily:"Georgia,serif", fontSize:17, fontStyle:"italic", fontWeight:300, color:"#bbb" }}>
                    Finding the right gifts for you…
                  </div>
                ) : (
                  <div style={S.grid}>
                    {sortedResults.map(p=>(
                      <div key={p.id} style={S.card}>
                        <div style={{ ...S.cardImg, background:p._bg||"#f5f0eb" }}
                          onClick={()=>{ setSelectedProduct({...p}); logEvent("product_view",p.id); }}>
                          {p.image_url ? (
                            <img src={p.image_url} alt={p.name} style={{ position:"absolute", inset:0, width:"100%", height:"100%", objectFit:"cover" }} onError={e=>{e.target.style.display="none"}} />
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
                          <p style={S.cardName}>{p.name}</p>
                          <p style={S.cardCat}>{p.category}</p>
                          <p style={S.cardPrice}>₹{(p._price||0).toLocaleString("en-IN")}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {followUp && !searching && (
                  <div style={S.followUp}>
                    <span style={{ display:"inline-block", width:6, height:6, borderRadius:"50%", background:DOVE_BLUE, flexShrink:0, marginTop:6 }}></span>
                    <div style={{ flex:1 }}>
                      <p style={{ fontFamily:"Georgia,serif", fontSize:16, fontStyle:"italic", fontWeight:300, color:"#666", margin:"0 0 12px", lineHeight:1.75 }}>{followUp}</p>
                      <input style={S.followUpField} placeholder="Type to refine…"
                        onKeyDown={e=>{ if (e.key==="Enter"&&e.target.value.trim()){ handleRefine(query+". "+e.target.value.trim()); e.target.value=""; }}} />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {shortlistOpen && (
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
                      <div style={{ width:42, height:50, background:p._bg||"#f5f0eb", flexShrink:0, overflow:"hidden", cursor:"pointer" }} onClick={()=>setSelectedProduct({...p})}>
                        {p.image_url && <img src={p.image_url} alt={p.name} style={{ width:"100%", height:"100%", objectFit:"cover" }} onError={e=>{e.target.style.display="none"}} />}
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <p style={{ fontSize:12, fontWeight:500, color:"#111", margin:"0 0 2px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.name}</p>
                        <p style={{ fontSize:11, color:"#aaa", margin:0 }}>₹{(p._price||0).toLocaleString("en-IN")}</p>
                      </div>
                      <button style={{ background:"none", border:"none", color:"#ccc", cursor:"pointer", fontSize:17, padding:0, flexShrink:0 }} onClick={()=>toggleHeart(p)}>×</button>
                    </div>
                  ))}
                </div>
                <div style={S.drawerFtr}>
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

      {/* MODAL */}
      {selectedProduct?.id && (
        <div style={S.modalOverlay} onClick={()=>setSelectedProduct(null)}>
          <div style={S.modalBox} onClick={e=>e.stopPropagation()}>
            <button style={S.modalClose} onClick={()=>setSelectedProduct(null)}>×</button>
            <div style={S.modalInner}>
              <div style={S.modalImg}>
                {selectedProduct.image_url ? (
                  <img src={selectedProduct.image_url} alt={selectedProduct.name||""} style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} onError={e=>{e.target.style.display="none"}} />
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
                  <button style={{ background:"none", border:"none", fontSize:26, color:hearted.has(selectedProduct.id)?"#9B3A2A":"#ccc", cursor:"pointer", lineHeight:1 }}
                    onClick={()=>toggleHeart(selectedProduct)}>{hearted.has(selectedProduct.id)?"♥":"♡"}</button>
                </div>
                <p style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:26, fontWeight:400, color:"#111", lineHeight:1.25, margin:"0 0 6px" }}>{selectedProduct.name||""}</p>
                <p style={{ fontSize:11, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 20px" }}>{selectedProduct.category||""}</p>
                <p style={{ fontFamily:"'Playfair Display',Georgia,serif", fontSize:28, fontWeight:400, color:"#111", margin:"0 0 24px" }}>₹{(selectedProduct._price||0).toLocaleString("en-IN")}</p>
                {selectedProduct.description && (
                  <p style={{ fontFamily:"Georgia,serif", fontSize:16, fontWeight:300, color:"#444", lineHeight:1.85, margin:"0 0 24px" }}>{selectedProduct.description}</p>
                )}
                {selectedProduct.whats_in_box && (
                  <div style={{ marginBottom:22, paddingBottom:18, borderBottom:"1px solid #f0f0f0" }}>
                    <p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 8px" }}>What's in the box</p>
                    <p style={{ fontFamily:"Georgia,serif", fontSize:15, fontWeight:300, color:"#555", lineHeight:1.8, margin:0 }}>{formatBox(selectedProduct.whats_in_box)}</p>
                  </div>
                )}
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"14px 24px", marginBottom:28 }}>
                  {selectedProduct.moq && <div><p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 5px" }}>Min. Order</p><p style={{ fontSize:14, color:"#333", margin:0 }}>{selectedProduct.moq} units</p></div>}
                  {selectedProduct.lead_time && <div><p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 5px" }}>Lead Time</p><p style={{ fontSize:14, color:"#333", margin:0 }}>{selectedProduct.lead_time}</p></div>}
                  {selectedProduct.box_dimensions && <div><p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 5px" }}>Dimensions</p><p style={{ fontSize:14, color:"#333", margin:0 }}>{selectedProduct.box_dimensions}</p></div>}
                  {selectedProduct.weight_grams && <div><p style={{ fontSize:10, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#bbb", margin:"0 0 5px" }}>Weight</p><p style={{ fontSize:14, color:"#333", margin:0 }}>{selectedProduct.weight_grams}g</p></div>}
                </div>
                <button style={{ ...S.btnGreen, ...(hearted.has(selectedProduct.id)?{ background:"#9B3A2A", boxShadow:"0 4px 0 #e8b4a8" }:{}) }}
                  onClick={()=>toggleHeart(selectedProduct)}>
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

const styles = {
  app: { minHeight:"100vh", background:"#fff", fontFamily:"'Josefin Sans','Helvetica Neue',sans-serif" },
  fullCenter: { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:"100vh", textAlign:"center", padding:32 },
  av: { width:36, height:36, borderRadius:"50%", background:"#7A90B0", fontSize:12, fontWeight:600, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },

  // Intake
  intakePage: { minHeight:"100vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"60px 40px", position:"relative" },

  // Client badge — larger, caps
  clientBadge: { position:"absolute", top:28, right:32, display:"flex", alignItems:"center", gap:12 },
  clientName: {
    fontFamily:"'Playfair Display',Georgia,serif",
    fontSize:15,
    fontWeight:700,
    letterSpacing:3,
    textTransform:"uppercase",
    color:"#111",
    margin:0,
    lineHeight:1.3,
  },
  clientCompany: {
    fontSize:11,
    fontWeight:300,
    color:"#aaa",
    margin:0,
    letterSpacing:"0.5px",
  },

  intakeCenter: { width:"100%", maxWidth:640 },
  tagline: { fontSize:10, letterSpacing:"3px", textTransform:"uppercase", color:"#bbb", margin:"10px 0 0", textAlign:"center", fontWeight:300 },
  intakeMessages: { marginBottom:24, maxHeight:340, overflowY:"auto" },

  doveLabel: { display:"flex", alignItems:"center", gap:6, marginBottom:10 },

  // Dove message — italic Georgia
  doveMessage: {
    fontFamily:"'Playfair Display',Georgia,serif",
    fontSize:19,
    fontWeight:400,
    fontStyle:"italic",
    color:"#1a1a1a",
    lineHeight:1.85,
    margin:0,
    maxWidth:"88%",
  },

  // User message — same serif family, non-italic, slightly smaller, right-aligned
  userMessage: {
    fontFamily:"'Playfair Display',Georgia,serif",
    fontSize:17,
    fontWeight:400,
    fontStyle:"normal",
    color:"#333",
    lineHeight:1.75,
    margin:0,
    maxWidth:"80%",
    textAlign:"right",
  },

  intakeInputWrap: { display:"flex", alignItems:"flex-end", border:"1px solid #CDCAC4", background:"#fff" },
  intakeTextarea: { flex:1, border:"none", outline:"none", resize:"none", padding:"16px 20px 10px", fontFamily:"Georgia,serif", fontSize:17, fontWeight:300, color:"#111", lineHeight:1.7, background:"transparent" },
  intakeSendBtn: { width:50, height:50, background:"#2C5F3A", border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", flexShrink:0, alignSelf:"flex-end" },

  pastSearches: { marginTop:28 },
  pastLabel: { fontSize:9, fontWeight:600, letterSpacing:"2.5px", textTransform:"uppercase", color:"#ccc", margin:"0 0 10px" },
  pastItem: { display:"block", fontFamily:"Georgia,serif", fontSize:14, fontWeight:300, fontStyle:"italic", color:"#aaa", background:"none", border:"none", cursor:"pointer", textAlign:"left", padding:"5px 0", lineHeight:1.5, width:"100%" },

  // Results
  resultsPage: { height:"100vh", display:"flex", flexDirection:"column", overflow:"hidden" },
  topBar: { display:"flex", alignItems:"center", gap:16, padding:"0 24px", height:56, borderBottom:"1px solid #EDEBE6", flexShrink:0, background:"#fff" },
  searchBarWrap: { flex:1, display:"flex", border:"1px solid #CDCAC4", height:36 },
  searchBar: { flex:1, border:"none", outline:"none", resize:"none", padding:"7px 14px", fontFamily:"Georgia,serif", fontSize:15, fontWeight:300, color:"#111", background:"transparent", lineHeight:1.4 },
  searchBarBtn: { width:42, background:"#2C5F3A", border:"none", cursor:"pointer", color:"#fff", fontSize:17, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  shortlistBtn: { background:"#2C5F3A", color:"#fff", border:"none", padding:"7px 14px", fontFamily:"'Josefin Sans',sans-serif", fontSize:11, fontWeight:600, letterSpacing:"1px", cursor:"pointer", flexShrink:0, boxShadow:"0 3px 0 #a8d4b4" },

  contextStrip: { padding:"8px 24px", display:"flex", gap:8, flexWrap:"wrap", alignItems:"center", borderBottom:"1px solid #F5F2EE", background:"#FAFAF8", flexShrink:0 },
  chip: { fontSize:10, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:"#2C5F3A", padding:"3px 10px", border:"1px solid #a8c8b4", background:"#eaf2ec" },
  chipMuted: { fontSize:10, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", color:"#bbb", padding:"3px 10px", border:"1px solid #eee", background:"#fafafa" },
  aiText: { fontFamily:"Georgia,serif", fontSize:14, fontStyle:"italic", fontWeight:300, color:"#888" },

  resultsBody: { flex:1, display:"flex", overflow:"hidden" },
  gridWrap: { padding:"22px 24px" },
  gridMeta: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 },
  gridCnt: { fontSize:11, color:"#bbb", letterSpacing:"1px", textTransform:"uppercase" },
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
  cardCat: { fontSize:10, letterSpacing:"1.5px", textTransform:"uppercase", color:"#bbb", margin:"0 0 7px" },
  cardPrice: { fontSize:14, fontWeight:600, color:"#111", margin:0 },

  followUp: { display:"flex", alignItems:"flex-start", gap:12, marginTop:40, padding:"22px 24px", background:"#F9F7F4", borderTop:"1px solid #EDEBE6" },
  followUpField: { fontFamily:"Georgia,serif", fontSize:15, fontWeight:300, fontStyle:"italic", color:"#111", border:"none", borderBottom:"1px solid #ccc", padding:"4px 0", outline:"none", background:"transparent", width:"100%" },

  drawer: { width:272, background:"#fff", borderLeft:"1px solid #EDEBE6", display:"flex", flexDirection:"column", flexShrink:0 },
  drawerHdr: { padding:"16px 20px 14px", borderBottom:"1px solid #EDEBE6", display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0 },
  drawerTitle: { fontSize:11, fontWeight:600, letterSpacing:"2px", textTransform:"uppercase", color:"#111", margin:0 },
  slRow: { display:"flex", alignItems:"center", gap:10, padding:"11px 18px", borderBottom:"1px solid #F5F0E8" },
  drawerFtr: { padding:18, borderTop:"1px solid #EDEBE6", flexShrink:0 },
  btnGreen: { width:"100%", background:"#2C5F3A", color:"#fff", border:"none", padding:14, fontFamily:"'Josefin Sans',sans-serif", fontSize:11, fontWeight:600, letterSpacing:"1.5px", textTransform:"uppercase", cursor:"pointer", boxShadow:"0 4px 0 #a8d4b4", display:"block" },

  modalOverlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:500, padding:32 },
  modalBox: { background:"#fff", width:"100%", maxWidth:820, maxHeight:"90vh", overflow:"hidden", position:"relative", display:"flex", flexDirection:"column" },
  modalClose: { position:"absolute", top:12, right:16, background:"none", border:"none", fontSize:28, color:"#aaa", cursor:"pointer", lineHeight:1, zIndex:10 },
  modalInner: { display:"flex", flex:1, minHeight:480, overflow:"hidden" },
  modalImg: { width:340, minWidth:340, flexShrink:0, background:"#f5f0eb", overflow:"hidden" },
  modalContent: { flex:1, padding:"32px 28px", overflowY:"auto" },
};
