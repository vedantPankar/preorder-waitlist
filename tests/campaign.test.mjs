import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, fakeMailer } from "./helpers.mjs";
import {
  campaignPhase, campaignStatus, deleteCampaign, desiredOpen, effectiveLimit, expireHolds, listCampaigns, reconcileShop,
  releaseReservation, reserve, saveCampaign, setCampaignState, validateCampaignInput, variantPhase,
} from "../app/lib/campaign.server.js";
import { storefrontConfig, saveConfigs } from "../app/lib/preorder.server.js";
import { handleInventoryLevelUpdate } from "../app/lib/webhooks.server.js";
import { handleSignupRequest } from "../app/lib/signup.server.js";
import { handleReserveRequest } from "../app/lib/reserve-request.server.js";

let db;
before(async () => { db = await createTestDb(); });

/** Stateful fake Shopify: variants keyed by id; answers node lookups, inventory-item lookups and policy mutations. */
function store(variants) {
  const state = new Map(variants.map((v) => [String(v.id), { qty: 0, policy: "DENY", product: "999", title: "Red", ...v }]));
  const node = (v) => ({ id: `gid://shopify/ProductVariant/${v.id}`, title: v.title, inventoryQuantity: v.qty, inventoryPolicy: v.policy, selectedOptions: [], product: { id: `gid://shopify/Product/${v.product}`, title: `Board ${v.product}`, handle: `board-${v.product}` } });
  const calls = [];
  return {
    state, calls,
    graphql: async (query, opts) => {
      calls.push({ query, opts });
      if (query.includes("mutation")) {
        for (const x of opts.variables.variants) state.get(x.id.split("/").pop()).policy = x.inventoryPolicy;
        return { json: async () => ({ data: { productVariantsBulkUpdate: { userErrors: [] } } }) };
      }
      if (query.includes("inventoryItem(")) {
        const v = [...state.values()].find((x) => `gid://shopify/InventoryItem/${x.item}` === opts.variables.id);
        return { json: async () => ({ data: { inventoryItem: { variants: { nodes: v ? [node(v)] : [] } } } }) };
      }
      return { json: async () => ({ data: { nodes: opts.variables.ids.map((id) => state.get(id.split("/").pop())).filter(Boolean).map(node) } }) };
    },
    policyChanges: () => calls.filter((c) => c.query.includes("mutation")).map((c) => c.opts.variables.variants[0].inventoryPolicy),
  };
}
const T = (s) => new Date(`${s}T12:00:00Z`);
const input = (over = {}) => ({ name: "Launch", startDate: "2026-11-01", endDate: "2026-11-10", shipDate: "2026-12-15", maxQuantity: "5", targetUnits: "", buttonText: "Reserve", showCountdown: false, showProgress: false, ...over });
let shopN = 0;
const newShop = () => `c${++shopN}.myshopify.com`;
async function launch(shop, admin, over = {}, now = T("2026-11-05"), variantIds = ["101"]) {
  const r = await saveCampaign(db, admin, shop, { input: input(over), variantIds, now });
  assert.ok(r.campaign, JSON.stringify(r.errors));
  return r.campaign;
}

test("input validation: required fields, dates, limits", () => {
  assert.ok(validateCampaignInput({}).errors.name && validateCampaignInput({}).errors.shipDate);
  assert.ok(validateCampaignInput(input({ endDate: "2026-10-01" })).errors.endDate);
  assert.ok(validateCampaignInput(input({ startDate: "2026-02-31" })).errors.startDate);
  assert.ok(validateCampaignInput(input({ maxQuantity: "0" })).errors.maxQuantity);
  assert.ok(validateCampaignInput(input({ targetUnits: "abc" })).errors.targetUnits);
  assert.ok(validateCampaignInput(input({ startDate: "", endDate: "", showCountdown: "on" })).errors.showCountdown);
  assert.ok(validateCampaignInput(input({ maxQuantity: "", targetUnits: "", showProgress: "on" })).errors.showProgress);
  assert.ok(validateCampaignInput(input({ shipDate: "2026-11-02" })).errors.shipDate, "shipping before the campaign ends is refused");
  const ok = validateCampaignInput(input());
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.value.endsAt.toISOString(), "2026-11-11T00:00:00.000Z"); // end date is inclusive
});

