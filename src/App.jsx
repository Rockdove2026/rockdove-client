import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase.js";

const CATALOGUE_URL = import.meta.env.VITE_CATALOGUE_SERVICE_URL ||
  "https://ikka-catalogue-service-production.up.railway.app";

const BG_COLORS = ["#F5EFE8","#EDF2EE","#EEF0F7","#F7EEF0","#F0EDE8","#EEF5F2","#F5F0E8","#EEF1F7","#F2EEF5"];
const TIER_LABEL = { Gold:"Gold", Silver:"Silver", Platinum:"Platinum" };

const SUG_STYLES = [
  { color:"#2C5F3A", border:"#a8c8b4", bg:"#eaf2ec" },
  { color:"#7a2018", border:"#e8b4a8", bg:"#fdf0ed" },
  { color:"#3a5a7a", border:"#b0c4d8", bg:"#eef2f8" },
  { color:"#7a5c20", border:"#e8d5a0", bg:"#fdf5e6" },
];

// Dove's conversation steps
const DOVE_STEPS = [
  (name) => `Hello ${name.split(" ")[0]} — I'm Dove, your gifting concierge at Rock Dove.\n\nTell me about your gifting need. Who are you gifting, and what's the occasion?`,
  (ctx) => {
    const hints = [
      "What's your approximate budget per gift?",
      "And roughly how many people are on your list?",
    ];
    return `Wonderful. ${ctx.occasionAck}\n\n${hints[0]}`;
  },
  (ctx) => {
    return `Got it — ${ctx.budgetAck}.\n\nOne last thing: any preferences I should keep in mind? For example, non-edible gifts, something desk-friendly, or anything to avoid?`;
  },
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

function extractBudget(q) {
  const m = q.match(
    /under\s*₹?\s*(\d[\d,]*)|below\s*₹?\s*(\d[\d,]*)|budget\s*(is|of|:)?\s*₹?\s*(\d[\d,]*)|around\s*₹?\s*(\d[\d,]*)|₹\s*(\d[\d,]*)|rs\.?\s*(\d[\d,]*)|(\d[\d,]+)\s*(k\b|thousand)?/i
  );
  if (m) {
    const raw = m[1] || m[2] || m[4] || m[5] || m[6] || m[7] || m[8];
    if (raw) {
      let val = parseInt(raw.replace(/,/g, ""));
      if ((m[9] || "").toLowerCase().includes("k") || (m[9] || "").toLowerCase().includes("thousand")) val *= 1000;
      return val;
    }
  }
  return null;
}

function occasionAck(text) {
  const t = text.toLowerCase();
  if (t.includes("diwali")) return "Diwali gifting — one of the most important occasions to get right.";
  if (t.includes("anniversary")) return "A work anniversary is a moment that really deserves something personal.";
  if (t.includes("onboard") || t.includes("joining") || t.includes("welcome")) return "A welcome gift sets the tone — it should feel considered, not corporate.";
  if (t.includes("thank") || t.includes("client")) return "A client thank-you is an opportunity to leave a lasting impression.";
  if (t.includes("birthday")) return "Birthdays call for something that feels genuinely personal.";
  if (t.includes("retirement")) return "A retirement gift should honour the relationship, not just the milestone.";
  return "That's a meaningful occasion to get right.";
}

function budgetAck(text) {
  const b = extractBudget(text);
  if (b) return `₹${b.toLocaleString("en-IN")} per gift is a good space to work with`;
  return "I'll keep budget in mind as I curate";
}

function buildQuery(messages) {
  // Compile conversation into a search query
  const userMessages = messages.filter(m => m.role === "user").map(m => m.text).join(". ");
  return userMessages;
}

export default function App() {
  const [session, setSession] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const productsRef = useRef([]);
  const [results, setResults] = useState([]);
  const [hearted, setHearted] = useState(new Set());

  // Conversation state
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState("");
  const [step, setStep] = useState(0); // 0=greeting shown, 1=occasion answered, 2=budget answered, 3=prefs answered
  const [doveTyping, setDoveTyping] = useState(false);
  const [conversationCtx, setConversationCtx] = useState({});
  const messagesEndRef = useRef(null);

  // Results state
  const [view, setView] = useState("chat"); // chat | results | submitted
  const [chips, setChips] = useState([]);
  const [aiMessage, setAiMessage] = useState("");
  const [aiQuestion, setAiQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState("rec");
  const [query, setQuery] = useState("");
  const [conversationHistory, setConversationHistory] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const token =
      new URLSearchParams(window.location.search).get("token") ||
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
    await supabase.from("rd_sessions")
      .update({ last_active: new Date().toISOString() }).eq("id", data.id);
    await loadProducts();
    loadShortlist(data.id);
    // Start conversation
    setTimeout(() => {
      addDoveMessage(DOVE_STEPS[0](data.client_name));
    }, 600);
  };

  const loadProducts = async () => {
    const { data, error } = await supabase
      .from("catalog")
      .select("*, pricing_tiers(*)")
      .eq("active", true)
      .order("popularity", { ascending: false });
    if (error) { console.error("loadProducts:", error); return; }
    if (data) {
      const mapped = data.map((p, i) => ({
        ...p,
        _bg: BG_COLORS[i % BG_COLORS.length],
        _price: priceAtQty(p.pricing_tiers, 1),
      }));
      productsRef.current = mapped;
    }
  };

  const loadShortlist = async (sessionId) => {
    const { data } = await supabase
      .from("rd_shortlists").select("product_id").eq("session_id", sessionId);
    if (data) setHearted(new Set(data.map(r => r.product_id)));
  };

  const logEvent = useCallback(async (eventType, productId = null, metadata = {}) => {
    if (!session) return;
    await supabase.from("rd_events").insert([{
      session_id: session.id, event_type: eventType, product_id: productId, metadata,
    }]);
  }, [session]);

  const saveConversation = useCallback(async (role, message, tagFilters = null) => {
    if (!session) return;
    await supabase.from("rd_conversations").insert([{
      session_id: session.id, role, message, tag_filters: tagFilters,
    }]);
  }, [session]);

  const addDoveMessage = (text) => {
    setMessages(prev => [...prev, { role: "dove", text }]);
  };

  const addUserMessage = (text) => {
    setMessages(prev => [...prev, { role: "user", text }]);
  };

  const doveReply = (text, delay = 1200) => {
    setDoveTyping(true);
    setTimeout(() => {
      setDoveTyping(false);
      addDoveMessage(text);
    }, delay);
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || doveTyping || loading) return;
    setInputText("");
    addUserMessage(text);
    saveConversation("user", text);

    if (step === 0) {
      // Occasion + recipient answered
      const ack = occasionAck(text);
      const ctx = { ...conversationCtx, occasionAck: ack, occasion: text };
      setConversationCtx(ctx);
      setStep(1);
      doveReply(DOVE_STEPS[1](ctx));
    } else if (step === 1) {
      // Budget answered
      const bAck = budgetAck(text);
      const budget = extractBudget(text);
      const ctx = { ...conversationCtx, budgetAck: bAck, budget, budgetText: text };
      setConversationCtx(ctx);
      setStep(2);
      doveReply(DOVE_STEPS[2](ctx));
    } else if (step === 2) {
      // Preferences answered — now curate
      const ctx = { ...conversationCtx, prefs: text };
      setConversationCtx(ctx);
      setStep(3);
      setDoveTyping(true);
      setTimeout(() => {
        setDoveTyping(false);
        addDoveMessage(`Perfect. Give me a moment to find something just right for you.`);
        setTimeout(() => startCuration(ctx), 800);
      }, 1400);
    } else {
      // Refinement after results
      const refinedQuery = text;
      setQuery(refinedQuery);
      doSearch(refinedQuery, buildQuery([...messages, { role: "user", text }]));
    }
  };

  const startCuration = async (ctx) => {
    setLoading(true);
    // Build a rich query from the conversation
    const richQuery = [ctx.occasion, ctx.budgetText, ctx.prefs].filter(Boolean).join(". ");
    setQuery(richQuery);
    await doSearch(richQuery, richQuery);
    setView("results");
  };

  const doSearch = async (q, fullContext) => {
    if (!q) return;
    setLoading(true);
    logEvent("query", null, { query: q });

    const allProducts = productsRef.current;

    try {
      const res = await fetch(CATALOGUE_URL + "/interpret-query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: fullContext || q,
          conversation_history: conversationHistory,
        }),
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();

      const newHistory = [...conversationHistory, { role: "user", content: q }];
      if (data.summary) newHistory.push({ role: "assistant", content: data.summary });
      setConversationHistory(newHistory);

      const qty = data.qty || 1;
      const budget = data.budget || extractBudget(q) || conversationCtx.budget || Infinity;
      const includeTags = data.include_tags || [];
      const excludeTags = data.exclude_tags || [];

      const newChips = [];
      if (data.occasion && data.occasion !== "all") newChips.push(data.occasion.toUpperCase().replace(/-/g, " "));
      if (data.audience) newChips.push(data.audience.toUpperCase().replace(/-/g, " "));
      if (budget < Infinity) newChips.push(`₹${budget.toLocaleString("en-IN")} / UNIT`);
      if (qty > 1) newChips.push(`${qty} UNITS`);
      if (data.exclude_edible) newChips.push({ label: "NON-EDIBLE", muted: true });
      if (data.exclude_fragile) newChips.push({ label: "NON-FRAGILE", muted: true });
      setChips(newChips);
      setAiMessage(data.summary || "Here are some curated gifts for you.");
      setAiQuestion(data.follow_up || "");
      saveConversation("assistant", data.summary || "");

      const filtered = allProducts
        .filter(p => {
          const price = priceAtQty(p.pricing_tiers, qty);
          if (budget < Infinity && price > budget * 1.15) return false;
          if (data.exclude_edible && p.edible) return false;
          if (data.exclude_fragile && p.fragile) return false;
          return true;
        })
        .map(p => ({
          ...p,
          _price: priceAtQty(p.pricing_tiers, qty),
        }))
        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

      setResults(filtered.slice(0, 12));
      setSort("rec");
    } catch (e) {
      console.error(e);
      setResults(allProducts.slice(0, 12));
      setAiMessage("Here are our top curated gifts. Tell me more to refine the selection.");
    }
    setLoading(false);
  };

  const refineFromChat = (text) => {
    setInputText(text);
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
      await supabase.from("rd_shortlists")
        .insert([{ session_id: session.id, product_id: productId }]);
      logEvent("shortlist_add", productId);
    }
    setHearted(newHearted);
  };

  const submitShortlist = async () => {
    if (!session || hearted.size === 0) return;
    setSubmitting(true);
    logEvent("shortlist_submit", null, { product_ids: [...hearted], count: hearted.size });
    saveConversation("user", `Submitted shortlist: ${shortlistedItems.map(p => p.name).join(", ")}`);
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
      <div style={S.logoWrap}><span style={S.logoR}>Rock </span><span style={S.logoD}>Dove</span></div>
      <div style={{ fontSize: 17, fontWeight: 500, color: "#1a1a1a", marginTop: 28, marginBottom: 10 }}>This link is invalid or has expired.</div>
      <div style={{ fontSize: 14, color: "#aaa" }}>Please contact your Rock Dove curator for a new link.</div>
    </div>
  );

  if (!session) return (
    <div style={S.center}>
      <div style={S.logoWrap}><span style={S.logoR}>Rock </span><span style={S.logoD}>Dove</span></div>
      <div style={{ fontSize: 13, color: "#bbb", letterSpacing: "2px", textTransform: "uppercase", marginTop: 24 }}>Loading your experience…</div>
    </div>
  );

  if (view === "submitted") return (
    <div style={S.center}>
      <div style={{ width: 56, height: 56, borderRadius: "50%", background: "#2C5F3A", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, marginBottom: 24 }}>✓</div>
      <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 32, fontWeight: 500, color: "#1a1a1a", marginBottom: 12 }}>Shortlist sent</div>
      <div style={{ fontSize: 15, color: "#888", maxWidth: 400, lineHeight: 1.8, marginBottom: 40, textAlign: "center" }}>
        Thank you, {session.client_name.split(" ")[0]}. We'll follow up within 24 hours with availability and final pricing.
      </div>
      <div style={{ width: "100%", maxWidth: 400 }}>
        {shortlistedItems.map(p => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 16, padding: "14px 0", borderBottom: "1px solid #f0f0f0" }}>
            <div style={{ width: 48, height: 58, background: p._bg, flexShrink: 0, overflow: "hidden" }}>
              {p.image_url && <img src={p.image_url} alt={p.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
            </div>
            <div>
              <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 17, fontWeight: 500, color: "#1a1a1a", marginBottom: 4 }}>{p.name}</div>
              <div style={{ fontSize: 14, color: "#aaa" }}>₹{p._price.toLocaleString("en-IN")}</div>
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
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {view === "results" && (
            <button style={S.backBtn} onClick={() => setView("chat")}>← Dove</button>
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
        <div style={S.chatWrap}>

          {/* Messages */}
          <div style={S.messages}>
            {messages.map((m, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "dove" ? "flex-start" : "flex-end", marginBottom: 20 }}>
                {m.role === "dove" && (
                  <div style={S.doveLabel}>
                    <div style={S.doveDot}></div>
                    <span>Dove</span>
                  </div>
                )}
                <div style={m.role === "dove" ? S.doveBubble : S.userBubble}>
                  {m.text.split("\n").map((line, j) => (
                    <span key={j}>{line}{j < m.text.split("\n").length - 1 && <br />}</span>
                  ))}
                </div>
              </div>
            ))}

            {doveTyping && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", marginBottom: 20 }}>
                <div style={S.doveLabel}>
                  <div style={S.doveDot}></div>
                  <span>Dove</span>
                </div>
                <div style={{ ...S.doveBubble, padding: "14px 20px" }}>
                  <div style={S.typingDots}>
                    <span></span><span></span><span></span>
                  </div>
                </div>
              </div>
            )}

            {/* After curation starts */}
            {loading && step === 3 && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", marginBottom: 20 }}>
                <div style={S.doveLabel}><div style={S.doveDot}></div><span>Dove</span></div>
                <div style={S.doveBubble}>Searching through our curated catalogue…</div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div style={S.chatInputWrap}>
            {step >= 3 && !loading && results.length > 0 && (
              <button style={S.viewResultsBtn} onClick={() => setView("results")}>
                VIEW {results.length} CURATED GIFTS →
              </button>
            )}
            <div style={S.chatInputRow}>
              <input
                style={S.chatInput}
                value={inputText}
                onChange={e => setInputText(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleSend()}
                placeholder={step === 0 ? "Tell Dove about the occasion…" : step === 1 ? "Your budget per gift…" : step === 2 ? "Any preferences or things to avoid…" : "Refine or ask Dove anything…"}
                disabled={doveTyping || loading}
              />
              <button
                style={{ ...S.sendBtn, ...((!inputText.trim() || doveTyping || loading) ? { opacity: 0.4 } : {}) }}
                onClick={handleSend}
                disabled={!inputText.trim() || doveTyping || loading}
              >SEND →</button>
            </div>
          </div>
        </div>
      )}

      {/* ── RESULTS VIEW ── */}
      {view === "results" && (
        <>
          {chips.length > 0 && (
            <div style={S.chipsRow}>
              {chips.map((c, i) => (
                <div key={i} style={typeof c === "string" ? S.chip : S.chipMuted}>
                  {typeof c === "string" ? c : c.label}
                </div>
              ))}
            </div>
          )}

          {aiMessage && (
            <div style={S.aiBar}>
              <div style={S.aiDot}></div>
              <div style={S.aiLbl}>Dove</div>
              <div style={S.aiTxt}>
                {aiMessage}
                {aiQuestion && (
                  <span style={S.aiQ} onClick={() => { setView("chat"); setTimeout(() => setInputText(aiQuestion), 100); }}>
                    {" "}{aiQuestion} →
                  </span>
                )}
              </div>
            </div>
          )}

          <div style={S.body}>
            <div style={S.gridWrap}>
              <div style={S.meta}>
                <div style={S.cnt}>{results.length} GIFTS CURATED</div>
                <div style={{ display: "flex" }}>
                  {[["rec", "RECOMMENDED"], ["asc", "PRICE ↑"], ["desc", "PRICE ↓"]].map(([v, l]) => (
                    <button key={v} style={{ ...S.sortBtn, ...(sort === v ? S.sortOn : {}) }} onClick={() => setSort(v)}>{l}</button>
                  ))}
                </div>
              </div>

              {results.length === 0 ? (
                <div style={{ fontSize: 13, color: "#aaa", textAlign: "center", padding: "60px 0", letterSpacing: "2px", textTransform: "uppercase", lineHeight: 2 }}>
                  No gifts found.<br />
                  <button style={{ ...S.sendBtn, marginTop: 16, fontSize: 11 }} onClick={() => setView("chat")}>REFINE WITH DOVE →</button>
                </div>
              ) : (
                <div style={S.grid}>
                  {sortedResults.map(p => (
                    <div key={p.id} style={S.card} onClick={() => logEvent("product_view", p.id)}>
                      <div style={{ ...S.cardImg, background: p._bg }}>
                        {p.image_url ? (
                          <img src={p.image_url} alt={p.name} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                        ) : (
                          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <div style={{ fontSize: 11, letterSpacing: "2px", color: "#ccc", textTransform: "uppercase" }}>{p.category}</div>
                          </div>
                        )}
                        <button
                          style={{ ...S.hbtn, ...(hearted.has(p.id) ? S.hbtnOn : {}) }}
                          onClick={e => { e.stopPropagation(); toggleHeart(p.id); }}
                        >{hearted.has(p.id) ? "♥" : "♡"}</button>
                      </div>
                      <div style={{ marginTop: 12 }}>
                        <span style={{ ...S.tier, ...(p.tier === "Gold" ? S.tierGold : p.tier === "Platinum" ? S.tierPlat : S.tierSilv) }}>
                          {TIER_LABEL[p.tier] || p.tier}
                        </span>
                      </div>
                      <div style={S.cardName}>{p.name}</div>
                      <div style={S.cardCat}>{p.category}</div>
                      <div style={S.cardPrice}>₹{p._price.toLocaleString("en-IN")}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Shortlist */}
            <div style={S.sl}>
              <div style={S.slHdr}>
                <div style={S.slTitle}>SHORTLIST</div>
                <div style={S.slCount}>{hearted.size === 0 ? "EMPTY" : `${hearted.size} GIFT${hearted.size !== 1 ? "S" : ""}`}</div>
              </div>
              <div style={{ flex: 1, overflowY: "auto" }}>
                {hearted.size === 0 ? (
                  <div style={S.slEmpty}>HEART A GIFT<br />TO SAVE IT HERE.</div>
                ) : shortlistedItems.map(p => (
                  <div key={p.id} style={S.slRow}>
                    <div style={{ width: 46, height: 54, background: p._bg, flexShrink: 0, overflow: "hidden" }}>
                      {p.image_url && <img src={p.image_url} alt={p.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
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
                  <div style={S.slTotalVal}>{hearted.size === 0 ? "—" : `₹${totalEstimate.toLocaleString("en-IN")}`}</div>
                </div>
                <button
                  style={{ ...S.btnGreen, ...(hearted.size === 0 ? { opacity: 0.4, cursor: "not-allowed", boxShadow: "none" } : {}) }}
                  onClick={submitShortlist}
                  disabled={hearted.size === 0 || submitting}
                >
                  {submitting ? "SENDING…" : "SEND TO ROCK DOVE →"}
                </button>
                <div style={S.slNote}>WE FOLLOW UP WITHIN 24 HRS</div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const styles = {
  app: { background: "#fff", minHeight: "100vh", display: "flex", flexDirection: "column", fontFamily: "'Josefin Sans','Helvetica Neue',sans-serif", letterSpacing: "0.02em" },
  center: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", textAlign: "center", padding: 32, fontFamily: "'Josefin Sans','Helvetica Neue',sans-serif" },

  logoWrap: { display: "flex", alignItems: "baseline", gap: 5 },
  logoR: { fontSize: 15, fontWeight: 600, letterSpacing: 5, textTransform: "uppercase", color: "#1a1a1a" },
  logoD: { fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 21, fontStyle: "italic", color: "#2C5F3A", fontWeight: 500 },
  logoSub: { fontSize: 10, letterSpacing: "2px", textTransform: "uppercase", color: "#bbb", marginTop: 3, fontWeight: 300 },

  hdr: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 40px", height: 64, background: "#fff", borderBottom: "1px solid #e8e2d8", flexShrink: 0 },
  av: { width: 36, height: 36, borderRadius: "50%", background: "#7A90B0", fontSize: 12, fontWeight: 600, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" },
  cname: { fontSize: 12, fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", color: "#1a1a1a", lineHeight: 1.3 },
  cco: { fontSize: 11, fontWeight: 300, color: "#aaa" },
  backBtn: { background: "none", border: "none", fontSize: 11, fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", color: "#2C5F3A", cursor: "pointer", fontFamily: "'Josefin Sans','Helvetica Neue',sans-serif", marginRight: 8 },

  // Chat
  chatWrap: { flex: 1, display: "flex", flexDirection: "column", maxWidth: 680, width: "100%", margin: "0 auto", padding: "0 24px" },
  messages: { flex: 1, overflowY: "auto", padding: "40px 0 20px" },
  doveLabel: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 },
  doveDot: { width: 6, height: 6, borderRadius: "50%", background: "#2C5F3A" },
  doveLabel: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 9, fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", color: "#2C5F3A" },
  doveBubble: { background: "#f9f7f4", border: "1px solid #eeebe6", padding: "16px 20px", fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 17, color: "#333", lineHeight: 1.75, maxWidth: "85%", fontWeight: 400 },
  userBubble: { background: "#1a1a1a", padding: "14px 20px", fontSize: 14, color: "#fff", lineHeight: 1.65, maxWidth: "75%", fontWeight: 300, letterSpacing: "0.3px" },

  typingDots: { display: "flex", gap: 5, alignItems: "center" },

  chatInputWrap: { borderTop: "1px solid #eeebe6", padding: "20px 0 24px", flexShrink: 0 },
  viewResultsBtn: { width: "100%", background: "#2C5F3A", color: "#fff", border: "none", padding: "14px", fontFamily: "'Josefin Sans','Helvetica Neue',sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", cursor: "pointer", boxShadow: "0 5px 0 #a8d4b4", marginBottom: 14, display: "block" },
  chatInputRow: { display: "flex", gap: 12, alignItems: "stretch" },
  chatInput: { flex: 1, fontFamily: "'Josefin Sans','Helvetica Neue',sans-serif", fontSize: 14, fontWeight: 300, letterSpacing: "0.5px", color: "#1a1a1a", border: "none", borderBottom: "1.5px solid #1a1a1a", padding: "8px 0", outline: "none", background: "transparent" },
  sendBtn: { background: "#1a1a1a", color: "#fff", border: "none", padding: "0 22px", fontFamily: "'Josefin Sans','Helvetica Neue',sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", cursor: "pointer", boxShadow: "0 4px 0 #c8bfb0", flexShrink: 0 },

  // Results
  chipsRow: { padding: "10px 40px", display: "flex", gap: 6, flexWrap: "wrap", borderBottom: "1px solid #eeebe6", flexShrink: 0 },
  chip: { fontSize: 10, fontWeight: 600, letterSpacing: "1.5px", textTransform: "uppercase", color: "#2C5F3A", padding: "5px 12px", border: "1px solid #a8c8b4", background: "#eaf2ec" },
  chipMuted: { fontSize: 10, fontWeight: 600, letterSpacing: "1.5px", textTransform: "uppercase", color: "#bbb", padding: "5px 12px", border: "1px solid #eee", background: "#fafafa" },

  aiBar: { padding: "14px 40px", background: "#f9f7f4", borderBottom: "1px solid #eeebe6", display: "flex", gap: 14, alignItems: "center", flexShrink: 0 },
  aiDot: { width: 6, height: 6, borderRadius: "50%", background: "#2C5F3A", flexShrink: 0 },
  aiLbl: { fontSize: 9, fontWeight: 600, letterSpacing: "2.5px", textTransform: "uppercase", color: "#2C5F3A", flexShrink: 0 },
  aiTxt: { fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 16, fontStyle: "italic", color: "#555", fontWeight: 400 },
  aiQ: { color: "#2C5F3A", cursor: "pointer", borderBottom: "1px solid #2C5F3A", paddingBottom: 1 },

  body: { display: "flex", flex: 1, overflow: "hidden" },
  gridWrap: { flex: 1, padding: "28px 40px", overflowY: "auto" },
  meta: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 },
  cnt: { fontSize: 11, fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", color: "#aaa" },
  sortBtn: { fontSize: 11, fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", color: "#bbb", background: "none", border: "none", cursor: "pointer", fontFamily: "'Josefin Sans','Helvetica Neue',sans-serif", padding: "5px 12px" },
  sortOn: { color: "#1a1a1a", borderBottom: "1.5px solid #1a1a1a" },

  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "28px 16px" },
  card: { cursor: "pointer" },
  cardImg: { width: "100%", paddingBottom: "116%", position: "relative", overflow: "hidden" },
  hbtn: { position: "absolute", top: 10, right: 10, width: 30, height: 30, background: "rgba(255,255,255,0.92)", border: "none", fontSize: 14, color: "#ccc", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  hbtnOn: { color: "#9B3A2A" },
  tier: { fontSize: 9, fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", display: "inline-block", padding: "3px 8px" },
  tierGold: { color: "#7a5c20", background: "#fdf5e6", border: "1px solid #e8d5a0" },
  tierPlat: { color: "#2a4a7a", background: "#eef3fa", border: "1px solid #b8cce8" },
  tierSilv: { color: "#666", background: "#f5f5f5", border: "1px solid #e0e0e0" },
  cardName: { fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 17, fontWeight: 500, color: "#1a1a1a", marginTop: 8, lineHeight: 1.3 },
  cardCat: { fontSize: 11, fontWeight: 300, letterSpacing: "1.5px", textTransform: "uppercase", color: "#bbb", marginTop: 4 },
  cardPrice: { fontSize: 14, fontWeight: 600, letterSpacing: "0.5px", color: "#1a1a1a", marginTop: 10 },

  sl: { width: 248, background: "#fff", borderLeft: "1px solid #e8e2d8", display: "flex", flexDirection: "column", flexShrink: 0 },
  slHdr: { padding: "22px 20px 16px", borderBottom: "1px solid #eeebe6", display: "flex", alignItems: "baseline", justifyContent: "space-between", flexShrink: 0 },
  slTitle: { fontSize: 11, fontWeight: 600, letterSpacing: "2.5px", textTransform: "uppercase", color: "#1a1a1a" },
  slCount: { fontSize: 11, fontWeight: 400, letterSpacing: "1px", textTransform: "uppercase", color: "#bbb" },
  slEmpty: { padding: "40px 20px", fontSize: 11, letterSpacing: "2px", textTransform: "uppercase", color: "#ccc", fontWeight: 400, lineHeight: 1.8, textAlign: "center" },
  slRow: { display: "flex", alignItems: "center", gap: 12, padding: "14px 20px", borderBottom: "1px solid #f5f0e8" },
  slName: { fontSize: 12, fontWeight: 600, color: "#1a1a1a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 4 },
  slPrice: { fontSize: 12, fontWeight: 300, color: "#888" },
  slRm: { background: "none", border: "none", color: "#ccc", cursor: "pointer", fontSize: 20, padding: 0, lineHeight: 1, flexShrink: 0 },
  slFooter: { padding: 20, borderTop: "1px solid #eeebe6", flexShrink: 0 },
  slTotalRow: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 20, paddingBottom: 16, borderBottom: "1px solid #f0ece4" },
  slTotalLbl: { fontSize: 10, fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", color: "#aaa" },
  slTotalVal: { fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 24, fontWeight: 500, color: "#1a1a1a" },
  slNote: { fontSize: 10, fontWeight: 600, letterSpacing: "1.5px", textTransform: "uppercase", color: "#ccc", textAlign: "center", marginTop: 12 },
  btnGreen: { width: "100%", background: "#2C5F3A", color: "#fff", border: "none", padding: 15, fontFamily: "'Josefin Sans','Helvetica Neue',sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", cursor: "pointer", boxShadow: "0 5px 0 #a8d4b4", display: "block" },
};
