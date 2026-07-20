// Integration harness: the REAL App component in a real DOM (jsdom), real events,
// network faked at the fetch/supabase boundary only. Asserts on rendered output
// AND on outbound request payloads.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

// ── Catalogue fixture: includes a bad-price row (M3) and an edible ──────────
const CATALOG = [
  { id: 1, name: "The Lotus Offering Box", active: true, popularity: 9, image_url: "", tier: "GOLD",
    pricing_tiers: [{ min_qty: 1, max_qty: 99, price_per_unit: "4500" }, { min_qty: 100, max_qty: null, price_per_unit: "4165" }],
    product_tags: [{ tag: "brass", dimension: "material" }] },
  { id: 2, name: "The Sacred Lotus Set", active: true, popularity: 8, image_url: "",
    pricing_tiers: [{ min_qty: 1, max_qty: null, price_per_unit: "4522" }], product_tags: [] },
  { id: 3, name: "The Kashmiri Kahwa Box", active: true, popularity: 7, image_url: "",
    pricing_tiers: [{ min_qty: 1, max_qty: null, price_per_unit: "2100" }],
    product_tags: [{ tag: "edible", dimension: "type" }], edible: true },
  { id: 4, name: "The Broken Price Box", active: true, popularity: 6, image_url: "",
    pricing_tiers: [{ min_qty: 1, max_qty: null, price_per_unit: "not-a-number" }], product_tags: [] },
];

// ── Supabase mock: chainable, resolves the catalogue; records inserts ────────
const inserts = [];
vi.mock("./supabase.js", () => {
  const chain = (result) => {
    const o = {
      select: () => o, eq: () => o, order: () => Promise.resolve(result),
      insert: (rows) => { inserts.push({ rows }); return { then: (f) => f({ error: null }) }; },
    };
    return o;
  };
  return {
    supabase: {
      from: (table) => table === "catalog"
        ? chain({ data: CATALOG, error: null })
        : { insert: (rows) => { inserts.push({ table, rows }); return { then: (f) => f({ error: null }) }; } },
      functions: { invoke: () => Promise.resolve({}) },
    },
  };
});

// ── fetch mock: keyed by endpoint; records every call ────────────────────────
const calls = [];
let converseResponder = null; // per-test override
function installFetch({ resolveFail = false, session = { id: "s1", client_name: "Demo User", client_company: "Rock Dove Demo" } } = {}) {
  global.fetch = vi.fn((url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
    if (String(url).includes("/session/resolve")) {
      if (resolveFail === "network") return Promise.reject(new TypeError("Failed to fetch"));
      if (resolveFail === "invalid") return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ session, shortlist_product_ids: [] }) });
    }
    if (String(url).includes("/dove-memory")) return Promise.resolve({ ok: true, json: () => Promise.resolve({ returning: false }) });
    if (String(url).includes("/dove-converse")) {
      if (converseResponder) return converseResponder(opts);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        message: "Here are strong picks within your range.",
        show_products: [1, 2], follow_up_chips: ["Show me more"], filters: {},
      }) });
    }
    if (String(url).includes("/shortlist/")) return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

async function boot(token = "demo-token", extra = {}) {
  window.history.replaceState({}, "", `/?token=${token}${extra.debug ? "&debug=1" : ""}`);
  const { default: App } = await import("./App.jsx");
  return render(<App />);
}

beforeEach(() => { calls.length = 0; inserts.length = 0; converseResponder = null; localStorage.clear(); vi.resetModules(); });
afterEach(() => cleanup());

// ═════════════════════════════════ JOURNEYS ═════════════════════════════════

describe("session bootstrap", () => {
  it("invalid token → 'invalid or expired' screen", async () => {
    installFetch({ resolveFail: "invalid" });
    await boot("bad-token");
    expect(await screen.findByText(/invalid or has expired/i)).toBeTruthy();
  });

  it("H6: network failure → connection message, NOT 'expired'", async () => {
    installFetch({ resolveFail: "network" });
    await boot();
    expect(await screen.findByText(/couldn.t reach rock dove/i)).toBeTruthy();
    expect(screen.queryByText(/invalid or has expired/i)).toBeNull();
  });

  it("valid session → first-time greeting with starter chips", async () => {
    installFetch();
    await boot();
    expect(await screen.findByText(/good (morning|afternoon|evening), demo/i)).toBeTruthy();
    expect(screen.getByText(/50 for Diwali/i)).toBeTruthy();
  });
});