test("status: Draft, Scheduled, Active, Paused, Sold Out, Completed are computed from intent, dates and verified sales", () => {
  const base = { startsAt: new Date("2026-11-01T00:00:00Z"), endsAt: new Date("2026-11-11T00:00:00Z"), maxQuantity: 5 };
  const cfg = (sold = 0, reserved = 0) => [{ enabled: true, maxQuantity: null, soldCount: sold, reservedCount: reserved }];
  assert.equal(campaignStatus({ ...base, state: "DRAFT" }, cfg(), T("2026-11-05")), "DRAFT");
  assert.equal(campaignStatus({ ...base, state: "PUBLISHED" }, cfg(), T("2026-10-20")), "SCHEDULED");
  assert.equal(campaignStatus({ ...base, state: "PUBLISHED" }, cfg(), T("2026-11-05")), "ACTIVE");
  assert.equal(campaignStatus({ ...base, state: "PAUSED" }, cfg(), T("2026-11-05")), "PAUSED");
  assert.equal(campaignStatus({ ...base, state: "PUBLISHED" }, cfg(5), T("2026-11-05")), "SOLD_OUT");
  assert.equal(campaignStatus({ ...base, state: "PUBLISHED" }, cfg(1, 4), T("2026-11-05")), "ACTIVE"); // holds are not sales
  assert.equal(campaignStatus({ ...base, state: "PUBLISHED" }, cfg(), T("2026-11-11")), "COMPLETED");
  assert.equal(campaignPhase({ ...base, state: "PUBLISHED" }, new Date("2026-11-10T23:59:59Z")), "active"); // last day inclusive
});

test("creating a campaign: configs inherit dates/limit from the campaign (one source of truth) and storefront reflects it", async () => {
  const shop = newShop(); const admin = store([{ id: 101, item: 1 }, { id: 102, item: 2 }]);
  const c = await launch(shop, admin, {}, T("2026-11-05"), ["101", "102"]);
  const configs = await db.preorderConfig.findMany({ where: { shop } });
  assert.equal(configs.length, 2);
  for (const cfg of configs) { assert.equal(cfg.campaignId, c.id); assert.equal(cfg.shipDate, null); assert.equal(cfg.maxQuantity, null); assert.equal(effectiveLimit(cfg, c), 5); }
  assert.equal(c.state, "DRAFT");
  assert.deepEqual(await storefrontConfig(db, shop, "999", { now: T("2026-11-05") }), [], "drafts are never exposed");
  assert.deepEqual(await setCampaignState(db, admin, shop, c.id, "publish", T("2026-11-05")), { ok: true, state: "PUBLISHED" });
  const [a] = await storefrontConfig(db, shop, "999", { now: T("2026-11-05") });
  assert.deepEqual([a.phase, a.soldOut, a.remaining, a.shipDate, a.buttonText], ["active", false, 5, "2026-12-15", "Reserve"]);
  assert.equal(a.campaign.name, "Launch");
});

