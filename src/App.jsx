import { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabase.js";

const CATALOGUE_URL = import.meta.env.VITE_CATALOGUE_SERVICE_URL ||
  "https://ikka-catalogue-service-production.up.railway.app";

const BG_COLORS = ["#F5EFE8","#EDF2EE","#EEF0F7","#F7EEF0","#F0EDE8","#EEF5F2","#F5F0E8","#EEF1F7","#F2EEF5"];
const ACCENT_COLORS = ["#C27B6E","#7A9E8A","#7A8EBE","#BE7A8A","#9B7D55","#5A9E82","#C29B55","#7A9EBE","#9B7ABE"];
const TIER_LABEL = { Gold:"Gold", Silver:"Silver", Platinum:"Platinum" };

function priceAtQty(tiers, qty) {
  if (!tiers?.length) return 0;
  const match = tiers.filter(t => qty >= t.min_qty && (t.max_qty === null || qty <= t.max_qty))
    .sort((a,b) => b.min_qty - a.min_qty)[0];
  return match ? parseFloat(match.price_per_unit) : parseFloat(tiers[0].price_per_unit);
}

function initials(name) {
  return name.split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();
}

export default function App() {
  const [session, setSession] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [products, setProducts] = useState([]);
  const [results, setResults] = useState([]);
  const [hearted, setHearted] = useState(new Set());
  const [shortlistProducts, setShortlistProducts] = useState([]);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [chips, setChips] = useState([]);
  const [aiMessage, setAiMessage] = useState("");
  const [aiQuestion, setAiQuestion] = useState("");
  const [view, setView] = useState("landing");
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState("rec");
  const [conversationHistory, setConversationHistory] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token") ||
      window.location.pathname.split("/").pop();
    if (token && token !== "/") loadSession(token);
    else setNotFound(true);
  }, []);

  const loadSession = async (token) => {
    const { data, error } = await supabase
      .from("rd_sessions")
      .select("*")
      .eq("token", token)
      .single();
    if (error || !data) { setNotFound(true); return; }
    setSession(data);
    await supabase.from("rd_sessions").update({ last_active: new Date().toISOString() }).eq("id", data.id);
    loadProducts(data);
    loadShortlist(data.id);
  };

  const loadProducts = async (sess) => {
    const { data } = await supabase
      .from("catalog")
      .select("*, pricing_tiers(*)")
      .eq("active", true)
      .order("popularity", { ascending: false });
    if (data) {
      const mapped = data.map((p, i) => ({
        ...p,
        _bg: BG_COLORS[i % BG_COLORS.length],
        _accent: ACCENT_COLORS[i % ACCENT_COLORS.length],
        _price: priceAtQty(p.pricing_tiers, 1),
      }));
      setProducts(mapped);
    }
  };

  const loadShortlist = async (sessionId) => {
    const { data } = await supabase
      .from("rd_shortlists")
      .select("product_id")
      .eq("session_id", sessionId);
    if (data) setHearted(new Set(data.map(r => r.product_id)));
  };

  const logEvent = useCallback(async (eventType, productId = null, metadata = {}) => {
    if (!session) return;
    await supabase.from("rd_events").insert([{
      session_id: session.id,
      event_type: eventType,
      product_id: productId,
      metadata,
    }]);
  }, [session]);

  const saveConversation = useCallback(async (role, message, tagFilters = null) => {
    if (!session) return;
    await supabase.from("rd_conversations").insert([{
      session_id: session.id,
      role,
      message,
      tag_filters: tagFilters,
    }]);
  }, [session]);

  const doSearch = async (q) => {
    if (!q.trim() || loading) return;
    setLoading(true);
    setActiveQuery(q);
    setView("results");
    logEvent("query", null, { query: q });
    saveConversation("user", q);

    try {
      const res = await fetch(CATALOGUE_URL + "/interpret-query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, conversation_history: conversationHistory }),
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();

      const newHistory = [...conversationHistory, { role: "user", content: q }];
      if (data.summary) newHistory.push({ role: "assistant", content: data.summary });
      setConversationHistory(newHistory);

      const tagFilter = {
        intent: data.intent || "",
        audience: data.audience || "",
        style: data.style || "",
        include_tags: data.include_tags || [],
        exclude_tags: data.exclude_tags || [],
      };

      const newChips = [];
      if (data.occasion && data.occasion !== "all") newChips.push(data.occasion);
      if (data.audience) newChips.push(data.audience);
      if (data.budget) newChips.push(`₹${data.budget} / unit`);
      if (data.qty) newChips.push(`${data.qty} units`);
      if (data.exclude_edible) newChips.push({ label: "Non-edible", muted: true });
      if (data.exclude_fragile) newChips.push({ label: "Non-fragile", muted: true });
      setChips(newChips);
      setAiMessage(data.summary || "Here are some curated gifts for you.");
      setAiQuestion(data.follow_up || "");
      saveConversation("assistant", data.summary || "", tagFilter);

      const qty = data.qty || 1;
      const budget = data.budget || Infinity;
      let filtered = products.filter(p => {
        const price = priceAtQty(p.pricing_tiers, qty);
        if (budget < Infinity && price > budget * 1.1) return false;
        if (data.exclude_edible && p.edible) return false;
        if (data.exclude_fragile && p.fragile) return false;
        return true;
      }).map(p => ({ ...p, _price: priceAtQty(p.pricing_tiers, qty) }));

      setResults(filtered.slice(0, 12));
    } catch (e) {
      setResults(products.slice(0, 12));
      setAiMessage("Here are some of our curated gifts. Refine your search to narrow it down.");
    }
    setLoading(false);
  };

  const toggleHeart = async (productId) => {
    if (!session) return;
    const isHearted = hearted.has(productId);
    const newHearted = new Set(hearted);
    if (isHearted) {
      newHearted.delete(productId);
      await supabase.from("rd_shortlists").delete()
        .eq("session_id", session.id).eq("product_id", productId);
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
    const items = results.filter(p => hearted.has(p.id));
    logEvent("shortlist_submit", null, { product_ids: [...hearted], count: hearted.size });
    saveConversation("user", `Submitted shortlist: ${items.map(p => p.name).join(", ")}`);
    setTimeout(() => { setView("submitted"); setSubmitting(false); }, 800);
  };

  const sortedResults = [...results].sort((a, b) => {
    if (sort === "asc") return a._price - b._price;
    if (sort === "desc") return b._price - a._price;
    return (b.popularity || 0) - (a.popularity || 0);
  });

  const shortlistedItems = results.filter(p => hearted.has(p.id));
  const totalEstimate = shortlistedItems.reduce((s, p) => s + p._price, 0);

  const S = styles;

  if (notFound) return (
    <div style={S.center}>
      <div style={S.notFoundLogo}>ROCK DOVE</div>
      <div style={S.notFoundMsg}>This link is invalid or has expired.</div>
      <div style={S.notFoundSub}>Please contact your Rock Dove curator for a new link.</div>
    </div>
  );

  if (!session) return (
    <div style={S.center}>
      <div style={S.loadingLogo}>ROCK DOVE</div>
      <div style={S.loadingSub}>Loading your experience…</div>
    </div>
  );

  if (view === "submitted") return (
    <div style={S.center}>
      <div style={S.submittedMark}>✓</div>
      <div style={S.submittedTitle}>Shortlist sent</div>
      <div style={S.submittedSub}>Thank you, {session.client_name.split(" ")[0]}. We'll follow up within 24 hours with availability and final pricing.</div>
      <div style={S.submittedItems}>
        {shortlistedItems.map(p => (
          <div key={p.id} style={S.submittedItem}>
            <div style={{...S.submittedThumb, background: p._bg}}></div>
            <div>
              <div style={S.submittedName}>{p.name}</div>
              <div style={S.submittedPrice}>₹{p._price.toLocaleString("en-IN")}</div>
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
          <div style={S.logoMain}>
            <span style={{color:"#111"}}>ROCK </span>
            <span style={{color:"#378ADD", fontStyle:"italic"}}>Dove</span>
          </div>
          <div style={S.logoBy}>by Ikka Dukka · Gift Intelligence</div>
        </div>
        <div style={S.hdrRight}>
          <div style={S.clientPill}>
            <div style={S.avatar}>{initials(session.client_name)}</div>
            <div>
              <div style={S.clientName}>{session.client_name}</div>
              {session.client_company && <div style={S.clientCo}>{session.client_company}</div>}
            </div>
          </div>
          {view === "results" && hearted.size > 0 && (
            <div style={S.slBtn}>
              <span style={S.slBtnIcon}>♥</span>
              <span style={S.slBtnN}>{hearted.size}</span>
            </div>
          )}
        </div>
      </div>

      {/* Landing */}
      {view === "landing" && (
        <div style={S.landing}>
          <div style={S.landingKicker}>Welcome, {session.client_name.split(" ")[0]}</div>
          <div style={S.landingH1}>
            What would you like to <em style={{fontStyle:"italic", color:"#3B9E5A"}}>gift</em> today?
          </div>
          <div style={S.landingSub}>
            Tell us about the occasion and the people. We'll curate the rest — thoughtfully.
          </div>
          <div style={S.qbox}>
            <div style={S.qboxInputWrap}>
              <input
                style={S.qboxInput}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === "Enter" && doSearch(query)}
                placeholder="e.g. Diwali gifts for 50 senior bankers, around ₹3,000…"
              />
            </div>
            <div style={S.findBtnWrap}>
              <button style={S.findBtn} onClick={() => doSearch(query)} disabled={loading}>
                {loading ? "Curating…" : "Find Gifts →"}
              </button>
            </div>
          </div>
          <div style={S.sugs}>
            {[
              "Diwali gifts for my leadership team, around ₹3,000",
              "Premium thank-you gift for a key client",
              "Onboarding gifts for new joiners, ₹1,500",
              "Work anniversary gifts for long-tenure employees",
            ].map(s => (
              <span key={s} style={S.sug} onClick={() => { setQuery(s); doSearch(s); }}>
                {s.split(",")[0]}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Results */}
      {view === "results" && (
        <>
          <div style={S.qbar}>
            <input
              style={S.qbarInp}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === "Enter" && doSearch(query)}
              placeholder="Refine your search…"
            />
            <button style={S.qbarRefine} onClick={() => doSearch(query)} disabled={loading}>
              {loading ? "Curating…" : "Refine →"}
            </button>
          </div>

          {chips.length > 0 && (
            <div style={S.ctxRow}>
              {chips.map((c, i) => (
                <div key={i} style={typeof c === "string" ? S.ctxChip : S.ctxChipMuted}>
                  {typeof c === "string" ? c : c.label}
                </div>
              ))}
            </div>
          )}

          {aiMessage && (
            <div style={S.aiRow}>
              <div style={S.aiMark}>
                <div style={S.aiDot}></div>
                <div style={S.aiLbl}>ROCK DOVE</div>
              </div>
              <div style={S.aiCopy}>
                {aiMessage}
                {aiQuestion && (
                  <div style={S.aiQ} onClick={() => { setQuery(aiQuestion); doSearch(aiQuestion); }}>
                    <span style={S.aiQTxt}>{aiQuestion} →</span>
                  </div>
                )}
              </div>
            </div>
          )}

          <div style={S.bodyWrap}>
            <div style={S.gridArea}>
              <div style={S.gridMeta}>
                <div style={S.gridCount}>{results.length} gifts curated</div>
                <div style={S.sortRow}>
                  {[["rec","Recommended"],["asc","Price ↑"],["desc","Price ↓"]].map(([v,l]) => (
                    <button key={v} style={{...S.sortB, ...(sort===v?S.sortBOn:{})}} onClick={() => setSort(v)}>{l}</button>
                  ))}
                </div>
              </div>

              {loading ? (
                <div style={S.loadingGrid}>Curating your gifts…</div>
              ) : (
                <div style={S.grid}>
                  {sortedResults.map(p => (
                    <div key={p.id} style={S.card} onClick={() => logEvent("product_view", p.id)}>
                      <div style={{...S.cardImg, background: p._bg}}>
                        {p.image_url ? (
                          <img
                            src={p.image_url}
                            alt={p.name}
                            style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover"}}
                          />
                        ) : (
                          <div style={S.cardImgInner}>
                            <div style={S.cardImgCat}>{p.category}</div>
                          </div>
                        )}
                        <div style={{...S.cardAccent, background: p._accent}}></div>
                        <button
                          style={{...S.heart, ...(hearted.has(p.id) ? S.heartOn : {})}}
                          onClick={e => { e.stopPropagation(); toggleHeart(p.id); }}
                        >{hearted.has(p.id) ? "♥" : "♡"}</button>
                      </div>
                      <div style={S.cardBody}>
                        <div style={{
                          ...S.cardTier,
                          ...(p.tier === "Gold" ? S.tierGold : p.tier === "Platinum" ? S.tierPlat : S.tierSilver)
                        }}>{TIER_LABEL[p.tier] || p.tier}</div>
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
            <div style={S.slPanel}>
              <div style={S.slHd}>
                <div style={S.slHdLbl}>YOUR SHORTLIST</div>
                <div style={S.slHdVal}>
                  {hearted.size === 0 ? "Nothing saved yet" : `${hearted.size} gift${hearted.size !== 1 ? "s" : ""} saved`}
                </div>
              </div>
              <div style={S.slItems}>
                {hearted.size === 0 ? (
                  <div style={S.slEmpty}>Heart a gift<br/>to save it here.</div>
                ) : shortlistedItems.map(p => (
                  <div key={p.id} style={S.slItem}>
                    <div style={{...S.slThumb, background: p._bg, borderLeft: `3px solid ${p._accent}`}}></div>
                    <div style={S.slInfo}>
                      <div style={S.slIname}>{p.name}</div>
                      <div style={S.slIprice}>₹{p._price.toLocaleString("en-IN")}</div>
                    </div>
                    <button style={S.slRm} onClick={() => toggleHeart(p.id)}>×</button>
                  </div>
                ))}
              </div>
              <div style={S.slFt}>
                <div style={S.slTotalLbl}>ESTIMATED TOTAL</div>
                <div style={S.slTotalVal}>
                  {hearted.size === 0 ? "—" : `₹${totalEstimate.toLocaleString("en-IN")}`}
                </div>
                <button
                  style={{...S.slCta, ...(hearted.size === 0 ? S.slCtaDisabled : {})}}
                  onClick={submitShortlist}
                  disabled={hearted.size === 0 || submitting}
                >
                  {submitting ? "Sending…" : "Send to Rock Dove →"}
                </button>
                <div style={S.slNote}>We follow up within 24 hrs</div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const styles = {
  app: { background:"#fff", minHeight:"100vh", display:"flex", flexDirection:"column", fontFamily:"'DM Sans', 'Helvetica Neue', sans-serif" },
  center: { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:"100vh", textAlign:"center", padding:32 },

  notFoundLogo: { fontFamily:"'Playfair Display', serif", fontSize:24, fontWeight:700, letterSpacing:6, color:"#111", marginBottom:20 },
  notFoundMsg: { fontSize:18, fontWeight:500, color:"#111", marginBottom:8 },
  notFoundSub: { fontSize:14, color:"#888" },
  loadingLogo: { fontFamily:"'Playfair Display', serif", fontSize:24, fontWeight:700, letterSpacing:6, color:"#111", marginBottom:16 },
  loadingSub: { fontSize:14, color:"#999" },

  submittedMark: { width:52, height:52, borderRadius:"99px", background:"#3B9E5A", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, marginBottom:20 },
  submittedTitle: { fontFamily:"'Playfair Display', serif", fontSize:26, fontWeight:600, color:"#111", marginBottom:8 },
  submittedSub: { fontSize:15, color:"#666", maxWidth:400, lineHeight:1.7, marginBottom:32 },
  submittedItems: { display:"flex", flexDirection:"column", gap:12, width:"100%", maxWidth:400 },
  submittedItem: { display:"flex", alignItems:"center", gap:12, padding:"10px 0", borderBottom:"1px solid #F0F0F0" },
  submittedThumb: { width:44, height:44, flexShrink:0 },
  submittedName: { fontSize:14, fontWeight:500, color:"#111", marginBottom:3 },
  submittedPrice: { fontSize:13, color:"#888" },

  hdr: { background:"#fff", padding:"0 32px", display:"flex", alignItems:"center", justifyContent:"space-between", height:64, borderBottom:"1px solid #EBEBEB", flexShrink:0 },
  logoMain: { fontFamily:"'Playfair Display', serif", fontSize:19, fontWeight:700, letterSpacing:4, textTransform:"uppercase", lineHeight:1 },
  logoBy: { fontSize:11, color:"#AAA", letterSpacing:0.5, marginTop:3 },
  hdrRight: { display:"flex", alignItems:"center", gap:16 },
  clientPill: { display:"flex", alignItems:"center", gap:10 },
  avatar: { width:36, height:36, borderRadius:"99px", background:"#F5A97A", display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:600, color:"#fff", flexShrink:0 },
  clientName: { fontSize:14, fontWeight:500, color:"#111", lineHeight:1.2 },
  clientCo: { fontSize:12, color:"#999" },
  slBtn: { display:"flex", alignItems:"center", gap:6, borderLeft:"1px solid #EBEBEB", paddingLeft:16 },
  slBtnIcon: { fontSize:15, color:"#C27B6E" },
  slBtnN: { fontSize:13, fontWeight:600, color:"#C27B6E" },

  landing: { display:"flex", flexDirection:"column", alignItems:"center", padding:"72px 32px 52px", textAlign:"center" },
  landingKicker: { fontSize:13, fontWeight:500, color:"#999", marginBottom:16, letterSpacing:1, textTransform:"uppercase" },
  landingH1: { fontFamily:"'Playfair Display', serif", fontSize:40, fontWeight:600, color:"#111", lineHeight:1.25, maxWidth:520, marginBottom:16 },
  landingSub: { fontSize:16, color:"#666", lineHeight:1.7, maxWidth:400, marginBottom:44 },
  qbox: { width:"100%", maxWidth:600, display:"flex", flexDirection:"column" },
  qboxInputWrap: { borderBottom:"2px solid #111", display:"flex", alignItems:"flex-end", paddingBottom:6 },
  qboxInput: { flex:1, border:"none", padding:"0 0 6px", fontSize:16, color:"#111", outline:"none", background:"transparent", width:"100%" },
  findBtnWrap: { display:"flex", justifyContent:"center", marginTop:20 },
  findBtn: { background:"#C0302A", border:"none", cursor:"pointer", padding:"14px 40px", fontSize:14, fontWeight:600, color:"#fff", letterSpacing:1 },
  sugs: { display:"flex", gap:10, flexWrap:"wrap", justifyContent:"center", marginTop:28, maxWidth:600 },
  sug: { fontSize:13, color:"#666", cursor:"pointer", padding:"6px 14px", border:"1px solid #DDD", borderRadius:2, background:"#FAFAFA" },

  qbar: { background:"#fff", borderBottom:"1px solid #EBEBEB", padding:"12px 32px", display:"flex", alignItems:"center", gap:16, flexShrink:0 },
  qbarInp: { flex:1, border:"none", borderBottom:"1px solid #DDD", padding:"6px 0", fontSize:15, color:"#111", outline:"none", background:"transparent" },
  qbarRefine: { background:"transparent", border:"1px solid #C0302A", cursor:"pointer", padding:"7px 18px", fontSize:13, fontWeight:600, color:"#C0302A", letterSpacing:0.5 },

  ctxRow: { padding:"10px 32px", display:"flex", gap:8, flexWrap:"wrap", borderBottom:"1px solid #F5F5F5", flexShrink:0 },
  ctxChip: { fontSize:12, fontWeight:500, color:"#7A5C2E", padding:"4px 12px", border:"1px solid #E8D8C0", background:"#FBF7F2", borderRadius:2 },
  ctxChipMuted: { fontSize:12, color:"#AAA", padding:"4px 12px", border:"1px solid #EEE", background:"#fff", borderRadius:2 },

  aiRow: { padding:"14px 32px", borderBottom:"1px solid #F5F5F5", display:"flex", gap:14, alignItems:"flex-start", background:"#FDFAF6", flexShrink:0 },
  aiMark: { display:"flex", alignItems:"center", gap:6, flexShrink:0, paddingTop:3 },
  aiDot: { width:6, height:6, background:"#7A9E8A", borderRadius:"99px" },
  aiLbl: { fontSize:9, fontWeight:700, letterSpacing:2, color:"#7A9E8A" },
  aiCopy: { fontSize:14, color:"#444", lineHeight:1.7, flex:1 },
  aiQ: { marginTop:10, display:"inline-flex", cursor:"pointer" },
  aiQTxt: { fontSize:13, fontWeight:500, color:"#7A9E8A", borderBottom:"1px solid #7A9E8A" },

  bodyWrap: { display:"flex", flex:1, overflow:"hidden" },
  gridArea: { flex:1, padding:"24px 32px", overflowY:"auto" },
  gridMeta: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 },
  gridCount: { fontSize:13, color:"#888" },
  sortRow: { display:"flex", gap:16 },
  sortB: { fontSize:13, color:"#AAA", cursor:"pointer", background:"transparent", border:"none", padding:0 },
  sortBOn: { color:"#111", fontWeight:600, borderBottom:"1px solid #111" },
  loadingGrid: { fontSize:14, color:"#AAA", textAlign:"center", padding:"60px 0" },

  grid: { display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(200px, 1fr))", gap:"28px 16px" },
  card: { cursor:"pointer", position:"relative", background:"#fff" },
  cardImg: { width:"100%", paddingBottom:"120%", position:"relative", overflow:"hidden" },
  cardImgInner: { position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center" },
  cardImgCat: { fontSize:11, letterSpacing:2, color:"#BBB" },
  cardAccent: { position:"absolute", bottom:0, left:0, right:0, height:3, opacity:0.5 },
  heart: { position:"absolute", top:10, right:10, background:"rgba(255,255,255,0.85)", border:"none", cursor:"pointer", fontSize:17, color:"#CCC", padding:"4px 6px", lineHeight:1, borderRadius:2 },
  heartOn: { color:"#C27B6E" },
  cardBody: { padding:"12px 0 0" },
  cardTier: { fontSize:10, fontWeight:600, letterSpacing:1, padding:"2px 8px", display:"inline-block", marginBottom:6, borderRadius:2 },
  tierGold: { color:"#7A5C2E", background:"#FBF7F2", border:"1px solid #E8D8C0" },
  tierSilver: { color:"#666", background:"#F5F5F5", border:"1px solid #E5E5E5" },
  tierPlat: { color:"#3B5A8A", background:"#EEF3FA", border:"1px solid #C8D8EC" },
  cardName: { fontFamily:"'Playfair Display', serif", fontSize:14, fontWeight:600, color:"#111", lineHeight:1.4, marginBottom:4 },
  cardCat: { fontSize:12, color:"#999", marginBottom:6 },
  cardPrice: { fontSize:15, fontWeight:600, color:"#111" },

  slPanel: { width:210, background:"#FDFAF6", borderLeft:"1px solid #EEE8DC", display:"flex", flexDirection:"column", flexShrink:0, overflowY:"auto" },
  slHd: { padding:"20px 16px 14px", borderBottom:"1px solid #EEE8DC", background:"#F7F0E8", flexShrink:0 },
  slHdLbl: { fontSize:9, fontWeight:700, letterSpacing:2, color:"#C27B6E", marginBottom:6 },
  slHdVal: { fontSize:14, fontWeight:500, color:"#7A5C2E" },
  slItems: { flex:1, overflowY:"auto" },
  slEmpty: { padding:"28px 16px", fontSize:13, color:"#BBB", textAlign:"center", lineHeight:1.8 },
  slItem: { display:"flex", gap:10, padding:"10px 14px", borderBottom:"1px solid #F5EDE3", alignItems:"center" },
  slThumb: { width:36, height:44, flexShrink:0 },
  slInfo: { flex:1, minWidth:0 },
  slIname: { fontSize:12, fontWeight:500, color:"#333", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", marginBottom:3 },
  slIprice: { fontSize:12, color:"#888" },
  slRm: { background:"none", border:"none", color:"#CCC", cursor:"pointer", fontSize:16, padding:0 },
  slFt: { padding:16, borderTop:"1px solid #EEE8DC", flexShrink:0 },
  slTotalLbl: { fontSize:9, fontWeight:700, letterSpacing:2, color:"#C27B6E", marginBottom:6 },
  slTotalVal: { fontSize:22, fontWeight:600, color:"#111", marginBottom:16 },
  slCta: { width:"100%", background:"#C27B6E", color:"#fff", border:"none", padding:13, fontSize:12, fontWeight:600, letterSpacing:1, cursor:"pointer" },
  slCtaDisabled: { opacity:0.4, cursor:"not-allowed" },
  slNote: { fontSize:11, color:"#BBB", textAlign:"center", marginTop:8, lineHeight:1.6 },
};
