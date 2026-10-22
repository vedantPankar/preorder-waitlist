import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, fakeAdmin, fakeMailer, variant } from "./helpers.mjs";
import { addSignup } from "../app/lib/waitlist.server.js";
import { buildEmail, enqueueRestock, notificationMetrics, notifyVariant, processQueue, recordClick, retryFailedDeliveries } from "../app/lib/notify.server.js";
import { getMailer, getMailerStatus, parseSender } from "../app/lib/mailer.server.js";
import { handleCustomerRedact, handleInventoryLevelUpdate, handleShopRedact } from "../app/lib/webhooks.server.js";
import { runQueueForShop, shopsWithDueWork } from "../app/lib/queue-runner.server.js";

let db;
before(async () => { db = await createTestDb(); });
const stocked = (over = {}) => variant({ inventoryQuantity: 5, ...over });
const invAdmin = (qty, variantNum = 111) => fakeAdmin(() => ({ data: { inventoryItem: { variants: { nodes: [{ id: `gid://shopify/ProductVariant/${variantNum}`, title: "Red", inventoryQuantity: qty, inventoryPolicy: "DENY", product: { id: "gid://shopify/Product/999", title: "Shoe", handle: "shoe" } }] } } } }));
const seed = async (shop, n, over = {}) => {
  const v = variant(over);
  await db.waitlistEntry.createMany({ data: Array.from({ length: n }, (_, i) => ({ shop, email: `u${i}@x.com`, productId: v.productId, variantId: v.variantId, productTitle: v.productTitle, variantTitle: v.variantTitle, productHandle: v.productHandle })) });
};
const emailsOf = (mailer) => mailer.sent.map((m) => m.to);

test("waitlists larger than 500 are fully processed in batches, each customer exactly once", async () => {
  const shop = "q-big.myshopify.com";
  await seed(shop, 650);
  const mailer = fakeMailer();
  // first pass is deliberately cut short (on a slow host it may send nothing at all): the rest must remain queued/waiting, not be dropped
  const first = await notifyVariant(db, { shop, variant: stocked(), mailer, budgetMs: 150, batch: 100, concurrency: 10 });
  assert.ok(first.sent < 650 && first.remaining === 650 - first.sent, `partial: sent ${first.sent}, remaining ${first.remaining}`);
  const second = await notifyVariant(db, { shop, variant: stocked(), mailer, budgetMs: 120_000, batch: 100, concurrency: 10 });
  assert.equal(second.remaining, 0);
  assert.equal(mailer.sent.length, 650);
  assert.equal(new Set(emailsOf(mailer)).size, 650);
  assert.equal(await db.waitlistEntry.count({ where: { shop, status: "NOTIFIED" } }), 650);
  assert.equal(await db.notificationDelivery.count({ where: { shop, status: "ACCEPTED" } }), 650);
  assert.equal(await db.restockEvent.count({ where: { shop, status: "COMPLETE" } }), 1);
});

test("enqueue is idempotent: running it twice (duplicate webhook / concurrent workers) creates one delivery per entry", async () => {
  const shop = "q-idem.myshopify.com";
  await seed(shop, 12);
  const results = await Promise.all([1, 2, 3, 4].map(() => enqueueRestock(db, { shop, variant: stocked(), limit: 100 })));
  assert.equal(results.reduce((a, r) => a + r.queued, 0), 12);
  assert.equal(await db.notificationDelivery.count({ where: { shop } }), 12);
  assert.equal(await db.restockEvent.count({ where: { shop, status: "OPEN" } }), 1);
  assert.equal((await enqueueRestock(db, { shop, variant: stocked() })).queued, 0);
});