test("inventory policy follows the campaign: closed before start, open while active, closed after end/pause, restored on delete", async () => {
  const shop = newShop(); const admin = store([{ id: 101, item: 1, policy: "DENY" }]);
  const c = await launch(shop, admin);
  assert.equal(admin.state.get("101").policy, "DENY");                     // draft: not sellable
  await setCampaignState(db, admin, shop, c.id, "publish", T("2026-10-20")); // scheduled
  assert.equal(admin.state.get("101").policy, "DENY");
  await reconcileShop(db, admin, shop, T("2026-11-02"));                   // start passed, nobody touched anything
  assert.equal(admin.state.get("101").policy, "CONTINUE");
  const before = admin.calls.length;
  await reconcileShop(db, admin, shop, T("2026-11-03"));                   // nothing changed: no Shopify calls at all
  assert.equal(admin.calls.length, before);
  await setCampaignState(db, admin, shop, c.id, "pause", T("2026-11-03"));
  assert.equal(admin.state.get("101").policy, "DENY");
  await setCampaignState(db, admin, shop, c.id, "resume", T("2026-11-04"));
  assert.equal(admin.state.get("101").policy, "CONTINUE");
  await reconcileShop(db, admin, shop, T("2026-11-12"));                   // ended
  assert.equal(admin.state.get("101").policy, "DENY");
  assert.equal(await deleteCampaign(db, admin, shop, c.id), true);
  assert.equal(await db.preorderConfig.count({ where: { shop } }), 0);
  assert.equal(admin.state.get("101").policy, "DENY");                     // restored to the original policy
});

test("a variant that was originally CONTINUE gets that policy back when the campaign is deleted", async () => {
  const shop = newShop(); const admin = store([{ id: 101, item: 1, policy: "CONTINUE" }]);
  const c = await launch(shop, admin, { startDate: "2026-12-01", endDate: "2026-12-05" }, T("2026-11-05"));
  assert.equal(admin.state.get("101").policy, "DENY"); // not live yet
  await deleteCampaign(db, admin, shop, c.id);
  assert.equal(admin.state.get("101").policy, "CONTINUE");
});

test("variants already configured elsewhere, or not in this store, are refused", async () => {
  const shop = newShop(); const admin = store([{ id: 101, item: 1 }, { id: 102, item: 2 }]);
  await saveConfigs(db, admin, shop, ["101"], { shipDate: "2026-12-01", enabled: true });
  const r = await saveCampaign(db, admin, shop, { input: input(), variantIds: ["101"] });
  assert.match(r.errors.variants, /already set up/);
  const missing = await saveCampaign(db, admin, shop, { input: input(), variantIds: ["102", "555"] });
  assert.match(missing.errors.variants, /not found/);
  const c = await launch(shop, admin, {}, T("2026-11-05"), ["102"]);
  const standalone = await saveConfigs(db, admin, shop, ["102"], { shipDate: "2026-12-01", enabled: true });
  assert.match(standalone.errors.variants, /campaign/);
  assert.equal(await db.campaign.count({ where: { shop } }), 1);
  assert.ok(c);
});

test("concurrent reservations can never exceed the limit (20 simultaneous requests, limit 5)", async () => {
  const shop = newShop(); const admin = store([{ id: 101, item: 1 }]);
  const c = await launch(shop, admin);
  await setCampaignState(db, admin, shop, c.id, "publish", T("2026-11-05"));
  const results = await Promise.all(Array.from({ length: 20 }, () => reserve(db, { shop, variantId: "101", quantity: 1, now: T("2026-11-05") })));
  assert.equal(results.filter((r) => r.ok).length, 5);
  assert.equal(results.filter((r) => !r.ok && ["limit", "sold_out"].includes(r.error)).length, 15); // late arrivals see sold_out
  const cfg = await db.preorderConfig.findFirst({ where: { shop } });
  assert.equal(cfg.reservedCount, 5);
  assert.equal(await db.preorderReservation.count({ where: { shop, status: "HELD" } }), 5);
  assert.equal((await storefrontConfig(db, shop, "999", { now: T("2026-11-05") }))[0].phase, "sold_out");
});

test("concurrent reservations of mixed sizes stay within the limit", async () => {
  const shop = newShop(); const admin = store([{ id: 101, item: 1 }]);
  const c = await launch(shop, admin, { maxQuantity: "10" });
  await setCampaignState(db, admin, shop, c.id, "publish", T("2026-11-05"));
  const sizes = [3, 2, 4, 1, 5, 2, 3, 1, 2, 4, 1, 3];
  const results = await Promise.all(sizes.map((q) => reserve(db, { shop, variantId: "101", quantity: q, now: T("2026-11-05") })));
  const held = results.filter((r) => r.ok).reduce((a, r, i) => a + sizes[results.indexOf(r)], 0);
  const cfg = await db.preorderConfig.findFirst({ where: { shop } });
  assert.ok(cfg.reservedCount <= 10 && cfg.reservedCount === held, `held ${held}, counter ${cfg.reservedCount}`);
  assert.equal((await db.preorderReservation.aggregate({ where: { shop, status: "HELD" }, _sum: { quantity: true } }))._sum.quantity, cfg.reservedCount);
});

