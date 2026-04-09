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
  const [view, setView] = useState("landing"); // landing | results | submitted
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState("rec");
  const [conversationHistory, setConversationHistory] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  // Read token from URL
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

      // Filter products
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
      <div style={S.notFoundLogo}>Rock <em style={{fontStyle:"italic",color:"#378ADD"}}>Do</em><em style={{fontStyle:"italic",color:"#378ADD"}}>ve</em></div>
      <div style={S.notFoundMsg}>This link is invalid or has expired.</div>
      <div style={S.notFoundSub}>Please contact your Rock Dove curator for a new link.</div>
    </div>
  );

  if (!session) return (
    <div style={S.center}>
      <div style={S.loadingLogo}>Rock <em style={{fontStyle:"italic",color:"#378ADD"}}>Do</em><em style={{fontStyle:"italic",color:"#378ADD"}}>ve</em></div>
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
            <span style={{color:"#378ADD"}}>DO</span>
            <em style={{fontStyle:"italic",color:"#378ADD"}}>ve</em>
          </div>
          <div style={S.logoBy}>by <span style={{color:"#9B7D55"}}>Ikka Dukka</span> · Gift Intelligence</div>
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
              <span style={S.slBtnIcon}>♡</span>
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
            What would you like<br/>to <em style={{fontStyle:"italic",color:"#3B9E5A"}}>gift</em> today?
          </div>
          <div style={S.landingSub}>
            Tell us about the occasion and the people.<br/>We'll curate the rest — thoughtfully.
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
                <span style={S.findBtnTxt}>{loading ? "Curating…" : "Find Gifts"}</span>
                <span style={S.findBtnArr}>→</span>
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
              <span style={S.qbarRefineTxt}>{loading ? "Curating…" : "Refine"}</span>
              <span style={{fontSize:12,color:"#C0302A"}}>→</span>
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
                <div style={S.aiLbl}>Rock Dove</div>
              </div>
              <div style={S.aiCopy}>
                {aiMessage}
                {aiQuestion && (
                  <div style={S.aiQ} onClick={() => { setQuery(aiQuestion); doSearch(aiQuestion); }}>
                    <span style={S.aiQTxt}>{aiQuestion}</span>
                    <span style={{fontSize:11,color:"#B5CEC0"}}>→</span>
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
                        <div style={S.cardImgInner}>
                          <div style={S.cardImgCat}>{p.category}</div>
                        </div>
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
                <div style={S.slHdLbl}>Your shortlist</div>
                <div style={S.slHdVal}>
                  {hearted.size === 0 ? "Nothing saved yet" : `${hearted.size} gift${hearted.size !== 1 ? "s" : ""} saved`}
                </div>
              </div>
              <div style={S.slItems}>
                {hearted.size === 0 ? (
                  <div style={S.slEmpty}>Heart a gift<br/>to save it here.</div>
                ) : shortlistedItems.map(p => (
                  <div key={p.id} style={S.slItem}>
                    <div style={{...S.slThumb, background: p._bg, borderLeft: `2px solid ${p._accent}`}}></div>
                    <div style={S.slInfo}>
                      <div style={S.slIname}>{p.name}</div>
                      <div style={S.slIprice}>₹{p._price.toLocaleString("en-IN")}</div>
                    </div>
                    <button style={S.slRm} onClick={() => toggleHeart(p.id)}>×</button>
                  </div>
                ))}
              </div>
              <div style={S.slFt}>
                <div style={S.slTotalLbl}>Estimated total</div>
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
  app: { background:"#fff", minHeight:"100vh", display:"flex", flexDirection:"column" },
  center: { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:"100vh", textAlign:"center", padding:32 },
  notFoundLogo: { fontFamily:"'Bodoni Moda',serif", fontSize:28, fontWeight:400, letterSpacing:5, color:"#111", textTransform:"uppercase", marginBottom:20 },
  notFoundMsg: { fontFamily:"'Bodoni Moda',serif", fontSize:20, fontWeight:300, color:"#111", marginBottom:8 },
  notFoundSub: { fontFamily:"'Cormorant Garamond',serif", fontSize:15, fontStyle:"italic", color:"#AAA" },
  loadingLogo: { fontFamily:"'Bodoni Moda',serif", fontSize:28, fontWeight:400, letterSpacing:5, color:"#111", textTransform:"uppercase", marginBottom:16 },
  loadingSub: { fontFamily:"'Cormorant Garamond',serif", fontSize:15, fontStyle:"italic", color:"#AAA" },
  submittedMark: { width:48, height:48, borderRadius:"99px", background:"#3B9E5A", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, marginBottom:20 },
  submittedTitle: { fontFamily:"'Bodoni Moda',serif", fontSize:26, fontWeight:300, color:"#111", marginBottom:8 },
  submittedSub: { fontFamily:"'Cormorant Garamond',serif", fontSize:15, fontStyle:"italic", color:"#888", maxWidth:400, lineHeight:1.8, marginBottom:32 },
  submittedItems: { display:"flex", flexDirection:"column", gap:12, width:"100%", maxWidth:400 },
  submittedItem: { display:"flex", alignItems:"center", gap:12, padding:"10px 0", borderBottom:"0.5px solid #F0F0F0" },
  submittedThumb: { width:44, height:44, flexShrink:0 },
  submittedName: { fontFamily:"'Bodoni Moda',serif", fontSize:13, color:"#111", marginBottom:3 },
  submittedPrice: { fontFamily:"'Cormorant Garamond',serif", fontSize:13, fontStyle:"italic", color:"#AAA" },

  hdr: { background:"#fff", padding:"0 32px", display:"flex", alignItems:"center", justifyContent:"space-between", height:60, borderBottom:"0.5px solid #EBEBEB", flexShrink:0 },
  logoMain: { fontFamily:"'Bodoni Moda',serif", fontSize:20, fontWeight:400, letterSpacing:5, textTransform:"uppercase", lineHeight:1 },
  logoBy: { fontFamily:"'Cormorant Garamond',serif", fontSize:10, fontStyle:"italic", color:"#C4BDB4", letterSpacing:1, marginTop:2 },
  hdrRight: { display:"flex", alignItems:"center", gap:16 },
  clientPill: { display:"flex", alignItems:"center", gap:8 },
  avatar: { width:32, height:32, borderRadius:"99px", background:"#F5A97A", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Bodoni Moda',serif", fontSize:11, color:"#fff", flexShrink:0 },
  clientName: { fontFamily:"'Cormorant Garamond',serif", fontSize:14, fontStyle:"italic", color:"#AAA", lineHeight:1 },
  clientCo: { fontFamily:"'Cormorant Garamond',serif", fontSize:11, color:"#CCC", letterSpacing:"0.5px" },
  slBtn: { display:"flex", alignItems:"center", gap:5, borderLeft:"0.5px solid #EBEBEB", paddingLeft:16 },
  slBtnIcon: { fontSize:15, color:"#C27B6E" },
  slBtnN: { fontFamily:"'Bodoni Moda',serif", fontSize:11, color:"#C27B6E" },

  landing: { display:"flex", flexDirection:"column", alignItems:"center", padding:"60px 32px 52px", textAlign:"center" },
  landingKicker: { fontFamily:"'Cormorant Garamond',serif", fontSize:13, fontStyle:"italic", color:"#AAA", marginBottom:20, letterSpacing:1 },
  landingH1: { fontFamily:"'Bodoni Moda',serif", fontSize:38, fontWeight:300, color:"#111", lineHeight:1.2, maxWidth:520, marginBottom:12 },
  landingSub: { fontFamily:"'Cormorant Garamond',serif", fontSize:16, fontStyle:"italic", color:"#AAA", lineHeight:1.9, maxWidth:360, marginBottom:40 },
  qbox: { width:"100%", maxWidth:580, display:"flex", flexDirection:"column" },
  qboxInputWrap: { borderBottom:"1.5px solid #111", display:"flex", alignItems:"flex-end", paddingBottom:4 },
  qboxInput: { flex:1, border:"none", padding:"0 0 6px", fontFamily:"'Bodoni Moda',serif", fontSize:16, fontStyle:"italic", fontWeight:300, color:"#111", outline:"none", background:"transparent", width:"100%" },
  findBtnWrap: { display:"flex", justifyContent:"center", marginTop:18 },
  findBtn: { background:"#C0302A", border:"none", cursor:"pointer", padding:"12px 36px", display:"flex", alignItems:"center", gap:10 },
  findBtnTxt: { fontFamily:"'Playfair Display',serif", fontSize:14, fontVariant:"small-caps", fontWeight:500, color:"#fff", letterSpacing:2 },
  findBtnArr: { fontSize:14, color:"rgba(255,255,255,0.7)" },
  sugs: { display:"flex", gap:10, flexWrap:"wrap", justifyContent:"center", marginTop:24, maxWidth:580 },
  sug: { fontFamily:"'Cormorant Garamond',serif", fontSize:13, fontStyle:"italic", color:"#AAA", cursor:"pointer", padding:"5px 0", borderBottom:"0.5px solid #E8E4DE" },

  qbar: { background:"#fff", borderBottom:"0.5px solid #EBEBEB", padding:"11px 32px", display:"flex", alignItems:"center", gap:16, flexShrink:0 },
  qbarInp: { flex:1, border:"none", borderBottom:"1px solid #DDD", padding:"6px 0", fontFamily:"'Bodoni Moda',serif", fontSize:14, fontStyle:"italic", fontWeight:300, color:"#111", outline:"none", background:"transparent" },
  qbarRefine: { background:"transparent", border:"none", cursor:"pointer", display:"flex", alignItems:"baseline", gap:5, padding:"6px 0" },
  qbarRefineTxt: { fontFamily:"'Playfair Display',serif", fontSize:12, fontVariant:"small-caps", fontWeight:500, color:"#C0302A", letterSpacing:"1.5px" },

  ctxRow: { padding:"10px 32px", display:"flex", gap:8, flexWrap:"wrap", borderBottom:"0.5px solid #F5F5F5", flexShrink:0 },
  ctxChip: { fontFamily:"'Cormorant Garamond',serif", fontSize:12, fontStyle:"italic", color:"#9B7D55", padding:"3px 12px", border:"0.5px solid #E8D8C0", background:"#FBF7F2" },
  ctxChipMuted: { fontFamily:"'Cormorant Garamond',serif", fontSize:12, fontStyle:"italic", color:"#CCC", padding:"3px 12px", border:"0.5px solid #F0F0F0", background:"#fff" },

  aiRow: { padding:"13px 32px", borderBottom:"0.5px solid #F5F5F5", display:"flex", gap:12, alignItems:"flex-start", background:"#FDFAF6", flexShrink:0 },
  aiMark: { display:"flex", alignItems:"center", gap:5, flexShrink:0, paddingTop:3 },
  aiDot: { width:5, height:5, background:"#7A9E8A", borderRadius:"99px" },
  aiLbl: { fontFamily:"'Bodoni Moda',serif", fontSize:8, letterSpacing:3, color:"#B5CEC0", textTransform:"uppercase" },
  aiCopy: { fontFamily:"'Cormorant Garamond',serif", fontSize:14, fontStyle:"italic", color:"#888", lineHeight:1.8, flex:1 },
  aiQ: { marginTop:8, display:"inline-flex", alignItems:"center", gap:8, cursor:"pointer", borderBottom:"0.5px solid #C5DCCE", paddingBottom:1 },
  aiQTxt: { fontFamily:"'Bodoni Moda',serif", fontSize:12, fontStyle:"italic", fontWeight:300, color:"#7A9E8A" },

  bodyWrap: { display:"flex", flex:1, overflow:"hidden" },
  gridArea: { flex:1, padding:"22px 32px", overflowY:"auto" },
  gridMeta: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 },
  gridCount: { fontFamily:"'Cormorant Garamond',serif", fontSize:13, fontStyle:"italic", color:"#BBB" },
  sortRow: { display:"flex", gap:16 },
  sortB: { fontFamily:"'Cormorant Garamond',serif", fontSize:12, fontStyle:"italic", color:"#BBB", cursor:"pointer", background:"transparent", border:"none", padding:0 },
  sortBOn: { color:"#111", borderBottom:"0.5px solid #111" },
  loadingGrid: { fontFamily:"'Cormorant Garamond',serif", fontSize:14, fontStyle:"italic", color:"#CCC", textAlign:"center", padding:"60px 0" },

  grid: { display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(200px, 1fr))", gap:"24px 16px" },
  card: { cursor:"pointer", position:"relative", background:"#fff" },
  cardImg: { width:"100%", paddingBottom:"120%", position:"relative", overflow:"hidden" },
  cardImgInner: { position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center" },
  cardImgCat: { fontFamily:"'Cormorant Garamond',serif", fontSize:10, letterSpacing:2, fontStyle:"italic", color:"#CCC" },
  cardAccent: { position:"absolute", bottom:0, left:0, right:0, height:3, opacity:0.4 },
  heart: { position:"absolute", top:10, right:10, background:"transparent", border:"none", cursor:"pointer", fontSize:16, color:"#DDD", padding:0, lineHeight:1 },
  heartOn: { color:"#C27B6E" },
  cardBody: { padding:"12px 0 0" },
  cardTier: { fontFamily:"'Playfair Display',serif", fontSize:9, fontVariant:"small-caps", letterSpacing:1, padding:"2px 8px", display:"inline-block", marginBottom:6 },
  tierGold: { color:"#9B7D55", background:"#FBF7F2", border:"0.5px solid #E8D8C0" },
  tierSilver: { color:"#888", background:"#F5F5F5", border:"0.5px solid #E5E5E5" },
  tierPlat: { color:"#5A7AA8", background:"#F0F4FA", border:"0.5px solid #C8D8EC" },
  cardName: { fontFamily:"'Bodoni Moda',serif", fontSize:13, fontWeight:400, color:"#111", lineHeight:1.4, marginBottom:3 },
  cardCat: { fontFamily:"'Cormorant Garamond',serif", fontSize:11, fontStyle:"italic", color:"#BBB", marginBottom:6 },
  cardPrice: { fontFamily:"'Bodoni Moda',serif", fontSize:14, fontWeight:300, color:"#111" },

  slPanel: { width:200, background:"#FDFAF6", borderLeft:"0.5px solid #F0E8DC", display:"flex", flexDirection:"column", flexShrink:0, overflowY:"auto" },
  slHd: { padding:"20px 16px 14px", borderBottom:"0.5px solid #F0E8DC", background:"#F7F0E8", flexShrink:0 },
  slHdLbl: { fontFamily:"'Playfair Display',serif", fontSize:9, fontVariant:"small-caps", letterSpacing:2, color:"#C27B6E", marginBottom:4 },
  slHdVal: { fontFamily:"'Bodoni Moda',serif", fontSize:14, fontWeight:300, fontStyle:"italic", color:"#9B7D55" },
  slItems: { flex:1, overflowY:"auto" },
  slEmpty: { padding:"28px 16px", fontFamily:"'Cormorant Garamond',serif", fontSize:13, fontStyle:"italic", color:"#CCC", textAlign:"center", lineHeight:1.8 },
  slItem: { display:"flex", gap:10, padding:"10px 16px", borderBottom:"0.5px solid #F5EDE3", alignItems:"center" },
  slThumb: { width:36, height:44, flexShrink:0 },
  slInfo: { flex:1, minWidth:0 },
  slIname: { fontFamily:"'Bodoni Moda',serif", fontSize:11, color:"#444", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", marginBottom:3 },
  slIprice: { fontFamily:"'Cormorant Garamond',serif", fontSize:12, fontStyle:"italic", color:"#AAA" },
  slRm: { background:"none", border:"none", color:"#DDD", cursor:"pointer", fontSize:14, padding:0 },
  slFt: { padding:16, borderTop:"0.5px solid #F0E8DC", flexShrink:0 },
  slTotalLbl: { fontFamily:"'Playfair Display',serif", fontSize:9, fontVariant:"small-caps", letterSpacing:2, color:"#C27B6E", marginBottom:4 },
  slTotalVal: { fontFamily:"'Bodoni Moda',serif", fontSize:20, fontWeight:300, color:"#111", marginBottom:16 },
  slCta: { width:"100%", background:"#C27B6E", color:"#fff", border:"none", padding:12, fontFamily:"'Playfair Display',serif", fontSize:10, fontVariant:"small-caps", letterSpacing:2, cursor:"pointer" },
  slCtaDisabled: { opacity:0.4, cursor:"not-allowed" },
  slNote: { fontFamily:"'Cormorant Garamond',serif", fontSize:11, fontStyle:"italic", color:"#CCC", textAlign:"center", marginTop:8, lineHeight:1.6 },
};
