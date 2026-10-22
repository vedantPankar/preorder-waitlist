import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const sandbox = { globalThis: null };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL("../extensions/waitlist-preorder/assets/wp-common.js", import.meta.url), "utf8"), sandbox);
const C = sandbox.WPCommon;

const oos = { id: 1, available: false, tracked: true, quantity: 0 };
const inStock = { id: 2, available: true, tracked: true, quantity: 5 };
const cfg = { variantId: "1", buttonText: "Reserve", shipDate: "2026-12-24", remaining: 3, soldOut: false };

test("wp-common.js is idempotent when included twice", () => {
  const before = C;
  vm.runInContext(readFileSync(new URL("../extensions/waitlist-preorder/assets/wp-common.js", import.meta.url), "utf8"), sandbox);
  assert.equal(sandbox.WPCommon, before);
});

test("waitlist visibility rules", () => {
  assert.equal(C.waitlistOffer(oos, { waitlistEnabled: true }).visible, true);
  assert.equal(C.waitlistOffer(inStock, { waitlistEnabled: true }).visible, false);           // in stock: normal Add to Cart
  assert.equal(C.waitlistOffer(oos, { waitlistEnabled: false }).visible, false);              // feature disabled
  assert.equal(C.waitlistOffer(null, { waitlistEnabled: true }).visible, false);
  assert.equal(C.waitlistOffer(oos, { waitlistEnabled: true, preorderActive: true }).visible, false);       // no double buttons
  assert.equal(C.waitlistOffer(oos, { waitlistEnabled: true, preorderActive: true, showWithPreorder: true }).visible, true); // explicit opt-in
  assert.equal(C.waitlistOffer(inStock, { waitlistEnabled: true, previewAlways: true }).visible, true);      // theme-editor preview
});

test("pre-order visibility rules", () => {
  assert.equal(C.preorderOffer(oos, cfg).active, true);
  assert.equal(C.preorderOffer(oos, undefined).reason, "not_configured");                     // disabled / not configured
  assert.equal(C.preorderOffer(oos, { ...cfg, soldOut: true }).reason, "sold_out");
  assert.equal(C.preorderOffer(inStock, cfg).reason, "in_stock");                              // in stock: normal Add to Cart
  assert.equal(C.preorderOffer({ ...oos, tracked: false }, cfg).active, false);
  assert.equal(C.preorderOffer(null, cfg).active, false);
});

test("variant lookup uses string/number ids interchangeably and never returns a stale variant", () => {
  const list = [oos, inStock];
  assert.equal(C.findVariant(list, "2"), inStock);
  assert.equal(C.findVariant(list, 1), oos);
  assert.equal(C.findVariant(list, "999"), null);
});

test("quantity clamping honours the remaining quota", () => {
  assert.deepEqual({ ...C.clampQuantity("2", cfg) }, { quantity: 2, clamped: false });
  assert.deepEqual({ ...C.clampQuantity("9", cfg) }, { quantity: 3, clamped: true });
  assert.equal(C.clampQuantity("abc", cfg).quantity, 1);
  assert.equal(C.clampQuantity("0", cfg).quantity, 1);
  assert.equal(C.clampQuantity("50", { remaining: null }).quantity, 50);
});

test("cart payload keeps variant, quantity and pre-order properties", () => {
  const p = C.buildCartPayload("111", 2, cfg, "en-US");
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].id, 111);
  assert.equal(p.items[0].quantity, 2);
  assert.equal(p.items[0].properties._preorder, "true");
  assert.equal(p.items[0].properties._preorder_ship_date, "2026-12-24");
  assert.equal(p.items[0].properties["Expected shipping"], "December 24, 2026");
});