test("holds: release and expiry give units back; sales seen in inventory settle holds exactly once", async () => {
  const shop = newShop(); const admin = store([{ id: 101, item: 1, qty: 0, policy: "CONTINUE" }]);
  const c = await launch(shop, admin);
  await setCampaignState(db, admin, shop, c.id, "publish", T("2026-11-05"));
  const now = T("2026-11-05");
  const a = await reserve(db, { shop, variantId: "101", quantity: 2, now });
  const b = await reserve(db, { shop, variantId: "101", quantity: 2, now });
  const cfgId = (await db.preorderConfig.findFirst({ where: { shop } })).id;
  const held = async () => (await db.preorderConfig.findUnique({ where: { id: cfgId } })).reservedCount;
  assert.equal(await held(), 4);
  assert.equal(await releaseReservation(db, shop, a.reservationId, now), true);
  assert.equal(await releaseReservation(db, shop, a.reservationId, now), false);   // idempotent: no double give-back
  assert.equal(await releaseReservation(db, "other.myshopify.com", b.reservationId, now), false); // other shop cannot release
  assert.equal(await held(), 2);
  // inventory shows 2 units sold -> b converts (so it stops counting as both a hold and a sale)
  admin.state.get("101").qty = -2; admin.state.get("101").item = 1;
  await handleInventoryLevelUpdate({ db, shop, webhookId: "w1", payload: { inventory_item_id: 1, available: -2 }, admin, mailer: null, schedule: () => {} });
  assert.equal(await held(), 0);
  assert.equal((await db.preorderReservation.findUnique({ where: { id: b.reservationId } })).status, "CONVERTED");
  const cfg = await db.preorderConfig.findUnique({ where: { id: cfgId } });
  assert.equal(cfg.soldCount, 2);
  // a fresh hold that is never used expires
  const d = await reserve(db, { shop, variantId: "101", quantity: 1, now });
  assert.equal(await expireHolds(db, shop, cfgId, new Date(now.getTime() + 16 * 60_000)), 1);
  assert.equal(await held(), 0); assert.ok(d.ok);
});

test("quantity errors report what is left; nothing is held on failure", async () => {
  const shop = newShop(); const admin = store([{ id: 101, item: 1 }]);
  const c = await launch(shop, admin, { maxQuantity: "3" });
  await setCampaignState(db, admin, shop, c.id, "publish", T("2026-11-05"));
  const now = T("2026-11-05");
  assert.equal((await reserve(db, { shop, variantId: "101", quantity: 0, now })).error, "invalid_quantity");
  assert.equal((await reserve(db, { shop, variantId: "101", quantity: 11, now })).error, "invalid_quantity");
  const big = await reserve(db, { shop, variantId: "101", quantity: 4, now });
  assert.deepEqual([big.error, big.remaining], ["limit", 3]);
  assert.equal((await db.preorderConfig.findFirst({ where: { shop } })).reservedCount, 0);
  assert.equal((await reserve(db, { shop, variantId: "999999", quantity: 1, now })).error, "not_configured");
});

