// DEFECT PROBES — these assert the BUGGY behavior exists. A pass here = confirmed defect.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

const CATALOG = [{ id: 1, name: "The Lotus Offering Box", active: true, popularity: 9, image_url: "",
  pricing_tiers: [{ min_qty: 1, max_qty: null, price_per_unit: "4500" }], product_tags: [] }];
const inserts = [];
vi.mock("./supabase.js", () => {
  const chain = (r) => { const o = { select: () => o, eq: () => o, order: () => Promise.resolve(r),
    insert: (rows) => { inserts.push({ rows }); return { then: (f) => f({ error: null }) }; } }; return o; };
  return { supabase: {
    from: (t) => t === "catalog" ? chain({ data: CATALOG, error: null })
      : { insert: (rows) => { inserts.push({ table: t, rows }); return { then: (f) => f({ error: null }) }; } },
    functions: { invoke: () => Promise.resolve({}) } } };
});
const calls = [];
let converse = null, memoryHang = false;
function net() {
  global.fetch = vi.fn((url, opts = {}) => {
    calls.push({ url: String(url) });
    if (String(url).includes("/session/resolve")) return Promise.resolve({ ok: true, json: () => Promise.resolve({ session: { id: "s1", client_name: "Demo User", client_company: "Rock Dove Demo" }, shortlist_product_ids: [] }) });
    if (String(url).includes("/dove-memory")) return memoryHang ? new Promise(() => {}) : Promise.resolve({ ok: true, json: () => Promise.resolve({ returning: false }) });
    if (String(url).includes("/dove-converse")) return converse ? converse(opts) : Promise.resolve({ ok: true, json: () => Promise.resolve({ message: "ok", show_products: [], filters: {} }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}
async function boot() {
  window.history.replaceState({}, "", "/?token=demo-token");
  const { default: App } = await import("./App.jsx");
  return render(<App />);
}
beforeEach(() => { calls.length = 0; inserts.length = 0; converse = null; memoryHang = false; localStorage.clear(); vi.resetModules(); });
afterEach(() => cleanup());

describe("defect regressions (a PASS confirms the FIX)", () => {
  it("FIX 1: failed send restores the typed brief for one-tap resend", async () => {
    net(); converse = () => Promise.reject(new TypeError("net down"));
    await boot(); await screen.findByText(/good/i);
    const input = screen.getByLabelText("Message Dove");
    const brief = "Diwali for 500 distributors under 3000, no edibles, deliver Mumbai";
    await userEvent.type(input, brief + "{Enter}");
    await screen.findByText(/back in the box below/i);
    expect(input.value).toBe(brief);   // restored, one Enter resends
  });

  it.skip("withdrawn: double-click double-submit (disproven — React re-render disables in time)", async () => {
    net();
    converse = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ message: "picks", show_products: [1], filters: {} }) });
    await boot(); await screen.findByText(/good/i);
    await userEvent.type(screen.getByLabelText("Message Dove"), "show options{Enter}");
    await screen.findByText("The Lotus Offering Box");
    await userEvent.click(screen.getAllByText(/♡ Save/i)[0]);
    const btn = await screen.findByText(/Send to Rock Dove/i);
    await userEvent.dblClick(btn);
    await waitFor(() => expect(inserts.filter(i => i.table === "rd_submissions").length).toBeGreaterThanOrEqual(1));
    console.log("SUBMISSION ROWS:", inserts.filter(i => i.table === "rd_submissions").length);
    expect(inserts.filter(i => i.table === "rd_submissions").length).toBe(2); // defect if 2
  });

  it("FIX 3: revoked session (403) gets its own diagnosis, not the retry copy", async () => {
    net(); converse = () => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) });
    await boot(); await screen.findByText(/good/i);
    await userEvent.type(screen.getByLabelText("Message Dove"), "hello{Enter}");
    expect(await screen.findByText(/no longer active/i)).toBeTruthy();
    expect(screen.queryByText(/back in the box below/i)).toBeNull();
  });

  it("FIX 2: while /dove-memory is in flight, a setup indicator renders", async () => {
    net(); memoryHang = true;
    await boot();
    expect(await screen.findByText(/setting up your concierge/i)).toBeTruthy();
  });

  it("FIX 4: optimistic heart rolls back when the backend write fails", async () => {
    net();
    converse = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ message: "picks", show_products: [1], filters: {} }) });
    await boot(); await screen.findByText(/good/i);
    await userEvent.type(screen.getByLabelText("Message Dove"), "show options{Enter}");
    await screen.findByText("The Lotus Offering Box");
    global.fetch = vi.fn((url) => String(url).includes("/shortlist/") ? Promise.reject(new TypeError("down")) : Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    await userEvent.click(screen.getAllByText(/♡ Save/i)[0]);
    // rollback: the heart must revert to unsaved once the write fails
    await waitFor(() => expect(screen.queryByText(/Saved/)).toBeNull());
    expect(screen.getAllByText(/♡ Save/i).length).toBeGreaterThan(0);
  });
});