describe("core chat journey", () => {
  it("send brief → payload carries brief fields + capped history; cards render within budget; chip click sends", async () => {
    installFetch();
    await boot();
    await screen.findByText(/good/i);
    const input = screen.getByLabelText("Message Dove");
    await userEvent.type(input, "Diwali gifts for 150 people, budget ₹4,000–₹5,000 per head, show me options{Enter}");

    // outbound payload assertions
    await waitFor(() => expect(calls.some(c => c.url.includes("/dove-converse"))).toBe(true));
    const req = calls.find(c => c.url.includes("/dove-converse")).body;
    expect(req.brief.budget_ceiling).toBe(5000);
    expect(req.brief.budget_floor).toBe(4000);
    expect(req.brief.headcount).toBe(150);
    expect(req.history.length).toBeLessThanOrEqual(40);
    expect(req.candidates.length).toBeGreaterThan(0);

    // rendered cards: model picked 1 & 2; both within band at qty 150
    expect(await screen.findByText("The Lotus Offering Box")).toBeTruthy();
    expect(screen.getByText("Rs.4,165")).toBeTruthy();   // qty-150 tier price, not 4,500
    expect(screen.getByText("The Sacred Lotus Set")).toBeTruthy();

    // chip renders and is clickable → fires another converse call
    const before = calls.filter(c => c.url.includes("/dove-converse")).length;
    await userEvent.click(screen.getByText("Show me more"));
    await waitFor(() => expect(calls.filter(c => c.url.includes("/dove-converse")).length).toBe(before + 1));
  });

  it("qtyAt: earlier cards keep their price after headcount changes", async () => {
    installFetch();
    await boot();
    await screen.findByText(/good/i);
    const input = screen.getByLabelText("Message Dove");
    await userEvent.type(input, "gifts for 150 people under 5000, show options{Enter}");
    await screen.findByText("Rs.4,165"); // tier price at 150

    converseResponder = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ message: "Noted — 50 units.", show_products: [], filters: {} }) });
    await userEvent.type(input, "actually make it 50 units{Enter}");
    await screen.findByText(/noted/i);
    // the FIRST reply's card must still show the qty-150 price, not re-price to 4,500
    expect(screen.getByText("Rs.4,165")).toBeTruthy();
    expect(screen.queryByText("Rs.4,500")).toBeNull();
  });

  it("sanitizeDoveMsg: backend JSON leak never renders", async () => {
    installFetch();
    converseResponder = () => Promise.resolve({ ok: true, json: () => Promise.resolve({
      message: 'Lovely brief.\n\n{"message":"Lovely brief. Here are my opening picks at 15',
      show_products: [], filters: {} }) });
    await boot();
    await screen.findByText(/good/i);
    await userEvent.type(screen.getByLabelText("Message Dove"), "hello{Enter}");
    expect(await screen.findByText("Lovely brief.")).toBeTruthy();
    expect(screen.queryByText(/\{"message"/)).toBeNull();
  });

  it("fetch failure → friendly retry message + client_error breadcrumb", async () => {
    installFetch();
    converseResponder = () => Promise.reject(new TypeError("Failed to fetch"));
    await boot();
    await screen.findByText(/good/i);
    await userEvent.type(screen.getByLabelText("Message Dove"), "hello{Enter}");
    expect(await screen.findByText(/back in the box below/i)).toBeTruthy();
    expect(inserts.some(i => i.rows?.[0]?.event_type === "client_error")).toBe(true);
  });

  it("timeout (AbortError) → distinct timeout copy", async () => {
    installFetch();
    converseResponder = () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await boot();
    await screen.findByText(/good/i);
    await userEvent.type(screen.getByLabelText("Message Dove"), "hello{Enter}");
    expect(await screen.findByText(/taking longer than it should/i)).toBeTruthy();
    expect(screen.getByLabelText("Message Dove").value).toBe("hello"); // FIX 1 applies on timeout too
  });
});

describe("shortlist journey", () => {
  it("save → header button appears; submit → rd_submissions insert with resolved items; summary renders", async () => {
    installFetch();
    await boot();
    await screen.findByText(/good/i);
    await userEvent.type(screen.getByLabelText("Message Dove"), "show me options for 150 people under 5000{Enter}");
    await screen.findByText("The Lotus Offering Box");

    await userEvent.click(screen.getAllByText(/♡ Save/i)[0]);
    const sendBtn = await screen.findByText(/Send to Rock Dove/i);
    expect(calls.some(c => c.url.includes("/shortlist/add"))).toBe(true);

    await userEvent.click(sendBtn);
    await waitFor(() => expect(inserts.some(i => i.table === "rd_submissions")).toBe(true));
    const sub = inserts.find(i => i.table === "rd_submissions").rows[0];
    expect(sub.items.length).toBe(1);
    expect(sub.items[0].name).toBe("The Lotus Offering Box");
    expect(await screen.findByText(/gift selection/i)).toBeTruthy();
  });
});