test("closed campaigns refuse reservations: before start, after end, paused, draft", async () => {
  const shop = newShop(); const admin = store([{ id: 101, item: 1 }]);
  const c = await launch(shop, admin);
  const r = (now) => reserve(db, { shop, variantId: "101", quantity: 1, now });
  assert.equal((await r(T("2026-11-05"))).error, "closed");                // draft
  await setCampaignState(db, admin, shop, c.id, "publish", T("2026-11-05"));
  assert.equal((await r(T("2026-10-30"))).error, "closed");                // scheduled
  assert.equal((await r(T("2026-11-05"))).ok, true);                       // active
  assert.equal((await r(T("2026-11-12"))).error, "closed");                // ended
  assert.equal((await storefrontConfig(db, shop, "999", { now: T("2026-11-12") }))[0].phase, "ended");
  await setCampaignState(db, admin, shop, c.id, "pause", T("2026-11-05"));
  assert.equal((await r(T("2026-11-05"))).error, "closed");                // paused
  assert.equal((await storefrontConfig(db, shop, "999", { now: T("2026-11-05") }))[0].phase, "paused");
});

test("reaching the limit closes selling (policy DENY) and the campaign shows Sold Out; waitlist signups are then accepted", async () => {
  const shop = newShop(); const admin = store([{ id: 101, item: 1, policy: "DENY" }]);
  const c = await launch(shop, admin, { maxQuantity: "3" });
  await setCampaignState(db, admin, shop, c.id, "publish", T("2026-11-05"));
  assert.equal(admin.state.get("101").policy, "CONTINUE");
  admin.state.get("101").qty = -3;
  await handleInventoryLevelUpdate({ db, shop, webhookId: "so1", payload: { inventory_item_id: 1, available: -3 }, admin, mailer: null, schedule: () => {} });
  assert.equal(admin.state.get("101").policy, "DENY");
  const [row] = await listCampaigns(db, shop, T("2026-11-05"));
  assert.equal(row.status, "SOLD_OUT"); assert.equal(row.sold, 3);
  const cfg = (await storefrontConfig(db, shop, "999", { now: T("2026-11-05") }))[0];
  assert.deepEqual([cfg.phase, cfg.soldOut, cfg.remaining], ["sold_out", true, 0]);
  // the waitlist fallback: the variant is still out of stock, so signups are accepted
  const res = await handleSignupRequest({ db, admin, shop, input: { email: "late@x.com", productId: "999", variantId: "101" } });
  assert.equal(res.status, 200);
});

test("campaign end does NOT trigger restock emails; only a real inventory increase does", async () => {
  const shop = newShop(); const admin = store([{ id: 101, item: 1, qty: -2, policy: "CONTINUE" }]);
  const mailer = fakeMailer();
  const c = await launch(shop, admin, {}, T("2026-11-05"));
  await setCampaignState(db, admin, shop, c.id, "publish", T("2026-11-05"));
  await handleSignupRequest({ db, admin, shop, input: { email: "wait@x.com", productId: "999", variantId: "101" } });
  await reconcileShop(db, admin, shop, T("2026-11-12")); // campaign ended
  await handleInventoryLevelUpdate({ db, shop, webhookId: "end1", payload: { inventory_item_id: 1, available: -2 }, admin, mailer, schedule: () => {} });
  assert.equal(mailer.sent.length, 0);
  assert.equal(await db.notificationDelivery.count({ where: { shop } }), 0);
  assert.equal(await db.restockEvent.count({ where: { shop } }), 0);
  admin.state.get("101").qty = 6; // real restock
  await handleInventoryLevelUpdate({ db, shop, webhookId: "end2", payload: { inventory_item_id: 1, available: 6 }, admin, mailer, schedule: () => {} });
  assert.equal(mailer.sent.length, 1);
});

test("a standalone (non-campaign) pre-order is limited by the same atomic reservations", async () => {
  const shop = newShop(); const admin = store([{ id: 101, item: 1 }]);
  await saveConfigs(db, admin, shop, ["101"], { shipDate: "2026-12-01", maxQuantity: "2", enabled: true });
  const rs = await Promise.all([1, 2, 3, 4].map(() => reserve(db, { shop, variantId: "101", quantity: 1 })));
  assert.equal(rs.filter((r) => r.ok).length, 2);
});

