import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase.js";
import SubmissionSummary from "./SubmissionSummary.jsx";
import { createConversationState, parseUserMessage, mergeModelFilters, toCandidateFilters, migrateState, activeBrief, isEmptySeed } from "./conversation_state.js";
import { buildCandidates, findNamedMatches } from "./candidate_filter.js";

const CATALOGUE_URL = import.meta.env.VITE_CATALOGUE_SERVICE_URL ||
  "https://ikka-catalogue-service-production.up.railway.app";

const DOVE_BLUE = "#6B8CAE";
const DARK = "#111111";

// ── Rock Dove "Evergreen" skin (from Claude Design export) ────────────────────
const RD = {
  paper: "#f9f4ea", ink: "#1b3d2e", inkSoft: "#444444", inkMute: "#6b6b6b",
  line: "#e7e7e4", surface: "#ffffff", wordmark: "#8FB9E0",
  accent: "#4e9d6c",      // Dove identity
  secondary: "#2e6fcb",   // client identity
  bubble: "#fbfaf6", bubbleLine: "#e8e3d4",
  serif: "'Source Serif 4', Georgia, serif",
  sans: "'Nunito', sans-serif",
};
// per-card tint, rotated by position in the shown set
const RD_PIECE = ["#2e6fcb", "#4e9d6c", "#6f9fd8"];
const RD_PIECE_SOFT = ["#d4e1f3", "#d6e6dc", "#dde8f4"];
// load Nunito + Source Serif 4 once
if (typeof document !== "undefined" && !document.getElementById("rd-fonts")) {
  const l = document.createElement("link");
  l.id = "rd-fonts"; l.rel = "stylesheet";
  l.href = "https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600&display=swap";
  document.head.appendChild(l);
}
// responsive header: as the viewport narrows, drop the subtitle, then the decor, so the
// sticky header never overflows on phones (full decorated header on desktop/tablet)
if (typeof document !== "undefined" && !document.getElementById("rd-skin-css")) {
  const st = document.createElement("style");
  st.id = "rd-skin-css";
  st.textContent = "@media (max-width:720px){.rd-sub{display:none!important}}@media (max-width:560px){.rd-decor-h{display:none!important}}@media (max-width:600px){.rd-scroll{padding-left:16px!important;padding-right:16px!important}.rd-inputwrap{padding-left:16px!important;padding-right:16px!important}.rd-msg{font-size:19px!important;line-height:1.65!important}.rd-cards{grid-template-columns:repeat(2,minmax(0,1fr))!important;margin-left:0!important;gap:8px!important}.rd-card-img{padding-bottom:115%!important}.rd-card-name{font-size:14px!important;line-height:1.25!important}.rd-card-price{font-size:15px!important}.rd-chip{font-size:13px!important}.rd-input{font-size:16px!important}.rd-you{font-size:16px!important}.rd-card-foot{flex-direction:column!important;align-items:stretch!important;gap:8px!important}.rd-card-foot button{width:100%!important;text-align:center!important}}";
  document.head.appendChild(st);
}

// Debug overlay: only when the URL carries ?debug=1. Never shows for real clients.
const DEBUG_MODE = (() => {
  try { return new URLSearchParams(window.location.search).get("debug") === "1"; }
  catch { return false; }
})();
const BG_COLORS = ["#F5EFE8","#EDF2EE","#EEF0F7","#F7EEF0","#F0EDE8","#EEF5F2","#F5F0E8","#EEF1F7","#F2EEF5"];

// ── Helpers ────────────────────────────────────────────────────

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function priceAtQty(tiers, qty) {
  if (!tiers?.length) return 0;
  try {
    const match = tiers.filter(t => qty >= t.min_qty && (t.max_qty===null||qty<=t.max_qty)).sort((a,b)=>b.min_qty-a.min_qty)[0];
    if (match) return parseFloat(match.price_per_unit);
    // No tier covers this qty (e.g. qty 1 against a catalogue whose tiers start
    // at 25). Fall back to the SMALLEST-quantity tier — deterministically —
    // instead of tiers[0], which depends on database row order and made the
    // same product show different prices on different turns.
    const smallest = tiers.slice().sort((a,b)=>a.min_qty-b.min_qty)[0];
    return parseFloat(smallest.price_per_unit);
  } catch { return 0; }
}

function initials(name) { return name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase(); }

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

// ── DOVE CHAT VIEW — conversational flow over /dove-converse (the only view) ──

// ── Matisse cut-out decor flourish (Rock Dove brand shapes) ──────────────────
function RockDoveDecor({ compact = false }) {
  const k = compact ? 0.66 : 1;
  const w = (n) => Math.round(n * k);
  const s = { flexShrink: 0, height: "auto" };
  return (
    <div aria-hidden="true" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: compact ? 13 : 20, flexWrap: compact ? "nowrap" : "wrap", marginBottom: 0 }}>
      {/* crescent — green */}
      <svg viewBox="0 0 64 68" style={{ ...s, width: w(26) }}><path d="M40 4 a30 30 0 1 0 0 60 a23 30 0 1 1 0 -60 z" fill="#2f9e6f" /></svg>
      {/* 4-point star — gold */}
      <svg viewBox="0 0 40 40" style={{ ...s, width: w(22) }}><path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" fill="#d9a23c" /></svg>
      {/* almond leaf — magenta */}
      <svg viewBox="0 0 60 60" style={{ ...s, width: w(22) }}><path d="M30 2 C 50 16, 50 44, 30 58 C 10 44, 10 16, 30 2 Z" fill="#c84a7d" /></svg>
      {/* pomegranate — red */}
      <svg viewBox="0 0 60 66" style={{ ...s, width: w(24) }}><path d="M30 16 L24 4 L30 9 L36 4 Z" fill="#d93a2b" /><path d="M30 14 C 47 14, 56 28, 56 40 C 56 54, 44 62, 30 62 C 16 62, 4 54, 4 40 C 4 28, 13 14, 30 14 Z" fill="#d93a2b" /></svg>
      {/* half-circle bowl — periwinkle */}
      <svg viewBox="0 0 64 34" style={{ ...s, width: w(34) }}><path d="M2 4 A 30 30 0 0 0 62 4 Z" fill="#7b7fd0" /></svg>
      {/* 5-point star — teal */}
      <svg viewBox="0 0 60 58" style={{ ...s, width: w(22) }}><path d="M30 2 L37 22 L58 22 L41 35 L47 56 L30 43 L13 56 L19 35 L2 22 L23 22 Z" fill="#1b6b6b" /></svg>
      {/* swallow — cobalt line */}
      <svg viewBox="0 0 100 36" style={{ ...s, width: w(48) }}><path d="M2 24 Q 24 2 44 22 Q 50 28 56 22 Q 76 2 98 24" fill="none" stroke="#2e6fcb" strokeWidth="4" strokeLinecap="round" /></svg>
    </div>
  );
}