test("restart recovery: a crashed worker's expired lease is re-sent; a live lease is left alone", async () => {
  const shop = "q-crash.myshopify.com";
  await seed(shop, 2);
  await enqueueRestock(db, { shop, variant: stocked() });
  const [a, b] = await db.notificationDelivery.findMany({ where: { shop }, orderBy: { id: "asc" } });
  const now = new Date();
  // worker A died mid-send long ago; worker B is still sending right now
  await db.notificationDelivery.update({ where: { id: a.id }, data: { status: "SENDING", attempts: 1, lockedUntil: new Date(now.getTime() - 60_000) } });
  await db.notificationDelivery.update({ where: { id: b.id }, data: { status: "SENDING", attempts: 1, lockedUntil: new Date(now.getTime() + 60_000) } });
  const mailer = fakeMailer();
  const r = await processQueue(db, { shop, mailer, stockCheck: async () => stocked(), now });
  assert.equal(r.sent, 1);
  assert.equal((await db.notificationDelivery.findUnique({ where: { id: a.id } })).status, "ACCEPTED");
  assert.equal((await db.notificationDelivery.findUnique({ where: { id: b.id } })).status, "SENDING");
});

test("a resumed run after a restart finishes only what is left", async () => {
  const shop = "q-resume.myshopify.com";
  await seed(shop, 30);
  const m1 = fakeMailer(); const m2 = fakeMailer();
  await notifyVariant(db, { shop, variant: stocked(), mailer: m1, budgetMs: 0 }); // "process died" right after enqueue work
  const r = await notifyVariant(db, { shop, variant: stocked(), mailer: m2, budgetMs: 60_000 });
  assert.equal(r.remaining, 0);
  assert.equal(new Set([...emailsOf(m1), ...emailsOf(m2)]).size, 30);
  assert.equal(m1.sent.length + m2.sent.length, 30);
});

test("only the restocked variant's subscribers are notified; other variants/products/shops are untouched", async () => {
  const shop = "q-match.myshopify.com";
  await seed(shop, 2, { variantId: "111" });
  await seed(shop, 3, { variantId: "222", variantTitle: "Blue" });
  await seed(shop, 1, { variantId: "333", productId: "888", productTitle: "Hat" });
  await seed("q-other.myshopify.com", 2, { variantId: "111" });
  const mailer = fakeMailer();
  await notifyVariant(db, { shop, variant: stocked({ variantId: "111" }), mailer });
  assert.equal(mailer.sent.length, 2);
  assert.equal(await db.waitlistEntry.count({ where: { shop, variantId: "222", status: "ACTIVE" } }), 3);
  assert.equal(await db.waitlistEntry.count({ where: { shop, variantId: "333", status: "ACTIVE" } }), 1);
  assert.equal(await db.waitlistEntry.count({ where: { shop: "q-other.myshopify.com", status: "ACTIVE" } }), 2);
  assert.ok(mailer.sent[0].subject.includes("Shoe"));
});

test("repeated inventory changes and duplicate webhooks never re-email the same customers", async () => {
  const shop = "q-multi.myshopify.com";
  await seed(shop, 3);
  const mailer = fakeMailer();
  const hook = (id, qty) => handleInventoryLevelUpdate({ db, shop, webhookId: id, payload: { inventory_item_id: 5, available: qty }, admin: invAdmin(qty), mailer });
  await hook("e1", 5);
  assert.equal((await hook("e1", 5)).duplicate, true);           // Shopify retry of the same delivery
  await hook("e2", 9); await hook("e3", 2); await hook("e4", 7);   // stock wobbles upward/downward
  assert.equal(mailer.sent.length, 3);
  await hook("e5", 0);                                             // sells out again: nothing sent
  // two NEW customers join while sold out, then the next restock reaches only them
  await addSignup(db, { shop, email: "new1@x.com", variant: variant() });
  await addSignup(db, { shop, email: "new2@x.com", variant: variant() });
  await hook("e6", 4);
  assert.equal(mailer.sent.length, 5);
  assert.deepEqual(emailsOf(mailer).slice(3).sort(), ["new1@x.com", "new2@x.com"]);
  assert.equal(await db.restockEvent.count({ where: { shop } }), 2); // two separate restock events
});