test("email validation matches the backend rules", () => {
  for (const ok of ["a@b.co", " User+tag@Example.com "]) assert.ok(C.isValidEmail(ok), ok);
  for (const bad of ["", "a", "a@b", "a b@c.com", "<x>@b.com", null, "a@b." + "c".repeat(260)]) assert.ok(!C.isValidEmail(bad), String(bad));
});

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("signup submission: payload, success, server error, network error, invalid input", async () => {
  const calls = [];
  const ok = async (url, init) => { calls.push({ url, init }); return res(200, { ok: true, result: "created" }); };
  const r = await C.submitSignup(ok, "/apps/waitlist/signup", { email: " A@x.com ", productId: 9, variantId: 1, website: "" });
  assert.deepEqual({ ...r }, { ok: true, result: "created" });
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { email: "A@x.com", productId: "9", variantId: "1", website: "" });

  const fail = await C.submitSignup(async () => res(409, { ok: false, message: "This item is currently in stock." }), "/s", { email: "a@x.com", productId: 9, variantId: 1 });
  assert.deepEqual({ ...fail }, { ok: false, message: "This item is currently in stock." });
  const net = await C.submitSignup(async () => { throw new Error("offline"); }, "/s", { email: "a@x.com", productId: 9, variantId: 1 });
  assert.equal(net.ok, false);
  let called = false;
  const bad = await C.submitSignup(async () => { called = true; return res(200, {}); }, "/s", { email: "nope", productId: 9, variantId: 1 });
  assert.equal(bad.ok, false); assert.equal(called, false, "invalid email must not hit the network");
  const noVariant = await C.submitSignup(async () => res(200, {}), "/s", { email: "a@x.com", productId: 9, variantId: null });
  assert.equal(noVariant.ok, false);
});

function cartFetch({ remaining = 3, soldOut = false, cartStatus = 200, enabled = true, reserve = { status: 200, body: { ok: true, reservationId: "res_1" } } } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith("/apps/waitlist/config")) return res(200, { waitlistEnabled: true, variants: enabled ? [{ variantId: "111", buttonText: "Reserve", shipDate: "2026-12-24", remaining, soldOut }] : [] });
    if (url === "/apps/waitlist/reserve") return res(reserve.status, reserve.body);
    if (url === "/cart/add.js") return res(cartStatus, cartStatus === 200 ? { items: [] } : { description: "Sold out" });
    throw new Error("unexpected " + url);
  };
  fn.calls = calls;
  return fn;
}
const addOpts = (over = {}) => ({ configUrl: "/apps/waitlist/config", productId: "999", variantId: "111", quantity: 2, locale: "en-US", ...over });

test("add to cart: re-validates the quota with the server, then uses Shopify's /cart/add.js", async () => {
  const f = cartFetch();
  const r = await C.addPreorderToCart(f, addOpts());
  assert.equal(r.ok, true);
  assert.deepEqual(f.calls.map((c) => c.url.split("?")[0]), ["/apps/waitlist/config", "/apps/waitlist/reserve", "/cart/add.js"]);
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { intent: "reserve", productId: "999", variantId: "111", quantity: 2 });
  const body = JSON.parse(f.calls[2].init.body);
  assert.equal(body.items[0].id, 111); assert.equal(body.items[0].quantity, 2);
  assert.equal(body.items[0].properties._preorder_reservation, "res_1");
});

test("add to cart: a refused reservation stops before the cart; closed campaigns say so", async () => {
  const f = cartFetch({ reserve: { status: 409, body: { ok: false, message: "Only 1 left for pre-order." } } });
  const r = await C.addPreorderToCart(f, addOpts());
  assert.deepEqual({ ...r }, { ok: false, message: "Only 1 left for pre-order." });
  assert.ok(!f.calls.some((c) => c.url === "/cart/add.js"));
  const ended = async (url) => (url.startsWith("/apps/waitlist/config") ? res(200, { variants: [{ variantId: "111", phase: "ended", soldOut: true }] }) : (() => { throw new Error("no calls expected: " + url); })());
  assert.match((await C.addPreorderToCart(ended, addOpts({ endedText: "Campaign over" }))).message, /Campaign over/);
});