function ChatView({ session, productsRef, hearted, toggleHeart, submitShortlist, submitting, setHeadcount, activeBriefIdRef }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState(null);  // gift-detail drawer
  const stateRef = useRef(null);
  if (stateRef.current === null) stateRef.current = createConversationState();
  // Mirror the active brief id up to App so shortlist events (logged at App
  // level) carry the right brief_id. Called after every state mutation.
  const syncBriefId = () => { if (activeBriefIdRef) activeBriefIdRef.current = activeBrief(stateRef.current)?.id ?? null; };
  const historyRef = useRef([]);
  const scrollRef = useRef(null);
  const startedRef = useRef(false);
  const memoryRef = useRef(null);   // session-scoped client memory, sent on every /dove-converse turn
  const stickyRef = useRef(new Map());  // productId -> turns remaining; keeps a named/shown piece in candidates across follow-ups
  const STORAGE_KEY = `rd_chat_${session?.token || session?.id || "anon"}`;

  // Persist the in-progress chat so a refresh / return-on-same-device restores it.
  const persist = (msgs) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        v: 1,
        messages: msgs,
        state: stateRef.current,
        history: historyRef.current,
        memory: memoryRef.current,
        savedAt: Date.now(),
      }));
    } catch { /* storage unavailable - ignore */ }
  };
  const loadPersisted = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      // expire after 7 days so it doesn't resurface a stale chat much later
      if (!data || !Array.isArray(data.messages) || (Date.now() - (data.savedAt || 0)) > 7 * 864e5) return null;
      return data;
    } catch { return null; }
  };

  useEffect(() => {
    if (startedRef.current || !session) return;
    startedRef.current = true;
    const name = (session?.client_name || "").split(" ")[0] || "there";
    const firstTimeChips = ["50 for Diwali, ~Rs.2,500 each", "One premium client gift", "New-joiner welcome kits"];
    const firstTimeGreeting = {
      role: "dove",
      text: `${getGreeting()}, ${name}. Tell me who these gifts are for and roughly your budget per gift — I'll pull a few options together.`,
      chips: firstTimeChips,
    };

    // 1) Restore an in-progress chat from this device — but ONLY if it holds a REAL
    // exchange (at least one user turn). A lone opening greeting must not be restored:
    // persist() runs on every message change, so a device that merely showed a greeting
    // once would cache it and, on return, restore it and skip the memory fetch below
    // forever — the cross-device "it forgot my laptop chat" bug. With this guard, any
    // device with no real local conversation falls through to /dove-memory and greets
    // from this client's server-side history instead.
    const saved = loadPersisted();
    if (saved && Array.isArray(saved.messages) && saved.messages.some(m => m.role === "user")) {
      if (saved.state) stateRef.current = migrateState(saved.state);
      syncBriefId();
      if (Array.isArray(saved.history)) historyRef.current = saved.history;
      if (saved.memory) memoryRef.current = saved.memory;
      setMessages(saved.messages);
      if (stateRef.current.headcount) setHeadcount(stateRef.current.headcount);
      return;
    }

    // 2) No live chat -> ask the backend for this session's past history (memory).
    (async () => {
      try {
        const res = await fetch(CATALOGUE_URL + "/dove-memory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: session.id }),
        });
        if (res.ok) {
          const mem = await res.json();
          if (mem && mem.returning && mem.greeting) {
            // Keep the structured summary so every later turn can reference it.
            memoryRef.current = mem.summary || null;
            historyRef.current = [{ role: "assistant", content: mem.greeting }];
            setMessages([{
              role: "dove",
              text: mem.greeting,
              chips: ["Repeat last time", "Start something new", "Show me what I shortlisted"],
            }]);
            return;
          }
        }
      } catch { /* fall through to first-time greeting */ }
      // 3) First-time (or memory unavailable) -> normal opener.
      setMessages([firstTimeGreeting]);
    })();
  }, [session]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  // Persist on every message change (after the opener has been set).
  useEffect(() => {
    if (startedRef.current && messages.length > 0) persist(messages);
  }, [messages]);

  const productById = (id) => (productsRef.current || []).find(p => p.id === id);
  const qtyNow = stateRef.current?.headcount || 1;

  const send = async (textArg) => {
    const text = (textArg ?? input).trim();
    if (!text || loading) return;
    setInput("");
    setMessages(prev => [...prev, { role: "user", text }]);
    setLoading(true);

    stateRef.current = parseUserMessage(stateRef.current, text) || stateRef.current;
    syncBriefId();

    // ── Clarify turn: answered deterministically, no model call ─────────────
    // The router held this message because more than one brief is open and the
    // text didn't say which it belongs to. Which-brief is conversation
    // STRUCTURE — the app's job, never the model's — so ask the question
    // directly, offer the open briefs as tappable chips, and show no cards
    // (cards priced off the wrong brief's budget look broken). The held
    // message is stashed in state and is applied to whichever brief the
    // client picks on the next turn.
    if (stateRef.current.pending_clarify && stateRef.current.pending_text) {
      const liveLabels = Object.values(stateRef.current.briefs || {})
        .filter(b => b.status !== "resolved")
        .map(b => b.label || "Untitled brief");
      setMessages(prev => [...prev, {
        role: "dove",
        text: liveLabels.length === 2
          ? `Of course — should that apply to ${liveLabels[0]}, or to ${liveLabels[1]}? Tap one and I'll take it from there.`
          : `Of course — which of these should that apply to: ${liveLabels.join(", ")}? Tap one and I'll take it from there.`,
        chips: liveLabels,
      }]);
      setLoading(false);
      return;
    }

    // Captured BEFORE the backend call: the model's merged filters can plant
    // numbers into this brief mid-turn, so emptiness must be judged at send time.
    const wasEmptySeedAtSend = isEmptySeed(activeBrief(stateRef.current));
    const filters = toCandidateFilters(stateRef.current);
    const qty = stateRef.current.headcount || 1;

    const all = (productsRef.current || []).map(p => {
      const tags = [...(p._tags || [])];
      if (p.edible) tags.push("edible");
      if (p.fragile) tags.push("fragile");
      return {
        id: p.id,
        name: p.name || "",
        price: priceAtQty(p.pricing_tiers, qty),
        weight_g: p.weight_grams || 0,
        tags,
        maker: p.brand || "",
        short_desc: p.description || "",
        whats_in_box: Array.isArray(p.whats_in_box) ? p.whats_in_box : (p.whats_in_box ? [p.whats_in_box] : []),
        tiers: (p.pricing_tiers || [])
          .map(t => ({ min: t.min_qty, max: t.max_qty, unit: parseFloat(t.price_per_unit) }))
          .sort((a, b) => a.min - b.min),
        shortlisted: hearted.has(p.id),
      };
    });
    // Products the client names THIS turn (tracked so they stay sticky next turn).
    const namedNow = findNamedMatches(all, text).map(p => p.id);
    // Sticky ids carried from earlier turns, PLUS everything this client has saved —
    // so their shortlist is always showable (e.g. "show me what I saved" returns all
    // of them, not just whichever happened to match the current brief filter).
    const stickyIds = [...new Set([...stickyRef.current.keys(), ...hearted])];
    const candidates = buildCandidates(all, filters, 100, text, stickyIds);

    historyRef.current = [...historyRef.current, { role: "user", content: text }];

    try {
      const res = await fetch(CATALOGUE_URL + "/dove-converse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: session.id, history: historyRef.current, candidates, memory: memoryRef.current || "", brief: (() => {
          const ab = activeBrief(stateRef.current);
          if (!ab) return null;
          const b = ab.business || {}, bud = b.budget || {};
          // Phase 1 (rd_briefs): id is the server-side upsert key — without it the
          // backend skips persistence entirely. The extra fields complete the row.
          return { id: ab.id, type: ab.type, label: ab.label, status: ab.status,
                   headcount: (typeof b.headcount === "number" ? b.headcount : null),
                   budget_ceiling: (typeof bud.ceiling === "number" ? bud.ceiling : null),
                   budget_floor: (typeof bud.floor === "number" ? bud.floor : null),
                   budget_per: bud.per || "head", budget_open: !!bud.open,
                   exclude_edible: !!b.exclude_edible, exclude_fragile: !!b.exclude_fragile,
                   lightweight: !!b.lightweight, lean: b.lean || "balanced" };
        })() }),
      });
      if (!res.ok) throw new Error("status " + res.status);
      const data = await res.json();
      stateRef.current = mergeModelFilters(stateRef.current, data.filters || {}, text) || stateRef.current;
      syncBriefId();
      if (stateRef.current.headcount) setHeadcount(stateRef.current.headcount);
      const msg = (data.message || "").trim() || "Tell me a little more — who are these for?";
      historyRef.current = [...historyRef.current, { role: "assistant", content: msg }];

      // ── What the client actually sees as cards ──────────────────────────
      // Dove proposes pieces via show_products, but it sometimes returns none — or
      // only a couple — while still describing a range in words. The client must
      // always see options, so the app guarantees them: at least 6 pieces, and the
      // WHOLE matching set when they ask for "all". Two rules hold throughout:
      //   • never auto-show a piece ABOVE budget. The candidate pool deliberately
      //     reserves a few premium (over-ceiling) pieces for the model to upsell;
      //     the deterministic display filters those out. The ONLY over-budget pieces
      //     allowed through are ones the client saved or named themselves.
      //   • "show all" means everything matching the brief — not just the 100 sent
      //     to the model — so it's rebuilt with no cap.
      const ceilingNum = (typeof filters.budget_ceiling === "number" && filters.budget_ceiling > 0) ? filters.budget_ceiling : null;
      const floorNum = (typeof filters.budget_floor === "number" && filters.budget_floor > 0) ? filters.budget_floor : null;
      const perTotal = filters.budget_per === "total";
      const effPrice = c => (perTotal ? (c.price || 0) * qty : (c.price || 0));
      const chosen = new Set([...namedNow, ...hearted]);          // saved or named — allowed outside budget
      const withinBudget = c => chosen.has(c.id) || ((!ceilingNum || effPrice(c) <= ceilingNum) && (!floorNum || effPrice(c) >= floorNum));

      const wantsAll = /\b(?:everything|every (?:option|piece|gift)|full (?:catalogue|catalog|range|list|selection)|whole (?:catalogue|catalog|range|list|selection)|entire (?:catalogue|catalog|range|selection))\b/i.test(text)
        || /\b(?:show|see|send|share|view|list|browse|give me|pull up)\b[^.?!]*\ball\b/i.test(text)
        || /\ball\b[^.?!]*\b(?:options|gifts|pieces|products|items|catalogue|catalog)\b/i.test(text);

      // For "show all", rebuild the matching set uncapped so nothing is left out.
      const pool = wantsAll ? buildCandidates(all, filters, 100000, text, stickyIds) : candidates;
      const poolOkIds = pool.filter(withinBudget).map(c => c.id);   // within budget (or saved/named)

      const modelShown = (Array.isArray(data.show_products) ? data.show_products : [])
        .filter(id => poolOkIds.includes(id));         // model's picks, minus anything over budget
      const wantsBrowse = /\b(?:show|see|view|browse|display|suggest|recommend|options?|ideas?|pieces|catalogue|catalog)\b/i.test(text);
      let shownIds;
      if (wantsAll) {
        shownIds = poolOkIds;                          // everything matching the brief, uncapped
      } else {
        shownIds = [...modelShown];
        // Top up to 6 ONLY when there is something to anchor the cards to:
        // Dove actually recommended pieces this turn, or the client asked to
        // browse. When Dove is only asking a question (show_products empty),
        // filling the reply with six pool-ranked pieces makes every question
        // turn show the SAME six cards priced off whatever brief happens to be
        // active — silence is better than a shopping list nobody asked for.
        if (modelShown.length > 0 || wantsBrowse) {
          for (const id of poolOkIds) {                // top up to a minimum of 6, within budget
            if (shownIds.length >= 6) break;
            if (!shownIds.includes(id)) shownIds.push(id);
          }
        }
      }

      // On a brand-new EMPTY brief (a divergence like "I also need another
      // gift"), Dove is asking discovery questions — filling the reply with six
      // generic pieces priced against no budget only distracts. On an empty
      // brief, show cards only when the client actually asked to browse; once
      // the brief has any substance, the at-least-6 guarantee applies as before.
      if (wasEmptySeedAtSend && !wantsBrowse && !wantsAll) shownIds = [];

      // When Dove REFUSES an off-topic ask (backend sets off_topic), show no
      // cards at all — a refusal with a shopping list under it reads wrong.
      // Without this, the at-least-6 top-up above would re-attach the previous
      // turn's pieces to the refusal.
      if (data.off_topic) shownIds = [];

      // Debug snapshot (only assembled when ?debug=1): exactly what was sent to the
      // model this turn and what it returned — collapses the screenshot→SQL loop.
      const debugInfo = DEBUG_MODE ? {
        sent: {
          headcount: qty,
          budget: filters.budget_ceiling ?? null,
          floor: filters.budget_floor ?? null,
          premium: !!filters.premium_requested,
          excludeEdible: !!filters.exclude_edible,
          excludeFragile: !!filters.exclude_fragile,
          lightweight: !!filters.lightweight,
          lean: filters.lean || null,
          per: filters.budget_per || "head",
          brief: (() => { const ab = activeBrief(stateRef.current); return ab ? { count: Object.keys(stateRef.current.briefs || {}).length, type: ab.type, label: ab.label, status: ab.status } : null; })(),
          memory: !!memoryRef.current,
          candidateCount: candidates.length,
          candidates: candidates.map(c => ({ id: c.id, name: c.name, price: c.price, saved: !!c.shortlisted })),
        },
        got: {
          show_products: shownIds,
          modelReturned: Array.isArray(data.show_products) ? data.show_products : [],
          modelFilters: data.filters || {},
        },
      } : null;

      setMessages(prev => [...prev, {
        role: "dove",
        text: msg,
        products: shownIds,
        chips: Array.isArray(data.follow_up_chips) ? data.follow_up_chips : [],
        debug: debugInfo,
      }]);

      // Record what was actually DISPLAYED this turn. The final card set is
      // decided here in the browser (Dove's picks + the top-up), so only the
      // browser can log it. This is the "shown" half of shown→saved→chosen —
      // without it there's nothing to learn "shown often, never saved" from.
      // Fire-and-forget, same pattern as rd_shortlists above.
      if (shownIds.length > 0) {
        try {
          supabase.from("rd_events").insert([{
            session_id: session.id,
            event_type: "products_shown",
            product_id: null,
            // brief_id links the funnel to the brief: "shown at what budget, for
            // which gift?" is unanswerable without it once a session has several.
            metadata: { product_ids: shownIds, count: shownIds.length,
                        brief_id: activeBrief(stateRef.current)?.id ?? null },
          }]).then(() => {});
        } catch {}
      }

      // ── Retrieval stickiness ───────────────────────────────────────────
      // Age every sticky entry by one turn (drop the expired), then (re)arm the
      // pieces named this turn or shown in this reply. So a product the client
      // just discussed survives the next few context-light turns ("yes", "and
      // the price?") instead of falling out of candidates and being forgotten.
      const STICKY_TURNS = 3;
      const shownNow = shownIds;
      // Pieces Dove NAMES in this reply — bold OR plain prose — resolved to real
      // catalogue ids. A product Dove discusses by name (from memory, history, or a
      // prose mention) has no id of its own; pinning it here keeps it in candidates so
      // the next turn ("and the price?", "for 100 units?") can price or show it instead
      // of Dove contradicting itself with "it's not in front of me." findNamedMatches is
      // conservative (needs most of a distinctive name to survive), so general prose
      // pins nothing — only actual product names Dove used get armed.
      const doveNamedIds = findNamedMatches(all, msg).map(p => p.id);
      const freshIds = [...new Set([...namedNow, ...shownNow, ...doveNamedIds])];
      const nextSticky = new Map();
      for (const [id, ttl] of stickyRef.current.entries()) {
        if (ttl - 1 > 0) nextSticky.set(id, ttl - 1);
      }
      for (const id of freshIds) nextSticky.set(id, STICKY_TURNS);
      stickyRef.current = nextSticky;
    } catch (e) {
      setMessages(prev => [...prev, { role: "dove", text: "I'm just waking up — give me a moment and try that again.", chips: [] }]);
    }
    setLoading(false);
  };

  let lastDoveIdx = -1;
  messages.forEach((m, i) => { if (m.role === "dove") lastDoveIdx = i; });

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: RD.paper, color: RD.ink, fontFamily: RD.sans }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "0 28px", height: 64, borderBottom: `1px solid ${RD.line}`, flexShrink: 0, background: RD.paper }}>
        <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "0.2em", color: RD.wordmark }}>ROCK DOVE</span>
        <div style={{ width: 1, height: 22, background: RD.line }} />
        <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", color: RD.inkMute }} className="rd-sub">Private Concierge&nbsp;&nbsp;&middot;&nbsp;&nbsp;{session.company || "Rock Dove"}</span>
        <div className="rd-decor-h" style={{ marginLeft: "auto" }}><RockDoveDecor compact /></div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
          {hearted.size > 0 && (
            <button onClick={submitShortlist} disabled={submitting}
              style={{ background: RD.accent, color: "#fff", border: "none", padding: "12px 22px", borderRadius: 999, fontFamily: RD.sans, fontSize: 12.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer" }}>
              {submitting ? "Sending..." : `\u2665 ${hearted.size} \u00b7 Send to Rock Dove`}
            </button>
          )}
          <div style={{ width: 34, height: 34, borderRadius: "50%", background: RD.secondary, fontSize: 12, fontWeight: 600, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{initials(session.client_name)}</div>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "40px 0 32px" }}>
        <div className="rd-scroll" style={{ maxWidth: 760, margin: "0 auto", padding: "0 28px", display: "flex", flexDirection: "column", gap: 40 }}>
          {messages.map((m, i) => (
            <div key={i}>
              {m.role === "dove" ? (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 14 }}>
                    <span style={{ width: 30, height: 30, flexShrink: 0, borderRadius: 999, background: RD.accent, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2.5 }}>
                      <span style={{ width: 7, height: 7, borderRadius: 999, background: "#fff" }} />
                      <span style={{ width: 5, height: 5, borderRadius: 999, background: "#fff" }} />
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.16em", textTransform: "uppercase", color: RD.accent }}>Dove&nbsp;&nbsp;&middot;&nbsp;&nbsp;Concierge</span>
                  </div>
                  <div className="rd-msg" style={{ fontFamily: RD.serif, fontSize: 17, fontWeight: 400, lineHeight: 1.6, color: RD.ink, maxWidth: 640, paddingLeft: 41, whiteSpace: "pre-wrap" }}>{m.text}</div>
                </div>
              ) : (
                <div style={{ marginLeft: "auto", maxWidth: 500, display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.16em", textTransform: "uppercase", color: RD.secondary }}>{(session.client_name || "You").split(" ")[0]}&nbsp;&nbsp;&middot;&nbsp;&nbsp;You</span>
                    <span style={{ width: 26, height: 26, flexShrink: 0, borderRadius: 999, background: RD.secondary }} />
                  </div>
                  <div className="rd-you" style={{ background: RD.bubble, border: `1px solid ${RD.bubbleLine}`, borderRight: `3px solid ${RD.secondary}`, borderRadius: 14, padding: "15px 19px", fontSize: 15, fontWeight: 500, lineHeight: 1.56, color: RD.ink, whiteSpace: "pre-wrap" }}>{m.text}</div>
                </div>
              )}

              {m.role === "dove" && m.products && m.products.length > 0 && (
                <div className="rd-cards" style={{ marginLeft: 41, marginTop: 24, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 14 }}>
                  {m.products.map((pid, ci) => {
                    const p = productById(pid);
                    if (!p) return null;
                    const price = priceAtQty(p.pricing_tiers, qtyNow);
                    const isH = hearted.has(p.id);
                    const tint = RD_PIECE[ci % 3], tintSoft = RD_PIECE_SOFT[ci % 3];
                    return (
                      <div key={pid} style={{ border: `1px solid ${RD.line}`, background: RD.surface, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                        <div className="rd-card-img" onClick={() => setDetail(p)} style={{ position: "relative", cursor: "pointer", width: "100%", paddingBottom: "100%", background: tintSoft }}>
                          {p.image_url && <img src={p.image_url} alt={p.name || ""} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />}
                          {p.tier && <span style={{ position: "absolute", top: 12, left: 12, fontSize: 10, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", color: "#fff", background: tint, padding: "5px 9px" }}>{p.tier}</span>}
                        </div>
                        <div style={{ padding: "16px 16px 18px", display: "flex", flexDirection: "column", flex: 1, borderTop: `1px solid ${RD.line}` }}>
                          <div className="rd-card-name" onClick={() => setDetail(p)} style={{ fontFamily: RD.serif, fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em", lineHeight: 1.18, cursor: "pointer", color: RD.ink }}>{p.name}</div>
                          
                          <div style={{ flex: 1, minHeight: 14 }} />
                          <div className="rd-card-foot" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 14, paddingTop: 14, borderTop: `1px solid ${RD.line}` }}>
                            <span className="rd-card-price" style={{ fontSize: 16, fontWeight: 600, whiteSpace: "nowrap", color: RD.ink }}>Rs.{price.toLocaleString("en-IN")}</span>
                            <button onClick={() => toggleHeart({ ...p, _price: price })}
                              style={{ border: isH ? `1px solid ${tint}` : `1px solid ${RD.ink}`, background: isH ? tint : "transparent", color: isH ? "#fff" : RD.ink, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", padding: "8px 13px", borderRadius: 999, cursor: "pointer" }}>
                              {isH ? "\u2713 Saved" : "\u2661 Save"}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {DEBUG_MODE && m.role === "dove" && m.debug && (
                <details style={{ marginLeft: 38, marginTop: 10, fontSize: 11, fontFamily: "ui-monospace,Menlo,monospace", color: "#555", background: "#FAFAF8", border: "1px solid #E5E2DC", borderRadius: 4, padding: "6px 10px" }}>
                  <summary style={{ cursor: "pointer", color: "#999", userSelect: "none" }}>
                    debug · sent {m.debug.sent.candidateCount} candidates · showed {m.debug.got.show_products.length}
                  </summary>
                  <div style={{ marginTop: 6, lineHeight: 1.55 }}>
                    <div><b>filters used →</b> headcount {String(m.debug.sent.headcount)} · budget {m.debug.sent.budget == null ? "—" : "₹" + Number(m.debug.sent.budget).toLocaleString("en-IN")} · floor {m.debug.sent.floor == null ? "—" : "₹" + Number(m.debug.sent.floor).toLocaleString("en-IN")} · premium {String(m.debug.sent.premium)} · excl.edible {String(m.debug.sent.excludeEdible)} · excl.fragile {String(m.debug.sent.excludeFragile)} · light {String(m.debug.sent.lightweight)} · lean {m.debug.sent.lean || "—"} · memory {String(m.debug.sent.memory)}</div>
                    <div style={{ marginTop: 4 }}><b>brief →</b> {m.debug.sent.brief ? `${m.debug.sent.brief.count} brief(s) · active = ${m.debug.sent.brief.type} / “${m.debug.sent.brief.label}” (${m.debug.sent.brief.status}) · per ${m.debug.sent.per}` : "—"}</div>
                    <div style={{ marginTop: 4 }}><b>model returned filters →</b> {JSON.stringify(m.debug.got.modelFilters)}</div>
                    <div style={{ marginTop: 4 }}><b>show_products →</b> [{m.debug.got.show_products.join(", ") || "none"}]</div>
                    <div style={{ marginTop: 4 }}><b>model returned →</b> [{(m.debug.got.modelReturned || []).join(", ") || "none"}]</div>
                    <div style={{ marginTop: 6 }}><b>candidates sent ({m.debug.sent.candidateCount}) — ♥ saved, maroon = shown →</b></div>
                    <div style={{ maxHeight: 220, overflowY: "auto", marginTop: 2, whiteSpace: "pre" }}>
                      {m.debug.sent.candidates.map(c => (
                        <div key={c.id} style={{ color: m.debug.got.show_products.includes(c.id) ? "#9B3A2A" : "#666" }}>
                          {(c.saved ? "\u2665 " : "  ") + "#" + c.id + " · " + c.name + " · ₹" + Number(c.price).toLocaleString("en-IN")}
                        </div>
                      ))}
                    </div>
                  </div>
                </details>
              )}

              {m.role === "dove" && i === lastDoveIdx && m.chips && m.chips.length > 0 && !loading && (
                <div style={{ marginLeft: 41, marginTop: 14, display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {m.chips.map((c, ci) => (
                    <button key={ci} className="rd-chip" onClick={() => send(c)}
                      style={{ fontFamily: RD.sans, fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", color: RD.inkSoft, background: RD.surface, border: `1px solid ${RD.line}`, padding: "8px 14px", cursor: "pointer" }}>
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div>
              {/* Keyframes injected here so the indicator never depends on an
                  external stylesheet — the "td" class alone rendered 0×0
                  invisible spans, which is why the pause looked like a hang. */}
              <style>{`@keyframes doveThinking { 0%, 80%, 100% { opacity: 0.25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-3px); } }`}</style>
              <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 14 }}>
                <span style={{ width: 30, height: 30, flexShrink: 0, borderRadius: 999, background: RD.accent, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2.5 }}>
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: "#fff" }} />
                  <span style={{ width: 5, height: 5, borderRadius: 999, background: "#fff" }} />
                </span>
                <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.16em", textTransform: "uppercase", color: RD.accent }}>Dove&nbsp;&nbsp;&middot;&nbsp;&nbsp;Concierge</span>
              </div>
              <div style={{ paddingLeft: 41, display: "flex", alignItems: "center", gap: 6 }}>
                {[0, 1, 2].map(d => (
                  <span key={d} style={{ width: 7, height: 7, borderRadius: "50%", background: RD.accent, display: "inline-block", animation: "doveThinking 1.2s ease-in-out infinite", animationDelay: `${d * 0.2}s` }}></span>
                ))}
                <span style={{ marginLeft: 8, fontFamily: "'PT Serif',Georgia,serif", fontStyle: "italic", fontSize: 14, color: RD.accent, opacity: 0.8 }}>finding the right pieces&hellip;</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Input */}
      <div style={{ borderTop: `1px solid ${RD.line}`, background: RD.paper, flexShrink: 0 }}>
        <div className="rd-inputwrap" style={{ maxWidth: 760, margin: "0 auto", padding: "16px 28px" }}>
          <div style={{ display: "flex", border: `1.5px solid ${RD.ink}`, background: RD.surface, borderRadius: 14, overflow: "hidden" }}>
            <input
              className="rd-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); send(); } }}
              placeholder="Tell Dove about the occasion, the headcount, the budget per head…"
              style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontFamily: RD.sans, fontSize: 15, fontWeight: 400, color: RD.ink, padding: "16px 20px" }}
            />
            <button onClick={() => send()} disabled={loading}
              style={{ width: 54, flexShrink: 0, border: "none", background: RD.secondary, color: "#fff", fontSize: 20, cursor: "pointer" }}>&rarr;</button>
          </div>
        </div>
      </div>

      {/* Gift-detail drawer */}
      {detail && <ProductDetail product={detail} qty={qtyNow} hearted={hearted} toggleHeart={toggleHeart} onClose={() => setDetail(null)} />}
    </div>
  );
}

// ── Gift-detail drawer (provenance preview) — real catalogue fields only ──────
function ProductDetail({ product: p, qty, hearted, toggleHeart, onClose }) {
  const isH = hearted.has(p.id);
  const perHead = priceAtQty(p.pricing_tiers, qty);
  const total = perHead * (qty || 1);
  const priceLine = (qty && qty > 1)
    ? `Rs.${perHead.toLocaleString("en-IN")} per head \u00b7 Rs.${total.toLocaleString("en-IN")} for ${qty}`
    : `Rs.${perHead.toLocaleString("en-IN")}`;
  const box = Array.isArray(p.whats_in_box) ? p.whats_in_box : (p.whats_in_box ? [p.whats_in_box] : []);
  const specs = [];
  
  if (p.tier) specs.push(["Tier", p.tier]);
  if (p.weight_grams) specs.push(["Weight", `${p.weight_grams} g`]);
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(33,28,22,0.34)" }} />
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 51, width: "min(520px,100%)", background: RD.paper, borderLeft: `1px solid ${RD.ink}`, overflowY: "auto" }}>
        <div style={{ padding: "26px 32px 56px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
            <button onClick={onClose} style={{ border: "none", background: "transparent", fontSize: 20, lineHeight: 1, color: RD.inkMute, cursor: "pointer", padding: 4 }}>{"\u2715"}</button>
          </div>

          <div style={{ position: "relative", width: "100%", paddingBottom: "100%", border: `1px solid ${RD.ink}`, marginTop: 18, background: RD.surface, overflow: "hidden" }}>
            {p.image_url
              ? <img src={p.image_url} alt={p.name || ""} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
              : <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: RD.sans, fontSize: 12, color: RD.inkMute }}>No image yet</span>}
          </div>

          {p.tier && (
            <div style={{ marginTop: 24 }}>
              <span style={{ fontFamily: RD.sans, fontSize: 10.5, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", color: "#fff", background: RD.accent, padding: "5px 9px" }}>{p.tier}</span>
            </div>
          )}
          <div style={{ fontFamily: RD.serif, fontSize: 30, fontWeight: 600, letterSpacing: "-0.015em", lineHeight: 1.1, marginTop: 14, color: RD.ink }}>{p.name}</div>
          
          <div style={{ fontFamily: RD.sans, fontSize: 13.5, fontWeight: 500, color: RD.inkMute, marginTop: 14, paddingBottom: 18, borderBottom: `1px solid ${RD.line}` }}>{priceLine}</div>

          {p.description && <div style={{ fontFamily: RD.serif, fontSize: 17, fontWeight: 400, lineHeight: 1.62, color: RD.ink, marginTop: 20 }}>{p.description}</div>}

          {box.length > 0 && (
            <>
              <div style={{ fontFamily: RD.sans, fontSize: 11, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase", color: RD.inkMute, margin: "28px 0 4px" }}>What&rsquo;s in the box</div>
              {box.map((it, k) => (
                <div key={k} style={{ display: "flex", alignItems: "baseline", gap: 11, padding: "11px 0", borderBottom: `1px solid ${RD.line}` }}>
                  <span style={{ width: 5, height: 5, borderRadius: 999, background: RD.accent, flexShrink: 0, transform: "translateY(-2px)" }} />
                  <span style={{ fontFamily: RD.serif, fontSize: 15, color: RD.ink }}>{it}</span>
                </div>
              ))}
            </>
          )}

          {specs.length > 0 && (
            <>
              <div style={{ fontFamily: RD.sans, fontSize: 11, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase", color: RD.inkMute, margin: "28px 0 4px" }}>Specification</div>
              {specs.map(([label, value], k) => (
                <div key={k} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 18, padding: "13px 0", borderBottom: `1px solid ${RD.line}` }}>
                  <span style={{ fontFamily: RD.sans, fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: RD.inkMute, flexShrink: 0 }}>{label}</span>
                  <span style={{ fontFamily: RD.sans, fontSize: 14, fontWeight: 500, textAlign: "right", color: RD.ink }}>{value}</span>
                </div>
              ))}
            </>
          )}

          <div style={{ marginTop: 28 }}>
            <button onClick={() => toggleHeart({ ...p, _price: perHead })}
              style={{ width: "100%", border: isH ? `1.5px solid ${RD.accent}` : `1.5px solid ${RD.ink}`, background: isH ? RD.accent : "transparent", color: isH ? "#fff" : RD.ink, fontFamily: RD.sans, fontSize: 12.5, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", padding: 16, cursor: "pointer" }}>
              {isH ? "\u2713  Saved to shortlist" : "\u2661  Save to shortlist"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}// ── APP ───────────────────────────────────────────────────────────────────────
// The three-field home flow (and its /dove-chat, /dove-rank calls) is retired —
// chat over /dove-converse is now the only experience. Old ?mode=chat links
// still work; the parameter is simply ignored.

export default function App() {
  const [session, setSession] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const productsRef = useRef([]);
  const [submitted, setSubmitted] = useState(false);
  const [chatHeadcount, setChatHeadcount] = useState(null);

  // Shortlist
  const [hearted, setHearted] = useState(new Set());
  const heartedRef = useRef({});
  const [submitting, setSubmitting] = useState(false);

  // Phase 1 (rd_events.brief_id): the active brief lives inside ChatView's
  // conversation state, but shortlist events are logged here at App level.
  // ChatView keeps this ref in sync on every state change so logEvent can
  // stamp the correct brief_id without App owning any conversation state.
  // (Fixes the silent ReferenceError where logEvent read a stateRef that
  // only exists inside ChatView — swallowed by try/catch, so shortlist
  // add/remove/submit events never reached rd_events.)
  const activeBriefIdRef = useRef(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token") ||
      window.location.pathname.split("/").pop();
    if (token && token !== "/") loadSession(token);
    else setNotFound(true);
  }, []);

  const loadSession = async (token) => {
    // Stage-2 RLS: the browser no longer reads rd_sessions/rd_shortlists directly
    // (their public SELECT policies are dropped — token harvesting). The backend
    // resolves the token with its service key and returns the session row plus
    // the saved shortlist ids in one call. last_active now updates server-side.
    try {
      const res = await fetch(CATALOGUE_URL + "/session/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) { setNotFound(true); return; }
      const data = await res.json();
      if (!data?.session?.id) { setNotFound(true); return; }
      setSession(data.session);
      await loadProducts();
      applyShortlist(data.shortlist_product_ids || []);
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

  const applyShortlist = (productIds) => {
    // Was loadShortlist (direct rd_shortlists SELECT); the ids now arrive from
    // /session/resolve. Same hearting logic; the short delay lets product cards
    // settle before heartedRef is filled, exactly as before.
    try {
      if (productIds?.length > 0) {
        const ids = new Set(productIds);
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

  const logEvent = useCallback(async (type, pid=null, meta={}) => {
    if (!session) return;
    // Every funnel event carries the active brief_id (Phase 1) — one change point
    // covers shortlist_add/remove and shortlist_submit alike.
    try { await supabase.from("rd_events").insert([{ session_id: session.id, event_type: type, product_id: pid, metadata: { ...meta, brief_id: activeBriefIdRef.current ?? null } }]); } catch {}
  }, [session]);

  const toggleHeart = async (p) => {
    if (!session || !p?.id) return;
    const isHearted = hearted.has(p.id);
    const newHearted = new Set(hearted);
    if (isHearted) {
      newHearted.delete(p.id);
      delete heartedRef.current[p.id];
      // Stage-2: shortlist writes go through the backend (fire-and-forget, as before).
      fetch(CATALOGUE_URL + "/shortlist/remove", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: session.id, product_id: p.id }),
      }).catch(() => {});
      logEvent("shortlist_remove", p.id);
    } else {
      newHearted.add(p.id);
      heartedRef.current[p.id] = p;
      fetch(CATALOGUE_URL + "/shortlist/add", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: session.id, product_id: p.id }),
      }).catch(() => {});
      logEvent("shortlist_add", p.id);
    }
    setHearted(newHearted);
  };

  const submitShortlist = async () => {
    if (!session || hearted.size === 0) return;
    setSubmitting(true);

    const items = [...hearted]
      .map(id => heartedRef.current[id])
      .filter(Boolean)
      .map(p => ({ id: p.id, name: p.name, tier: p.tier || null, price: p._price || 0, image_url: p.image_url || null, bg: p._bg || null }));
    const total = items.reduce((s, p) => s + (p.price || 0), 0);

    logEvent("shortlist_submit", null, { product_ids: [...hearted], count: hearted.size });

    // Generate the id on the client so we don't need to read the row back —
    // the rd_submissions RLS allows anon INSERT but not SELECT.
    const submissionId =
      (typeof crypto !== "undefined" && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    // Durable record + WhatsApp notification — best-effort, must not block the UI.
    // brief/brief_summary were home-flow fields; in chat mode they were always
    // empty, so they land as null — same rows as before the home flow retired.
    try {
      const { error } = await supabase
        .from("rd_submissions")
        .insert([{
          id: submissionId,
          session_id: session.id,
          client_name: session.client_name || null,
          client_company: session.client_company || null,
          brief: null,
          brief_summary: null,
          items,
          total,
        }]);
      if (!error) {
        supabase.functions
          .invoke("notify-submission", { body: { submission_id: submissionId } })
          .catch(() => {});
      } else {
        console.error("rd_submissions insert failed", error);
      }
    } catch (e) {
      console.error("submission save failed", e);
    }

    setSubmitted(true);
    setSubmitting(false);
  };

  const shortlistItems = [...hearted].map(id => heartedRef.current[id]).filter(Boolean);

  const S = styles;

  if (notFound) return <div style={S.fullCenter}><Logo size="xl"/><p style={S.muted}>This link is invalid or has expired.</p></div>;
  if (!session) return <div style={S.fullCenter}><Logo size="xl"/><p style={S.muted}>Loading…</p></div>;

  if (submitted) return (
    <SubmissionSummary
      clientName={session.client_name}
      clientCompany={session.client_company}
      briefSummary={""}
      headcount={chatHeadcount}
      items={shortlistItems.map(p => ({
        id: p.id,
        name: p.name,
        tier: p.tier || null,
        price: p._price || 0,
        image_url: p.image_url || null,
        bg: p._bg || null,
      }))}
      onRestart={() => setSubmitted(false)}
    />
  );

  return (
    <ChatView
      session={session}
      productsRef={productsRef}
      hearted={hearted}
      toggleHeart={toggleHeart}
      submitShortlist={submitShortlist}
      submitting={submitting}
      setHeadcount={setChatHeadcount}
      activeBriefIdRef={activeBriefIdRef}
    />
  );
}

const styles = {
  fullCenter: { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:"100vh", textAlign:"center", padding:32 },
  muted: { fontFamily:"Georgia,serif", fontSize:15, fontWeight:300, color:"#aaa", marginTop:24 },
};