test("no limit: nothing is reserved (there is nothing to protect)", async () => {
  const shop = newShop(); const admin = store([{ id: 101, item: 1 }]);
  await saveConfigs(db, admin, shop, ["101"], { shipDate: "2026-12-01", enabled: true });
  const r = await reserve(db, { shop, variantId: "101", quantity: 3 });
  assert.deepEqual([r.ok, r.limited, r.remaining], [true, false, null]);
  assert.equal(await db.preorderReservation.count({ where: { shop } }), 0);
});

test("progress uses verified sold units only (never holds); countdown/progress flags reach the storefront", async () => {
  const shop = newShop(); const admin = store([{ id: 101, item: 1, qty: -2, policy: "CONTINUE" }]);
  const c = await launch(shop, admin, { maxQuantity: "10", targetUnits: "8", showCountdown: "on", showProgress: "on" }, T("2026-11-05"));
  await setCampaignState(db, admin, shop, c.id, "publish", T("2026-11-05"));
  await reserve(db, { shop, variantId: "101", quantity: 3, now: T("2026-11-05") });
  const [cfg] = await storefrontConfig(db, shop, "999", { now: T("2026-11-05") });
  assert.deepEqual(cfg.campaign.progress, { sold: 2, target: 8 });
  assert.equal(cfg.campaign.countdown, true);
  assert.equal(cfg.campaign.endsAt, "2026-11-11T00:00:00.000Z");
  assert.equal(cfg.remaining, 5); // 10 - 2 sold - 3 held
  const off = await launch(newShop(), store([{ id: 101, item: 1 }]), { showProgress: "" });
  assert.ok(off);
});

test("shop isolation: another shop cannot change, pause, delete or list a campaign", async () => {
  const shop = newShop(); const admin = store([{ id: 101, item: 1 }]);
  const c = await launch(shop, admin);
  assert.ok((await setCampaignState(db, admin, "evil.myshopify.com", c.id, "publish")).errors);
  assert.equal(await deleteCampaign(db, admin, "evil.myshopify.com", c.id), false);
  assert.ok((await saveCampaign(db, admin, "evil.myshopify.com", { id: c.id, input: input(), variantIds: ["101"] })).errors.form);
  assert.deepEqual(await listCampaigns(db, "evil.myshopify.com"), []);
  assert.ok(await db.campaign.findUnique({ where: { id: c.id } }));
});

test("publishing requires variants and a ship date; editing a live campaign re-applies its rules", async () => {
  const shop = newShop(); const admin = store([{ id: 101, item: 1 }]);
  const c = await launch(shop, admin);
  await db.campaign.update({ where: { id: c.id }, data: { shipDate: null } });
  assert.match((await setCampaignState(db, admin, shop, c.id, "publish")).errors.form, /shipping date/);
  await db.campaign.update({ where: { id: c.id }, data: { shipDate: T("2026-12-15") } });
  await setCampaignState(db, admin, shop, c.id, "publish", T("2026-11-05"));
  assert.equal(admin.state.get("101").policy, "CONTINUE");
  // the merchant moves the end date into the past: selling closes immediately
  await saveCampaign(db, admin, shop, { id: c.id, input: input({ startDate: "2026-10-01", endDate: "2026-10-02", shipDate: "2026-12-15" }), variantIds: [], now: T("2026-11-05") });
  assert.equal(admin.state.get("101").policy, "DENY");
});

