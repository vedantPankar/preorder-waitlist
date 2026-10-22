import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, fakeAdmin } from "./helpers.mjs";
import { isPreorderEligible, validateConfigInput, storefrontConfig, saveConfigs, removeConfig, setEnabled, backorderedUnits } from "../app/lib/preorder.server.js";
import { handleInventoryLevelUpdate } from "../app/lib/webhooks.server.js";

let db;
before(async () => { db = await createTestDb(); });

test("eligibility rules", () => {
  const cfg = { enabled: true, maxQuantity: 5 };
  assert.ok(isPreorderEligible(cfg, { sold: 4, inventoryQuantity: 0 }));
  assert.ok(!isPreorderEligible(cfg, { sold: 5, inventoryQuantity: 0 }));
  assert.ok(!isPreorderEligible(cfg, { sold: 0, inventoryQuantity: 3 }));
  assert.ok(!isPreorderEligible({ ...cfg, enabled: false }, {}));
  assert.ok(!isPreorderEligible(null, {}));
  assert.ok(isPreorderEligible({ enabled: true, maxQuantity: null }, { sold: 9999 }));
});

test("config validation", () => {
  assert.ok(validateConfigInput({ shipDate: "" }).errors.shipDate);
  assert.ok(validateConfigInput({ shipDate: "2026-02-31" }).errors.shipDate);
  assert.ok(validateConfigInput({ shipDate: "2026-12-01", maxQuantity: "-2" }).errors.maxQuantity);
  const ok = validateConfigInput({ shipDate: "2026-12-01", maxQuantity: "10", buttonText: "  Reserve " });
  assert.deepEqual(ok.errors, {}); assert.equal(ok.value.buttonText, "Reserve"); assert.equal(ok.value.maxQuantity, 10);
});

const shop = "po.myshopify.com";
const node = (policy, qty) => ({ id: "gid://shopify/ProductVariant/111", title: "Red", inventoryQuantity: qty, inventoryPolicy: policy, product: { id: "gid://shopify/Product/999", title: "Shoe", handle: "shoe" } });
const mkAdmin = (policy = "DENY", qty = 0) => fakeAdmin((q) =>
  q.includes("mutation") ? { data: { productVariantsBulkUpdate: { userErrors: [] } } }
    : q.includes("inventoryItem(") ? { data: { inventoryItem: { variants: { nodes: [node(policy, qty)] } } } }
      : { data: { nodes: [node(policy, qty)] } });
const policies = (a) => a.calls.filter((c) => c.query.includes("mutation")).map((c) => c.opts.variables.variants[0].inventoryPolicy);
const inv = (db_, s, admin, id, qty) => handleInventoryLevelUpdate({ db: db_, shop: s, webhookId: id, payload: { inventory_item_id: 1, available: qty }, admin, mailer: null, schedule: () => {} });

test("backordered units are negative stock", () => {
  assert.equal(backorderedUnits(-3), 3); assert.equal(backorderedUnits(0), 0); assert.equal(backorderedUnits(5), 0);
});

test("saving config enables overselling and remembers previous policy; disabling restores it", async () => {
  const admin = mkAdmin("DENY");
  const r = await saveConfigs(db, admin, shop, ["111"], { shipDate: "2026-12-01", maxQuantity: "3", enabled: true });
  assert.equal(r.saved, 1);
  assert.deepEqual(policies(admin), ["CONTINUE"]);
  const cfg = await db.preorderConfig.findFirst({ where: { shop } });
  assert.equal(cfg.previousInventoryPolicy, "DENY");
  await setEnabled(db, admin, shop, cfg.id, false);
  assert.deepEqual(policies(admin), ["CONTINUE", "DENY"]);
});

test("saving requires a ship date and reports errors without touching Shopify", async () => {
  const admin = mkAdmin();
  const r = await saveConfigs(db, admin, shop, ["111"], { shipDate: "" });
  assert.ok(r.errors.shipDate); assert.equal(admin.calls.length, 0);
});

test("limit is derived from inventory: counts every sale (even bypassing the block) and closes at the limit", async () => {
  const s = "po2.myshopify.com";
  await saveConfigs(db, mkAdmin(), s, ["111"], { shipDate: "2026-12-01", maxQuantity: "3", enabled: true });
  let admin = mkAdmin("CONTINUE", -2);
  await inv(db, s, admin, "e1", -2);
  let [c] = await storefrontConfig(db, s, "999");
  assert.equal(c.remaining, 1); assert.equal(c.soldOut, false);
  assert.deepEqual(policies(admin), []);
  // duplicate delivery is ignored
  await inv(db, s, admin, "e1", -2);
  assert.equal(admin.calls.length, 1, "duplicate webhook must not call Shopify again");
  admin = mkAdmin("CONTINUE", -3);
  await inv(db, s, admin, "e2", -3);
  [c] = await storefrontConfig(db, s, "999");
  assert.equal(c.remaining, 0); assert.equal(c.soldOut, true);
  assert.deepEqual(policies(admin), ["DENY"]);
  // stock arrives -> quota frees up (counter follows inventory)
  await inv(db, s, mkAdmin("DENY", 4), "e3", 4);
  [c] = await storefrontConfig(db, s, "999");
  assert.equal(c.remaining, 3);
});

test("out-of-stock webhooks for shops without pre-orders make no API calls", async () => {
  const admin = mkAdmin("DENY", 0);
  await inv(db, "nopre.myshopify.com", admin, "x1", 0);
  assert.equal(admin.calls.length, 0);
});

test("re-enabling after the limit closed re-opens selling only if quota remains", async () => {
  const s = "reopen.myshopify.com";
  await saveConfigs(db, mkAdmin(), s, ["111"], { shipDate: "2026-12-01", maxQuantity: "1", enabled: true });
  await inv(db, s, mkAdmin("CONTINUE", -1), "r1", -1);
  const cfg = await db.preorderConfig.findFirst({ where: { shop: s } });
  await setEnabled(db, mkAdmin("DENY", -1), s, cfg.id, false);
  const sold = mkAdmin("DENY", -1);
  await setEnabled(db, sold, s, cfg.id, true);
  assert.deepEqual(policies(sold), [], "limit reached: must not switch to CONTINUE");
  const raised = mkAdmin("DENY", -1);
  await saveConfigs(db, raised, s, ["111"], { shipDate: "2026-12-01", maxQuantity: "5", enabled: true });
  assert.deepEqual(policies(raised), ["CONTINUE"]);
  await db.preorderConfig.updateMany({ where: { shop: s }, data: { enabled: false } });
  const again = mkAdmin("DENY", -1);
  await setEnabled(db, again, s, cfg.id, true);
  assert.deepEqual(policies(again), ["CONTINUE"]);
});

test("shop isolation: other shops see no config and cannot modify it", async () => {
  assert.deepEqual(await storefrontConfig(db, "other.myshopify.com", "999"), []);
  const cfg = await db.preorderConfig.findFirst({ where: { shop: "po2.myshopify.com" } });
  assert.equal(await removeConfig(db, mkAdmin(), "other.myshopify.com", cfg.id), false);
  assert.equal(await setEnabled(db, mkAdmin(), "other.myshopify.com", cfg.id, false), false);
  assert.ok(await db.preorderConfig.findUnique({ where: { id: cfg.id } }));
});
