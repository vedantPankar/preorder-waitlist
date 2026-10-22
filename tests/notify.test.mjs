import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, variant, fakeMailer, fakeAdmin } from "./helpers.mjs";
import { addSignup } from "../app/lib/waitlist.server.js";
import { notifyVariant, retryFailedDeliveries } from "../app/lib/notify.server.js";
import { handleInventoryLevelUpdate, handleCustomerRedact, handleShopRedact } from "../app/lib/webhooks.server.js";

let db;
before(async () => { db = await createTestDb(); });
const stocked = variant({ inventoryQuantity: 4 });
const statuses = async (shop) => (await db.waitlistEntry.findMany({ where: { shop }, orderBy: { email: "asc" } })).map((e) => e.status);

test("sends once and marks NOTIFIED; second run sends nothing", async () => {
  const shop = "n1.myshopify.com";
  await addSignup(db, { shop, email: "a@x.com", variant: variant() });
  const mailer = fakeMailer();
  const first = await notifyVariant(db, { shop, variant: stocked, mailer });
  const second = await notifyVariant(db, { shop, variant: stocked, mailer });
  assert.equal(first.sent, 1); assert.equal(second.sent, 0);
  assert.equal(mailer.sent.length, 1);
  assert.deepEqual(await statuses(shop), ["NOTIFIED"]);
});

test("concurrent notifications never double-send", async () => {
  const shop = "n2.myshopify.com";
  await addSignup(db, { shop, email: "a@x.com", variant: variant() });
  const mailer = fakeMailer();
  await Promise.all([1, 2, 3].map(() => notifyVariant(db, { shop, variant: stocked, mailer })));
  assert.equal(mailer.sent.length, 1);
});

test("no mailer: reports not operational and does NOT mark sent", async () => {
  const shop = "n3.myshopify.com";
  await addSignup(db, { shop, email: "a@x.com", variant: variant() });
  const r = await notifyVariant(db, { shop, variant: stocked, mailer: null });
  assert.equal(r.operational, false); assert.equal(r.reason, "email_not_configured");
  assert.deepEqual(await statuses(shop), ["ACTIVE"]);
  assert.equal((await db.shopSettings.findUnique({ where: { shop } })).lastNotifyError, "EMAIL_NOT_CONFIGURED");
});

test("provider failure -> backoff retries, then FAILED with a generic error; admin retry succeeds", async () => {
  const shop = "n4.myshopify.com";
  await addSignup(db, { shop, email: "secret@x.com", variant: variant() });
  const bad = fakeMailer({ fail: true });
  let now = new Date();
  const first = await notifyVariant(db, { shop, variant: stocked, mailer: bad, now });
  assert.equal(first.sent, 0);
  let d = await db.notificationDelivery.findFirst({ where: { shop } });
  assert.equal(d.status, "QUEUED"); assert.equal(d.attempts, 1);          // transient failure -> re-queued
  assert.ok(d.nextAttemptAt.getTime() >= now.getTime() + 60_000);          // with backoff
  // too early: nothing is attempted again
  await notifyVariant(db, { shop, variant: stocked, mailer: bad, now: new Date(now.getTime() + 1000) });
  assert.equal((await db.notificationDelivery.findFirst({ where: { shop } })).attempts, 1);
  for (const mins of [2, 10, 60]) { now = new Date(now.getTime() + mins * 60_000); await notifyVariant(db, { shop, variant: stocked, mailer: bad, now }); }
  d = await db.notificationDelivery.findFirst({ where: { shop } });
  assert.equal(d.status, "FAILED"); assert.equal(d.attempts, 3);
  const entry = await db.waitlistEntry.findFirst({ where: { shop } });
  assert.equal(entry.status, "FAILED"); assert.ok(!entry.lastError.includes("secret@x.com"));
  assert.equal(await db.notificationAttempt.count({ where: { shop, outcome: "FAILED" } }), 3);
  // merchant retry re-queues it; a working provider then succeeds
  assert.equal(await retryFailedDeliveries(db, shop, { now }), 1);
  const good = fakeMailer();
  await notifyVariant(db, { shop, variant: stocked, mailer: good, now });
  assert.deepEqual(await statuses(shop), ["NOTIFIED"]);
  assert.equal((await db.notificationDelivery.findFirst({ where: { shop } })).status, "ACCEPTED");
});

test("stale SENDING claims are recovered; fresh ones are not", async () => {
  const shop = "n5.myshopify.com";
  await addSignup(db, { shop, email: "a@x.com", variant: variant() });
  await db.waitlistEntry.updateMany({ where: { shop }, data: { status: "SENDING", sendingSince: new Date() } });
  const mailer = fakeMailer();
  await notifyVariant(db, { shop, variant: stocked, mailer });
  assert.equal(mailer.sent.length, 0);
  await db.waitlistEntry.updateMany({ where: { shop }, data: { sendingSince: new Date(Date.now() - 3600_000) } });
  await notifyVariant(db, { shop, variant: stocked, mailer });
  assert.equal(mailer.sent.length, 1);
});

test("out-of-stock variant sends nothing; other shops are untouched", async () => {
  await addSignup(db, { shop: "n6.myshopify.com", email: "a@x.com", variant: variant() });
  await addSignup(db, { shop: "n7.myshopify.com", email: "a@x.com", variant: variant() });
  const mailer = fakeMailer();
  assert.equal((await notifyVariant(db, { shop: "n6.myshopify.com", variant: variant(), mailer })).reason, "not_in_stock");
  await notifyVariant(db, { shop: "n6.myshopify.com", variant: stocked, mailer });
  assert.deepEqual(await statuses("n7.myshopify.com"), ["ACTIVE"]);
});

test("duplicate webhook delivery is processed once", async () => {
  const shop = "w1.myshopify.com";
  await addSignup(db, { shop, email: "a@x.com", variant: variant() });
  const admin = fakeAdmin(() => ({ data: { inventoryItem: { variants: { nodes: [{ id: "gid://shopify/ProductVariant/111", title: "Red", inventoryQuantity: 4, inventoryPolicy: "DENY", product: { id: "gid://shopify/Product/999", title: "Shoe", handle: "shoe" } }] } } } }));
  const mailer = fakeMailer();
  const args = { db, shop, webhookId: "evt-1", payload: { inventory_item_id: 5, available: 4 }, admin, mailer };
  await handleInventoryLevelUpdate(args);
  const dup = await handleInventoryLevelUpdate(args);
  assert.equal(dup.duplicate, true);
  assert.equal(mailer.sent.length, 1);
  assert.equal(admin.calls.length, 1);
});

test("privacy webhooks delete data only for the right customer/shop", async () => {
  const shop = "p1.myshopify.com";
  await addSignup(db, { shop, email: "gone@x.com", variant: variant() });
  await addSignup(db, { shop, email: "stay@x.com", variant: variant() });
  await addSignup(db, { shop: "p2.myshopify.com", email: "gone@x.com", variant: variant() });
  await handleCustomerRedact({ db, shop, payload: { customer: { email: "Gone@x.com" } } });
  assert.deepEqual(await statuses(shop), ["ACTIVE"]);
  assert.equal(await db.waitlistEntry.count({ where: { shop: "p2.myshopify.com" } }), 1);
  await handleShopRedact({ db, shop });
  assert.equal(await db.waitlistEntry.count({ where: { shop } }), 0);
  assert.equal(await db.waitlistEntry.count({ where: { shop: "p2.myshopify.com" } }), 1);
});