test("reserve endpoint: validates the product/variant pair and returns merchant-friendly messages", async () => {
  const shop = newShop(); const admin = store([{ id: 101, item: 1 }]);
  const c = await launch(shop, admin, { maxQuantity: "2" });
  await setCampaignState(db, admin, shop, c.id, "publish", T("2026-11-05"));
  const now = T("2026-11-05");
  assert.equal((await handleReserveRequest({ db, shop, input: { variantId: "101", productId: "123", quantity: 1 }, now })).status, 409); // wrong product
  assert.equal((await handleReserveRequest({ db, shop: "x.myshopify.com", input: { variantId: "101", productId: "999", quantity: 1 }, now })).body.error, "not_configured"); // other shop
  assert.equal((await handleReserveRequest({ db, shop, input: { variantId: "abc", productId: "999", quantity: 1 }, now })).status, 422);
  const ok = await handleReserveRequest({ db, shop, input: { variantId: "gid://shopify/ProductVariant/101", productId: "999", quantity: 2 }, now });
  assert.equal(ok.status, 200); assert.equal(ok.body.remaining, 0); assert.ok(ok.body.reservationId);
  const full = await handleReserveRequest({ db, shop, input: { variantId: "101", productId: "999", quantity: 1 }, now });
  assert.deepEqual([full.status, full.body.error, full.body.message], [409, "sold_out", "Sorry, this item is no longer available for pre-order."]);
  const rel = await handleReserveRequest({ db, shop, input: { intent: "release", reservationId: ok.body.reservationId }, now });
  assert.equal(rel.body.released, true);
  assert.equal((await handleReserveRequest({ db, shop, input: { variantId: "101", productId: "999", quantity: 1 }, now })).status, 200);
});

test("reserve endpoint: require-login setting refuses guests (no hold), admits customers, never blocks release", async () => {
  const shop = newShop(); const admin = store([{ id: 101, item: 1 }]);
  const c = await launch(shop, admin, { maxQuantity: "5" });
  await setCampaignState(db, admin, shop, c.id, "publish", T("2026-11-05"));
  const now = T("2026-11-05");
  const req = { variantId: "101", productId: "999", quantity: 1 };
  const held = async () => (await db.preorderConfig.findFirst({ where: { shop, variantId: "101" } })).reservedCount;
  // default (no settings row): guests pre-order as before
  assert.equal((await handleReserveRequest({ db, shop, input: req, now })).status, 200);
  await db.shopSettings.upsert({ where: { shop }, create: { shop, requirePreorderLogin: false }, update: { requirePreorderLogin: false } });
  assert.equal((await handleReserveRequest({ db, shop, input: req, now })).status, 200);
  assert.equal(await held(), 2);
  await db.shopSettings.update({ where: { shop }, data: { requirePreorderLogin: true } });
  const guest = await handleReserveRequest({ db, shop, input: req, now });
  assert.deepEqual([guest.status, guest.body.ok, guest.body.error], [401, false, "login_required"]);
  assert.equal(await held(), 2, "a refused guest must not take a hold");
  const member = await handleReserveRequest({ db, shop, input: req, loggedInCustomerId: "8123", now });
  assert.equal(member.status, 200); assert.equal(await held(), 3);
  const rel = await handleReserveRequest({ db, shop, input: { intent: "release", reservationId: member.body.reservationId }, now });
  assert.equal(rel.body.released, true); assert.equal(await held(), 2);
  // another shop's setting does not leak
  const other = newShop();
  await db.shopSettings.create({ data: { shop: other, requirePreorderLogin: true } });
  assert.equal((await handleReserveRequest({ db, shop, input: req, loggedInCustomerId: "1", now })).status, 200);
});

test("pure rules: effective limit/phase/desiredOpen", () => {
  const camp = { state: "PUBLISHED", startsAt: null, endsAt: null, maxQuantity: 4 };
  assert.equal(effectiveLimit({ maxQuantity: 9 }, camp), 9); // a variant override beats the campaign default
  assert.equal(effectiveLimit({ maxQuantity: null }, camp), 4);
  assert.equal(effectiveLimit({ maxQuantity: null }, null), null);
  const cfg = { enabled: true, maxQuantity: null, soldCount: 3, reservedCount: 1 };
  assert.equal(variantPhase(cfg, camp), "sold_out");                         // 3 sold + 1 held = limit
  assert.equal(desiredOpen(cfg, camp, new Date()), true);                    // but selling stays open: the holder must be able to check out
  assert.equal(desiredOpen({ ...cfg, soldCount: 4 }, camp, new Date()), false);
  assert.equal(variantPhase({ ...cfg, enabled: false }, camp), "disabled");
});