test("status transitions: waiting -> queued -> notified, with an audit trail and no addresses in it", async () => {
  const shop = "q-status.myshopify.com";
  await addSignup(db, { shop, email: "private@x.com", variant: variant() });
  const entry = () => db.waitlistEntry.findFirst({ where: { shop } });
  assert.equal((await entry()).status, "ACTIVE");
  await enqueueRestock(db, { shop, variant: stocked() });
  assert.equal((await entry()).status, "SENDING");
  const d0 = await db.notificationDelivery.findFirst({ where: { shop } });
  assert.equal(d0.status, "QUEUED"); assert.equal(d0.attempts, 0);
  await processQueue(db, { shop, mailer: fakeMailer(), stockCheck: async () => stocked() });
  assert.equal((await entry()).status, "NOTIFIED");
  const d = await db.notificationDelivery.findFirst({ where: { shop } });
  assert.equal(d.status, "ACCEPTED"); assert.ok(d.acceptedAt);
  const attempts = await db.notificationAttempt.findMany({ where: { shop } });
  assert.equal(attempts.length, 1); assert.equal(attempts[0].outcome, "ACCEPTED");
  assert.ok(!JSON.stringify([d, attempts]).includes("private@x.com"));
});

test("an email is never marked sent unless the provider accepted it", async () => {
  const shop = "q-accept.myshopify.com";
  await seed(shop, 1);
  const failing = { send: async () => { throw Object.assign(new Error("Email provider responded with HTTP 503"), { status: 503, retryable: true }); } };
  await notifyVariant(db, { shop, variant: stocked(), mailer: failing });
  assert.equal(await db.waitlistEntry.count({ where: { shop, status: "NOTIFIED" } }), 0);
  assert.equal(await db.notificationDelivery.count({ where: { shop, status: "ACCEPTED" } }), 0);
  assert.equal((await db.notificationDelivery.findFirst({ where: { shop } })).status, "QUEUED");
});

test("permanent provider errors (4xx) fail immediately; 429 is retried with backoff", async () => {
  const shop = "q-perm.myshopify.com";
  await seed(shop, 2);
  const now = new Date();
  let n = 0;
  const mailer = { send: async () => { n++; throw Object.assign(new Error(n === 1 ? "Email provider responded with HTTP 422" : "Email provider responded with HTTP 429"), n === 1 ? { status: 422, retryable: false } : { status: 429, retryable: true }); } };
  await processQueue(db, { shop, mailer, stockCheck: async () => stocked(), now, concurrency: 1 }).catch(() => {});
  await enqueueRestock(db, { shop, variant: stocked(), now });
  await processQueue(db, { shop, mailer, stockCheck: async () => stocked(), now, concurrency: 1 });
  const rows = await db.notificationDelivery.findMany({ where: { shop }, orderBy: { queuedAt: "asc" } });
  const statuses = rows.map((r) => r.status).sort();
  assert.deepEqual(statuses, ["FAILED", "QUEUED"]);
  const failed = rows.find((r) => r.status === "FAILED");
  assert.equal(failed.attempts, 1);
  const attempt = await db.notificationAttempt.findFirst({ where: { shop, deliveryId: failed.id } });
  assert.equal(attempt.httpStatus, 422); assert.equal(attempt.retryable, false);
});

test("a variant that went out of stock again waits instead of sending or being dropped", async () => {
  const shop = "q-oos.myshopify.com";
  await seed(shop, 2);
  await enqueueRestock(db, { shop, variant: stocked() });
  const mailer = fakeMailer();
  const r = await processQueue(db, { shop, mailer, stockCheck: async () => variant({ inventoryQuantity: 0 }) });
  assert.equal(mailer.sent.length, 0); assert.equal(r.waitingForStock, 2);
  assert.equal(await db.notificationDelivery.count({ where: { shop, status: "QUEUED" } }), 2);
  const back = await processQueue(db, { shop, mailer, stockCheck: async () => stocked() });
  assert.equal(back.sent, 2);
});