test("add to cart: a 401 login_required from the server stops before the cart and flags loginRequired", async () => {
  const f = cartFetch({ reserve: { status: 401, body: { ok: false, error: "login_required", message: "Please log in to pre-order." } } });
  const r = await C.addPreorderToCart(f, addOpts());
  assert.deepEqual({ ...r }, { ok: false, loginRequired: true, message: "Please log in to pre-order." });
  assert.ok(!f.calls.some((c) => c.url === "/cart/add.js"));
  const refused = await C.addPreorderToCart(cartFetch({ reserve: { status: 409, body: { ok: false, message: "Only 1 left for pre-order." } } }), addOpts());
  assert.ok(!refused.loginRequired, "other refusals are not login prompts");
});

test("login url keeps the visitor's product page as the return target; config exposes the setting", async () => {
  assert.equal(C.loginUrl("/account/login", "/products/gift-card?variant=5"), "/account/login?return_url=%2Fproducts%2Fgift-card%3Fvariant%3D5");
  assert.equal(C.loginUrl("", ""), "/account/login?return_url=%2F");
  const cfg = (body) => C.fetchConfig(async () => res(200, body), "/apps/waitlist/config", "999");
  assert.equal((await cfg({ variants: [], requirePreorderLogin: true })).requirePreorderLogin, true);
  assert.equal((await cfg({ variants: [] })).requirePreorderLogin, false);
});

test("add to cart: refuses (without touching the cart) when over quota, sold out, or disabled", async () => {
  for (const [f, label] of [[cartFetch({ remaining: 1 }), "over quota"], [cartFetch({ soldOut: true }), "sold out"], [cartFetch({ enabled: false }), "disabled"]]) {
    const r = await C.addPreorderToCart(f, addOpts());
    assert.equal(r.ok, false, label);
    assert.ok(!f.calls.some((c) => c.url === "/cart/add.js"), `${label}: cart must not be called`);
  }
  assert.match((await C.addPreorderToCart(cartFetch({ remaining: 1 }), addOpts())).message, /Only 1 left/);
});

test("add to cart: surfaces Shopify cart errors", async () => {
  const f = cartFetch({ cartStatus: 422 });
  const r = await C.addPreorderToCart(f, addOpts());
  assert.deepEqual({ ...r }, { ok: false, message: "Sold out" });
  const release = JSON.parse(f.calls[f.calls.length - 1].init.body);
  assert.deepEqual(release, { intent: "release", reservationId: "res_1" }); // the hold is given back
});

test("config fetch degrades safely (server error => nothing enabled)", async () => {
  const cfgs = await C.fetchConfig(async () => res(500, {}), "/apps/waitlist/config", "9");
  assert.equal(cfgs.waitlistEnabled, false); assert.deepEqual({ ...cfgs.variants }, {});
  const off = await C.fetchConfig(async () => res(200, { waitlistEnabled: false, variants: [] }), "/c", "9");
  assert.equal(off.waitlistEnabled, false);
});

test("preorderHint explains every reason the pre-order button can be hidden", () => {
  for (const r of ["not_configured", "sold_out", "untracked_inventory", "in_stock"]) assert.ok(C.preorderHint(r).length > 10, r);
  assert.equal(C.preorderHint("ok"), "");
});

test("variant ids compare equal across number, numeric string and GID formats", () => {
  assert.equal(C.normalizeId("gid://shopify/ProductVariant/123"), "123");
  assert.equal(C.normalizeId(123), "123");
  assert.equal(C.findVariant([{ id: 123 }], "gid://shopify/ProductVariant/123").id, 123);
  assert.equal(C.normalizeId(null), "");
});