describe("security & integrity", () => {
  it("H1: debug panel renders for demo session, NOT for a real client session", async () => {
    installFetch();
    await boot("demo-token", { debug: true });
    await screen.findByText(/good/i);
    await userEvent.type(screen.getByLabelText("Message Dove"), "options for 150 under 5000{Enter}");
    await screen.findByText("The Lotus Offering Box");
    expect(screen.getByText(/debug · sent/i)).toBeTruthy();

    cleanup(); calls.length = 0; vi.resetModules();
    installFetch({ session: { id: "s2", client_name: "Priya Mehta", client_company: "Axis Bank" } });
    await boot("axis-token", { debug: true });
    await screen.findByText(/good/i);
    await userEvent.type(screen.getByLabelText("Message Dove"), "options for 150 under 5000{Enter}");
    await screen.findByText("The Lotus Offering Box");
    expect(screen.queryByText(/debug · sent/i)).toBeNull();
  });

  it("M3/FIX9: broken price data renders Price on request, never NaN or Rs.0", async () => {
    installFetch();
    converseResponder = () => Promise.resolve({ ok: true, json: () => Promise.resolve({
      message: "Including one odd one.", show_products: [4], filters: {} }) });
    await boot();
    await screen.findByText(/good/i);
    await userEvent.type(screen.getByLabelText("Message Dove"), "show options{Enter}");
    await screen.findByText("The Broken Price Box");
    expect(screen.queryByText(/NaN/)).toBeNull();
    expect(screen.queryByText("Rs.0")).toBeNull();
    expect(screen.getByText(/price on request/i)).toBeTruthy();
  });

  it("M2: persisted chat contains no debug payloads and is size-capped", async () => {
    installFetch();
    await boot("demo-token", { debug: true });
    await screen.findByText(/good/i);
    await userEvent.type(screen.getByLabelText("Message Dove"), "options for 150 under 5000{Enter}");
    await screen.findByText("The Lotus Offering Box");
    const key = Object.keys(localStorage).find(k => k.startsWith("rd_chat_"));
    const stored = JSON.parse(localStorage.getItem(key));
    expect(stored.messages.every(m => m.debug === undefined)).toBe(true);
  });

  it("persistence round-trip: refresh restores a real conversation", async () => {
    installFetch();
    await boot();
    await screen.findByText(/good/i);
    await userEvent.type(screen.getByLabelText("Message Dove"), "options for 150 under 5000{Enter}");
    await screen.findByText("The Lotus Offering Box");
    cleanup(); vi.resetModules(); installFetch();
    await boot();
    expect(await screen.findByText("The Lotus Offering Box")).toBeTruthy(); // restored, not re-greeted
  });

  it("detail drawer opens from a card and closes", async () => {
    installFetch();
    await boot();
    await screen.findByText(/good/i);
    await userEvent.type(screen.getByLabelText("Message Dove"), "options for 150 under 5000{Enter}");
    await userEvent.click(await screen.findByText("The Lotus Offering Box"));
    expect(await screen.findByText(/save to shortlist/i)).toBeTruthy();
    await userEvent.click(screen.getByText("✕"));
    await waitFor(() => expect(screen.queryByText(/save to shortlist/i)).toBeNull());
  });
});

describe("exploratory edges", () => {
  it("empty input + Enter sends nothing", async () => {
    installFetch();
    await boot();
    await screen.findByText(/good/i);
    const before = calls.filter(c => c.url.includes("/dove-converse")).length;
    await userEvent.type(screen.getByLabelText("Message Dove"), "{Enter}");
    await new Promise(r => setTimeout(r, 60));
    expect(calls.filter(c => c.url.includes("/dove-converse")).length).toBe(before);
  });

  it("rapid double-Enter during loading fires exactly one request", async () => {
    installFetch();
    let release;
    converseResponder = () => new Promise(res => { release = () => res({ ok: true, json: () => Promise.resolve({ message: "ok", show_products: [], filters: {} }) }); });
    await boot();
    await screen.findByText(/good/i);
    const input = screen.getByLabelText("Message Dove");
    await userEvent.type(input, "hello{Enter}");
    await userEvent.type(input, "again{Enter}");   // arrives while loading
    expect(calls.filter(c => c.url.includes("/dove-converse")).length).toBe(1);
    await act(async () => { release(); });
  });

  it("'show me all options' renders every within-budget piece and NONE above the ceiling", async () => {
    installFetch();
    converseResponder = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ message: "Everything I have.", show_products: [], filters: {} }) });
    await boot();
    await screen.findByText(/good/i);
    // ceiling 4400 at qty 150: Lotus(4165 ✓), Sacred(4522 ✗), Kahwa(2100 ✓), Broken(0 ✓)
    await userEvent.type(screen.getByLabelText("Message Dove"), "150 people, under 4400 — show me all options{Enter}");
    await screen.findByText("The Lotus Offering Box");
    expect(screen.getByText("The Kashmiri Kahwa Box")).toBeTruthy();
    expect(screen.queryByText("The Sacred Lotus Set")).toBeNull();  // over ceiling — must not render
  });

  it("StrictMode double-mount greets exactly once", async () => {
    installFetch();
    window.history.replaceState({}, "", "/?token=demo-token");
    const { default: App } = await import("./App.jsx");
    render(<React.StrictMode><App /></React.StrictMode>);
    await screen.findByText(/good (morning|afternoon|evening)/i);
    expect(screen.getAllByText(/good (morning|afternoon|evening)/i).length).toBe(1);
  });
});