test("removed customers are skipped, not emailed", async () => {
  const shop = "q-removed.myshopify.com";
  await seed(shop, 2);
  await enqueueRestock(db, { shop, variant: stocked() });
  const one = await db.waitlistEntry.findFirst({ where: { shop }, orderBy: { email: "asc" } });
  await db.waitlistEntry.update({ where: { id: one.id }, data: { status: "REMOVED" } });
  const mailer = fakeMailer();
  const r = await processQueue(db, { shop, mailer, stockCheck: async () => stocked() });
  assert.equal(r.sent, 1); assert.equal(r.skipped, 1);
  assert.ok(!emailsOf(mailer).includes(one.email));
});

test("metrics separate accepted, failed, pending and clicks; delivered/purchased are reported as unavailable", async () => {
  const shop = "q-metrics.myshopify.com";
  await db.shopSettings.create({ data: { shop, trackClicks: true } });
  await seed(shop, 4);
  await enqueueRestock(db, { shop, variant: stocked() });
  let calls = 0;
  const mailer = { send: async () => { if (++calls === 4) throw Object.assign(new Error("HTTP 422"), { status: 422, retryable: false }); return { id: `m${calls}` }; } };
  await processQueue(db, { shop, mailer, stockCheck: async () => stocked(), concurrency: 1 });
  const accepted = await db.notificationDelivery.findFirst({ where: { shop, status: "ACCEPTED" } });
  assert.equal(accepted.providerMessageId.startsWith("m"), true);
  assert.equal(await recordClick(db, shop, accepted.trackingToken), accepted.targetPath);
  await recordClick(db, shop, accepted.trackingToken);
  assert.equal(await recordClick(db, "q-other.myshopify.com", accepted.trackingToken), null); // wrong shop
  assert.equal(await recordClick(db, shop, "nope"), null);
  const m = await notificationMetrics(db, shop, { from: new Date(Date.now() - 86400000), to: new Date(Date.now() + 86400000) });
  assert.deepEqual([m.queued, m.accepted, m.failed, m.pending, m.clicked], [4, 3, 1, 0, 1]);
  assert.equal(m.clickRate, 33.3);
  assert.equal(m.delivered, null); assert.equal(m.purchased, null);
  assert.equal((await db.notificationDelivery.findUnique({ where: { id: accepted.id } })).clickCount, 2);
});

test("email links are tracked only when the merchant opted in", () => {
  const v = stocked(); const delivery = { trackingToken: "tok_abcdefghijkl" };
  assert.ok(buildEmail({ shop: "s.myshopify.com", variant: v, settings: { trackClicks: false }, delivery }).text.includes("/products/shoe?variant=111"));
  const tracked = buildEmail({ shop: "s.myshopify.com", variant: v, settings: { trackClicks: true }, delivery });
  assert.ok(tracked.text.includes("/apps/waitlist/r/tok_abcdefghijkl")); assert.match(tracked.text, /counts clicks/);
});

test("merchant retry re-queues failed deliveries only for the requested entries", async () => {
  const shop = "q-retry.myshopify.com";
  await seed(shop, 2);
  await enqueueRestock(db, { shop, variant: stocked() });
  await processQueue(db, { shop, mailer: { send: async () => { throw Object.assign(new Error("HTTP 422"), { status: 422, retryable: false }); } }, stockCheck: async () => stocked() });
  const entries = await db.waitlistEntry.findMany({ where: { shop }, orderBy: { email: "asc" } });
  assert.ok(entries.every((e) => e.status === "FAILED"));
  assert.equal(await retryFailedDeliveries(db, shop, { entryIds: [entries[0].id] }), 1);
  assert.equal(await retryFailedDeliveries(db, "q-other.myshopify.com", { entryIds: [entries[1].id] }), 0); // IDOR guard
  const mailer = fakeMailer();
  await processQueue(db, { shop, mailer, stockCheck: async () => stocked() });
  assert.deepEqual(emailsOf(mailer), [entries[0].email]);
  assert.equal((await db.waitlistEntry.findUnique({ where: { id: entries[1].id } })).status, "FAILED");
});