test("preorderOffer understands campaign phases; in-stock variants are never affected", () => {
  const oos = { id: 1, tracked: true, quantity: 0 };
  const phase = (ph) => C.preorderOffer(oos, { phase: ph, soldOut: ph !== "active" });
  assert.equal(phase("active").active, true);
  for (const [p, display] of [["scheduled", "countdown"], ["ended", "closed"], ["sold_out", "closed"]]) { assert.equal(phase(p).active, false); assert.equal(phase(p).display, display, p); }
  for (const p of ["paused", "draft", "disabled"]) { assert.equal(phase(p).active, false); assert.equal(phase(p).display, undefined, p); }
  assert.equal(C.preorderOffer({ id: 1, tracked: true, quantity: 4 }, { phase: "ended", soldOut: true }).reason, "in_stock");
  assert.equal(C.preorderOffer(oos, { soldOut: true }).reason, "sold_out"); // older server responses without `phase`
});

test("waitlistOffer: a closed pre-order campaign makes the waitlist available even if the page still says purchasable", () => {
  const v = { id: 1, available: true };
  assert.equal(C.waitlistOffer(v, { waitlistEnabled: true }).visible, false);
  assert.equal(C.waitlistOffer(v, { waitlistEnabled: true, preorderClosed: true }).visible, true);
  assert.equal(C.waitlistOffer(v, { waitlistEnabled: false, preorderClosed: true }).visible, false);
});

test("countdown maths: server clock offset, formatting, never negative", () => {
  assert.deepEqual({ ...C.formatCountdown(0) }, { done: true, text: "00:00:00" });
  assert.equal(C.formatCountdown(-5).done, true);
  assert.equal(C.formatCountdown(3661000).text, "01:01:01");
  assert.equal(C.formatCountdown(90061000).text, "1d 01:01:01");
  const target = C.countdownTarget({ phase: "scheduled", campaign: { countdown: true, startsAt: "2026-11-01T00:00:10.000Z" } });
  assert.deepEqual([target.kind, target.at], ["start", Date.parse("2026-11-01T00:00:10.000Z")]);
  assert.equal(C.countdownTarget({ phase: "active", campaign: { countdown: true, endsAt: "2026-11-02T00:00:00.000Z" } }).kind, "end");
  assert.equal(C.countdownTarget({ phase: "active", campaign: { countdown: false, endsAt: "2026-11-02T00:00:00.000Z" } }), null);
  assert.equal(C.countdownTarget({ phase: "active", campaign: null }), null);
  assert.equal(C.countdownTarget({ phase: "ended", campaign: { countdown: true, endsAt: "2026-11-02T00:00:00.000Z" } }), null);
  // a visitor whose clock is 10 minutes fast still sees the SERVER's remaining time
  const offset = C.clockOffset("2026-11-01T00:00:00Z", Date.parse("2026-11-01T00:10:00Z")); // server 00:00, client reads 00:10
  assert.equal(offset, -600000);
  assert.equal(C.remainingMs(Date.parse("2026-11-01T00:10:00Z"), Date.parse("2026-11-01T00:10:00Z"), offset), 600000);
  assert.equal(C.clockOffset(undefined, 123), 0); // no server time: trust the visitor's clock
});

test("progress info uses sold units and the target; clamps to 100%", () => {
  assert.deepEqual({ ...C.progressInfo({ campaign: { progress: { sold: 2, target: 8 } } }) }, { sold: 2, target: 8, pct: 25, text: "2 of 8 pre-ordered" });
  assert.equal(C.progressInfo({ campaign: { progress: { sold: 12, target: 8 } } }).pct, 100);
  assert.equal(C.progressInfo({ campaign: { progress: null } }), null);
  assert.equal(C.progressInfo({}), null);
  assert.equal(C.progressInfo({ campaign: { progress: { sold: 0, target: 0 } } }), null);
});

test("cart payload carries the reservation id as a hidden property", () => {
  const p = C.buildCartPayload(5, 2, { shipDate: "2026-12-24" }, "en", "res_abc");
  assert.equal(p.items[0].properties._preorder_reservation, "res_abc");
  assert.equal(C.buildCartPayload(5, 2, { shipDate: "2026-12-24" }, "en").items[0].properties._preorder_reservation, undefined);
});
