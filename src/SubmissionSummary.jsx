import { useState } from "react";

// ── Design tokens (matched to App.jsx) ───────────────────────────────────────
const BG = "#FFFFFF";
const SURFACE = "#F7F7F5";
const BORDER = "#E8E5DF";
const DOVE_BLUE = "#6B8CAE";
const GREEN = "#2C5F3A";
const DARK = "#111111";

const SERIF = "'Playfair Display',Georgia,serif"; // headlines, names, prices
const BODY = "Georgia,serif";                      // editorial voice
const UI = "'Josefin Sans','Helvetica Neue',sans-serif"; // labels, chrome

const inr = n => "₹" + Number(n || 0).toLocaleString("en-IN");
const firstName = s => (s || "").trim().split(" ")[0] || "there";

// ─────────────────────────────────────────────────────────────────────────────
// SubmissionSummary
// Client-facing record of a submitted shortlist. Drop into the view==="submitted"
// branch of App.jsx.
//
// PRICING (fix #6): in this gifting model each recipient receives ONE gift, so a
// shortlist of several pieces is a set of OPTIONS, not an order. We therefore show
// a per-gift price (or a range across the options), never a misleading sum. If a
// headcount is known we add an indicative ORDER estimate (per-gift × headcount).
// Pass `headcount` from the conversation when you have it; omit it otherwise.
//
// Props:
//   clientName     string
//   clientCompany  string (optional)
//   briefSummary   string (optional)
//   items          array  [{ id, name, tier, price, image_url, bg }]
//   headcount      number (optional) — number of recipients
//   onRestart      fn     (optional)
//   total          number (accepted for backwards-compat; no longer shown as a sum)
// ─────────────────────────────────────────────────────────────────────────────
export default function SubmissionSummary({
  clientName = "",
  clientCompany = "",
  briefSummary = "",
  items = [],
  headcount = null,
  onRestart,
  total, // eslint-disable-line no-unused-vars  (kept for backwards-compat)
}) {
  const [copied, setCopied] = useState(false);

  const dateLong = new Date().toLocaleDateString("en-IN", {
    day: "numeric", month: "long", year: "numeric",
  });

  const title = clientCompany
    ? `Rock Dove — ${clientCompany} Gift Selection`
    : "Rock Dove — Gift Selection";

  // ── Per-gift pricing (not a sum) ──────────────────────────────────────────
  const prices = items.map(p => Number(p.price || 0)).filter(n => n > 0);
  const minP = prices.length ? Math.min(...prices) : 0;
  const maxP = prices.length ? Math.max(...prices) : 0;
  const single = items.length === 1;
  const sameP = minP === maxP;

  const perGiftLabel = single ? "Per gift" : "Per gift (range across options)";
  const perGiftValue = sameP ? inr(minP) : `${inr(minP)} – ${inr(maxP)}`;

  const hc = Number(headcount) > 0 ? Number(headcount) : null;
  const orderValue = hc
    ? (sameP ? inr(minP * hc) : `${inr(minP * hc)} – ${inr(maxP * hc)}`)
    : null;

  const plainText = [
    title,
    `${items.length} gift option${items.length === 1 ? "" : "s"}`,
    briefSummary ? `Brief: ${briefSummary}` : "",
    "",
    ...items.map(p => `• ${p.name}${p.tier ? ` (${p.tier})` : ""} — ${inr(p.price)}`),
    "",
    `${perGiftLabel}: ${perGiftValue}`,
    orderValue ? `Indicative order (×${hc}): ${orderValue}` : "",
    "",
    `Prepared ${dateLong}`,
  ].filter(Boolean).join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch { /* clipboard unavailable — no-op */ }
  };

  return (
    <div style={{ minHeight: "100vh", background: SURFACE, padding: "40px 20px", fontFamily: UI }}>
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #rd-summary, #rd-summary * { visibility: visible; }
          #rd-summary {
            position: absolute; top: 0; left: 0; width: 100%;
            box-shadow: none !important; margin: 0 !important;
          }
          .rd-no-print { display: none !important; }
        }
        #rd-summary { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      `}</style>

      {/* Confirmation line (not part of the printable card) */}
      <div className="rd-no-print" style={{ maxWidth: 640, margin: "0 auto 18px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 30, height: 30, borderRadius: "50%", background: GREEN, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 }}>✓</div>
        <p style={{ fontFamily: BODY, fontSize: 15, fontWeight: 300, color: "#555", margin: 0 }}>
          Thank you, {firstName(clientName)}. Your selection has been sent to the Rock Dove studio — we’ll be in touch within 24 hours. Keep a copy below.
        </p>
      </div>

      {/* Printable summary card */}
      <div id="rd-summary" style={{ maxWidth: 640, margin: "0 auto", background: BG, border: `1px solid ${BORDER}`, padding: "44px 48px" }}>

        {/* Masthead */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 6 }}>
          <span style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, letterSpacing: 4, textTransform: "uppercase", color: DARK, lineHeight: 1 }}>Rock</span>
          <span style={{ fontFamily: SERIF, fontSize: 22, fontStyle: "italic", color: DOVE_BLUE, fontWeight: 400, letterSpacing: 1, lineHeight: 1 }}>Dove</span>
        </div>
        <div style={{ fontSize: 10, letterSpacing: 3, textTransform: "uppercase", color: "#aaa", fontWeight: 300 }}>Gift Selection</div>

        <div style={{ height: 1, background: BORDER, margin: "22px 0" }} />

        {/* Meta */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
          <div>
            {clientCompany && (
              <p style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: DARK, margin: "0 0 2px" }}>{clientCompany}</p>
            )}
            <p style={{ fontFamily: UI, fontSize: 12, color: "#888", margin: 0, letterSpacing: 0.3 }}>
              {clientName ? `Prepared for ${clientName}` : "Gift selection"}
              {hc ? ` · ${hc} recipients` : ""}
            </p>
          </div>
          <p style={{ fontFamily: UI, fontSize: 11, color: "#aaa", margin: 0, letterSpacing: 0.5 }}>{dateLong}</p>
        </div>

        {briefSummary && (
          <p style={{ fontFamily: BODY, fontStyle: "italic", fontSize: 15, fontWeight: 300, color: "#555", lineHeight: 1.6, margin: "16px 0 0" }}>
            “{briefSummary}”
          </p>
        )}

        <div style={{ fontFamily: UI, fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: "#bbb", margin: "24px 0 4px" }}>
          {single ? "Selected gift" : `${items.length} gift options`}
        </div>

        {/* Items */}
        <div>
          {items.map(p => (
            <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 16, padding: "16px 0", borderBottom: `1px solid ${BORDER}` }}>
              <div style={{ width: 46, height: 56, background: p.bg || SURFACE, flexShrink: 0, overflow: "hidden" }}>
                {p.image_url && <img src={p.image_url} alt={p.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 400, color: DARK, margin: "0 0 3px" }}>{p.name}</p>
                {p.tier && (
                  <p style={{ fontFamily: UI, fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase", color: "#999", margin: 0 }}>{p.tier}</p>
                )}
              </div>
              <p style={{ fontFamily: SERIF, fontSize: 16, color: DARK, margin: 0, whiteSpace: "nowrap" }}>{inr(p.price)}</p>
            </div>
          ))}
        </div>

        {/* Per-gift price (+ optional order estimate) */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 20 }}>
          <span style={{ fontFamily: UI, fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", color: "#999" }}>
            {perGiftLabel}
          </span>
          <span style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: DARK }}>{perGiftValue}</span>
        </div>

        {orderValue && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 8 }}>
            <span style={{ fontFamily: UI, fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", color: "#999" }}>
              Indicative order · ×{hc}
            </span>
            <span style={{ fontFamily: SERIF, fontSize: 16, color: "#555" }}>{orderValue}</span>
          </div>
        )}

        <p style={{ fontFamily: UI, fontSize: 10, color: "#bbb", margin: "10px 0 0", letterSpacing: 0.3 }}>
          {single
            ? "Pricing is indicative and quantity-dependent. Final quotation confirmed by the Rock Dove studio."
            : "Each recipient receives one gift — figures are per gift, not a combined total. Pricing is indicative and quantity-dependent; final quotation confirmed by the Rock Dove studio."}
        </p>
      </div>

      {/* Actions */}
      <div className="rd-no-print" style={{ maxWidth: 640, margin: "20px auto 0", display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button
          onClick={() => window.print()}
          style={{ flex: "1 1 200px", padding: "13px 18px", background: GREEN, border: "none", color: "#fff", fontFamily: UI, fontSize: 13, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer" }}
        >
          Save as PDF
        </button>
        <button
          onClick={copy}
          style={{ flex: "1 1 160px", padding: "13px 18px", background: BG, border: `1px solid ${BORDER}`, color: copied ? GREEN : "#555", fontFamily: UI, fontSize: 13, fontWeight: 500, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer" }}
        >
          {copied ? "✓ Copied" : "Copy summary"}
        </button>
        {onRestart && (
          <button
            onClick={onRestart}
            style={{ flex: "0 0 auto", padding: "13px 18px", background: "none", border: "none", color: "#999", fontFamily: UI, fontSize: 13, fontWeight: 400, letterSpacing: 0.5, cursor: "pointer" }}
          >
            New brief
          </button>
        )}
      </div>
    </div>
  );
}