test("runQueueForShop verifies stock with Shopify and drains in-stock variants only", async () => {
  const shop = "q-runner.myshopify.com";
  await seed(shop, 3, { variantId: "111" });
  await seed(shop, 2, { variantId: "222" });
  const admin = fakeAdmin(() => ({ data: { nodes: [
    { id: "gid://shopify/ProductVariant/111", title: "Red", inventoryQuantity: 6, inventoryPolicy: "DENY", product: { id: "gid://shopify/Product/999", title: "Shoe", handle: "shoe" } },
    { id: "gid://shopify/ProductVariant/222", title: "Blue", inventoryQuantity: 0, inventoryPolicy: "DENY", product: { id: "gid://shopify/Product/999", title: "Shoe", handle: "shoe" } },
  ] } }));
  assert.ok((await shopsWithDueWork(db)).includes(shop));
  const mailer = fakeMailer();
  const r = await runQueueForShop({ db, shop, admin, mailer });
  assert.equal(r.sent, 3); assert.equal(mailer.sent.length, 3);
  assert.equal(await db.waitlistEntry.count({ where: { shop, variantId: "222", status: "ACTIVE" } }), 2);
  assert.equal((await runQueueForShop({ db, shop, admin, mailer: null })).operational, false);
});

test("privacy: customer redact removes the customer's deliveries and attempts; shop redact removes everything", async () => {
  const shop = "q-priv.myshopify.com";
  await addSignup(db, { shop, email: "gone@x.com", variant: variant() });
  await addSignup(db, { shop, email: "stay@x.com", variant: variant() });
  await notifyVariant(db, { shop, variant: stocked(), mailer: fakeMailer() });
  assert.equal(await db.notificationDelivery.count({ where: { shop } }), 2);
  await handleCustomerRedact({ db, shop, payload: { customer: { email: "gone@x.com" } } });
  assert.equal(await db.notificationDelivery.count({ where: { shop } }), 1);
  assert.equal(await db.notificationAttempt.count({ where: { shop } }), 1);
  await handleShopRedact({ db, shop });
  for (const t of ["notificationDelivery", "notificationAttempt", "restockEvent", "waitlistEntry"]) assert.equal(await db[t].count({ where: { shop } }), 0, t);
});

test("email configuration: actionable errors, sender validation, no secret in messages", () => {
  assert.deepEqual(getMailerStatus({}).problems.length, 3);
  const bad = getMailerStatus({ EMAIL_PROVIDER: "sendgrid", EMAIL_API_KEY: "SECRET-KEY", EMAIL_FROM: "nope" });
  assert.equal(bad.configured, false);
  assert.ok(bad.problems.some((p) => /not supported/.test(p)) && bad.problems.some((p) => /EMAIL_FROM is not a valid/.test(p)));
  assert.ok(!JSON.stringify(bad).includes("SECRET-KEY"));
  assert.equal(getMailerStatus({ EMAIL_PROVIDER: "resend", EMAIL_API_KEY: "k", EMAIL_FROM: "Shop <a@b.com>" }).configured, true);
  assert.equal(parseSender("Shop <a@b.com>"), "a@b.com"); assert.equal(parseSender("a@b"), null);
  assert.equal(getMailer({ EMAIL_PROVIDER: "resend", EMAIL_API_KEY: "k" }), null);
});

test("provider adapters: idempotency key, message id, retryable classification, no recipient in errors", async () => {
  const seen = [];
  const mk = (status, body = { id: "re_123" }) => async (url, init) => { seen.push({ url, init }); return { ok: status < 300, status, json: async () => body }; };
  const env = { EMAIL_PROVIDER: "resend", EMAIL_API_KEY: "k", EMAIL_FROM: "a@b.com" };
  const ok = await getMailer(env, mk(200)).send({ to: "c@d.com", subject: "s", html: "h", text: "t", idempotencyKey: "delivery-1" });
  assert.deepEqual(ok, { id: "re_123" });
  assert.equal(seen[0].init.headers["Idempotency-Key"], "delivery-1");
  const pm = await getMailer({ ...env, EMAIL_PROVIDER: "postmark" }, mk(200, { MessageID: "pm-9" })).send({ to: "c@d.com", subject: "s", html: "h", text: "t" });
  assert.equal(pm.id, "pm-9");
  for (const [status, retryable] of [[429, true], [503, true], [422, false], [401, false]]) {
    const err = await getMailer(env, mk(status)).send({ to: "secret@d.com", subject: "s", html: "h", text: "t" }).catch((e) => e);
    assert.equal(err.status, status); assert.equal(err.retryable, retryable); assert.ok(!err.message.includes("secret@d.com"));
  }
  const net = await getMailer(env, async () => { throw new Error("ECONNRESET secret@d.com"); }).send({ to: "secret@d.com", subject: "s", html: "h", text: "t" }).catch((e) => e);
  assert.equal(net.retryable, true); assert.ok(!net.message.includes("secret@d.com"));
});

test("stress: three simultaneous runs per restock never send the same customer twice (60 rounds)", async () => {
  for (let i = 0; i < 60; i++) {
    const shop = `q-stress${i}.myshopify.com`;
    await addSignup(db, { shop, email: "a@x.com", variant: variant() });
    const mailer = fakeMailer();
    await Promise.all([1, 2, 3].map(() => notifyVariant(db, { shop, variant: stocked(), mailer })));
    assert.equal(mailer.sent.length, 1, `round ${i}`);
  }
});

test("retention purge also removes finished deliveries/attempts, old events and settled reservations (never queued work)", async () => {
  const { purgeExpired } = await import("../app/lib/waitlist.server.js");
  const shop = "q-purge.myshopify.com";
  await seed(shop, 3);
  await enqueueRestock(db, { shop, variant: stocked() });
  const [a, b, c] = await db.notificationDelivery.findMany({ where: { shop }, orderBy: { id: "asc" } });
  const old = new Date(Date.now() - 200 * 86400000);
  await db.notificationAttempt.create({ data: { shop, deliveryId: a.id, attemptNo: 1, outcome: "ACCEPTED" } });
  await db.notificationDelivery.updateMany({ where: { id: a.id }, data: { status: "ACCEPTED", updatedAt: old } });
  await db.notificationDelivery.updateMany({ where: { id: b.id }, data: { status: "QUEUED" } });           // pending work is never purged
  await db.notificationDelivery.updateMany({ where: { id: c.id }, data: { status: "FAILED", updatedAt: old } });
  await db.restockEvent.updateMany({ where: { shop }, data: { status: "COMPLETE", openKey: null, completedAt: old } });
  await db.preorderReservation.create({ data: { shop, configId: "x", variantId: "1", quantity: 1, status: "EXPIRED", expiresAt: old, resolvedAt: old } });
  await db.preorderReservation.create({ data: { shop, configId: "x", variantId: "1", quantity: 1, status: "HELD", expiresAt: old } });      // live holds untouched
  await purgeExpired(db, shop, 90);
  const left = await db.notificationDelivery.findMany({ where: { shop } });
  assert.deepEqual(left.map((d) => d.id), [b.id]);
  assert.equal(await db.notificationAttempt.count({ where: { shop } }), 0);
  assert.equal(await db.restockEvent.count({ where: { shop } }), 0);
  assert.deepEqual((await db.preorderReservation.findMany({ where: { shop } })).map((r) => r.status), ["HELD"]);
});
