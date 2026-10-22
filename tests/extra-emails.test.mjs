import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, variant } from "./helpers.mjs";
import { addSignup } from "../app/lib/waitlist.server.js";
import { handleSignupRequest } from "../app/lib/signup.server.js";
import { enqueueSignupConfirmation, enqueueShipEmails, enqueuePreorderConfirmation, processFlowDeliveries, runFlowKinds, dateKey, SKIP_NO_EMAIL } from "../app/lib/flow-notify.server.js";
import { handleOrderCreate } from "../app/lib/order-created.server.js";
import { buildShipEmail, buildSignupConfirmationEmail, buildPreorderConfirmationEmail } from "../app/lib/email-templates.server.js";
import { processQueue, enqueueRestock, retryFailedDeliveries, MAX_ATTEMPTS } from "../app/lib/notify.server.js";
import { runQueueForShop, shopsWithDueWork, queueDepth } from "../app/lib/queue-runner.server.js";
import { recordPreorderOrder, cancelPreorderOrder } from "../app/lib/preorder-orders.server.js";
import { handleCustomerRedact, handleShopRedact } from "../app/lib/webhooks.server.js";
import { parseSettingsForm, settingsView } from "../app/lib/settings.server.js";
import { isValidEmail, cleanText } from "../app/lib/validation.server.js";

// Signup confirmation and ship-date emails: queueing, windows, retries, isolation from the restock email, privacy.
// The sender is a recording stand-in for the shop's Gmail mailer (the real SMTP behaviour is tested in gmail.test.mjs).

let db;
before(async () => { db = await createTestDb(); });

let n = 0;
const newShop = () => `ee${++n}.myshopify.com`;
const D = (s) => new Date(`${s}T00:00:00Z`);
const NOW = new Date("2026-11-10T12:00:00Z");

/** Records every message; `fail` makes every send throw a temporary ("transient") or permanent error. */
function recorder({ fail = null } = {}) {
  const sent = [];
  return {
    channel: "smtp", provider: "gmail", sent,
    async send(message) {
      if (fail === "transient") throw Object.assign(new Error("temporary failure"), { retryable: true });
      if (fail === "permanent") throw Object.assign(new Error("recipient rejected"), { retryable: false });
      sent.push(message);
      return { id: `m${sent.length}` };
    },
  };
}
/** Fake Admin: answers the variant lookup (product handle "shoe"). */
const adminStub = () => ({
  graphql: async () => ({ json: async () => ({ data: { nodes: [{ id: "gid://shopify/ProductVariant/111", title: "Red", inventoryQuantity: 0, inventoryPolicy: "DENY", product: { id: "gid://shopify/Product/999", title: "Shoe", handle: "shoe" } }] } }) }),
});
const deliveries = (shop, where = {}) => db.notificationDelivery.findMany({ where: { shop, ...where }, orderBy: { queuedAt: "asc" } });
const idle = { sent: 0, failed: 0, retried: 0, skipped: 0, deferred: 0 };

// ---- wording -----------------------------------------------------------------------------------------------------

test("each kind has its own wording, with the product link, the ship date and escaped text", () => {
  const c = buildSignupConfirmationEmail({ shop: "s.myshopify.com", productTitle: "Shoe <b>", variantTitle: "Red", productHandle: "shoe" });
  assert.equal(c.subject, "You're on the list for Shoe <b> (Red)");
  assert.ok(c.html.includes("Shoe &lt;b&gt;") && !c.html.includes("<b>"), "HTML is escaped");
  assert.match(c.text, /https:\/\/s\.myshopify\.com\/products\/shoe/);
  const ctx = { shop: "s.myshopify.com", productTitle: "Shoe", variantTitle: "Red", orderName: "#1001", shipDate: "2026-11-13", productHandle: "shoe" };
  const reminder = buildShipEmail("SHIP_REMINDER", ctx), changed = buildShipEmail("SHIP_DATE_CHANGE", ctx);
  assert.equal(reminder.subject, "Your pre-order ships soon: Shoe (Red)");
  assert.equal(changed.subject, "New expected ship date for your pre-order: Shoe (Red)");
  for (const m of [reminder, changed]) assert.match(m.text, /13 November 2026/);
  assert.match(reminder.text, /order #1001/);
});

// ---- settings toggles ---------------------------------------------------------------------------------------

test("settings: new emails are off by default, 3 days, validated, saved and kept when a form omits them", async () => {
  const deps = { isValidEmail, cleanText };
  const f = (o) => new URLSearchParams(o);
  const v = settingsView(null);
  assert.deepEqual([v.emailSignupConfirmation, v.emailShipReminder, v.emailShipDateChange, v.shipReminderDays, v.emailPreorderConfirmation], [false, false, false, 3, false]);
  const conf = parseSettingsForm(f({ _form: "settings", emailPreorderConfirmation: "on", shipReminderDays: "3" }), null, deps).data;
  assert.equal(conf.emailPreorderConfirmation, true);
  assert.equal(parseSettingsForm(f({ _form: "settings", shipReminderDays: "3" }), conf, deps).data.emailPreorderConfirmation, false, "an unchecked box turns it off");
  assert.equal(parseSettingsForm(f({ restockBuffer: "1" }), conf, deps).data.emailPreorderConfirmation, true, "a form without the field keeps it");
  const on = parseSettingsForm(f({ _form: "settings", emailSignupConfirmation: "on", emailShipReminder: "on", emailShipDateChange: "on", shipReminderDays: "5" }), null, deps).data;
  assert.deepEqual([on.emailSignupConfirmation, on.emailShipReminder, on.emailShipDateChange, on.shipReminderDays], [true, true, true, 5]);
  const off = parseSettingsForm(f({ _form: "settings", shipReminderDays: "3" }), on, deps).data;
  assert.deepEqual([off.emailSignupConfirmation, off.emailShipReminder, off.emailShipDateChange], [false, false, false], "unchecked boxes turn them off");
  assert.equal(parseSettingsForm(f({ restockBuffer: "1" }), on, deps).data.emailShipReminder, true, "a form without the field keeps the stored value");
  for (const bad of ["0", "61", "2.5", "x", ""]) assert.ok(parseSettingsForm(f({ _form: "settings", shipReminderDays: bad }), null, deps).errors?.shipReminderDays, `days ${JSON.stringify(bad)}`);
  const shop = newShop();
  await db.shopSettings.upsert({ where: { shop }, create: { shop, ...on }, update: on });
  const row = await db.shopSettings.findUnique({ where: { shop } });
  assert.deepEqual([row.emailSignupConfirmation, row.shipReminderDays], [true, 5]);
});

// ---- signup confirmation ------------------------------------------------------------------------------------

const input = (email = "known@x.com") => ({ email, productId: "999", variantId: "111" });

test("signup confirmation: queued only when the toggle is on AND Gmail can send; the entry stays waiting", async () => {
  const shop = newShop();
  const admin = adminStub();
  // toggle off (no settings row): nothing queued
  let r = await handleSignupRequest({ db, admin, shop, input: input("a@x.com"), canConfirm: true });
  assert.deepEqual([r.status, r.confirmationQueued], [200, false]);
  await db.shopSettings.create({ data: { shop, emailSignupConfirmation: true } });
  // toggle on but Gmail cannot send (not connected / needs attention): nothing queued
  r = await handleSignupRequest({ db, admin, shop, input: input("b@x.com"), canConfirm: false });
  assert.equal(r.confirmationQueued, false);
  assert.equal((await deliveries(shop)).length, 0);
  // on + Gmail: one delivery, JSON body unchanged, entry still ACTIVE
  r = await handleSignupRequest({ db, admin, shop, input: input("known@x.com"), canConfirm: true });
  assert.deepEqual([r.body, r.confirmationQueued], [{ ok: true, result: "created" }, true]);
  const [d] = await deliveries(shop);
  assert.deepEqual([d.kind, d.status, JSON.parse(d.payload).productTitle], ["SIGNUP_CONFIRMATION", "QUEUED", "Shoe"]);
  assert.ok(!d.payload.includes("@"), "no email address in the payload");
  assert.equal((await db.waitlistEntry.findFirst({ where: { shop, email: "known@x.com" } })).status, "ACTIVE");
  // a duplicate signup does not queue a second confirmation
  r = await handleSignupRequest({ db, admin, shop, input: input("known@x.com"), canConfirm: true });
  assert.deepEqual([r.body.result, r.confirmationQueued], ["duplicate", false]);
  assert.equal((await deliveries(shop)).length, 1);
});

test("signup confirmation: sent once, accepted, entry still waiting; concurrent runners cannot double-send", async () => {
  const shop = newShop();
  await db.shopSettings.create({ data: { shop, emailSignupConfirmation: true } });
  await handleSignupRequest({ db, admin: adminStub(), shop, input: input("known@x.com"), canConfirm: true });
  const mailer = recorder();
  const runs = await Promise.all([processFlowDeliveries(db, { shop, mailer, now: NOW }), processFlowDeliveries(db, { shop, mailer, now: NOW })]);
  assert.equal(runs.reduce((a, r) => a + r.sent, 0), 1);
  assert.equal(mailer.sent.length, 1, "exactly one email sent");
  assert.deepEqual([mailer.sent[0].to, mailer.sent[0].subject], ["known@x.com", "You're on the list for Shoe (Red)"]);
  const [d] = await deliveries(shop);
  assert.deepEqual([d.status, d.attempts], ["ACCEPTED", 1]);
  assert.equal((await db.notificationAttempt.findMany({ where: { shop, deliveryId: d.id } })).map((a) => a.outcome).join(), "ACCEPTED");
  assert.equal((await db.waitlistEntry.findFirst({ where: { shop } })).status, "ACTIVE");
  assert.deepEqual(await processFlowDeliveries(db, { shop, mailer, now: NOW }), idle, "nothing is sent twice");
});

test("signup confirmation: re-signup after being notified is confirmed again; the same signup never twice", async () => {
  const shop = newShop();
  const v = variant();
  const first = await addSignup(db, { shop, email: "known@x.com", variant: v });
  assert.equal((await enqueueSignupConfirmation(db, { shop, entry: first.entry, variant: v })).queued, true);
  assert.equal((await enqueueSignupConfirmation(db, { shop, entry: first.entry, variant: v })).queued, false);
  await db.waitlistEntry.updateMany({ where: { shop }, data: { status: "NOTIFIED" } });
  await new Promise((r) => setTimeout(r, 5));
  const again = await addSignup(db, { shop, email: "known@x.com", variant: v });
  assert.equal(again.result, "created");
  assert.equal((await enqueueSignupConfirmation(db, { shop, entry: again.entry, variant: v })).queued, true);
  assert.equal((await deliveries(shop)).length, 2);
});

test("signup confirmation: an entry removed before sending is skipped", async () => {
  const shop = newShop();
  const v = variant();
  const s = await addSignup(db, { shop, email: "known@x.com", variant: v });
  await enqueueSignupConfirmation(db, { shop, entry: s.entry, variant: v });
  await db.waitlistEntry.updateMany({ where: { shop }, data: { status: "REMOVED" } });
  const mailer = recorder();
  const r = await processFlowDeliveries(db, { shop, mailer, now: NOW });
  assert.equal(r.skipped, 1); assert.equal(mailer.sent.length, 0);
});

// ---- retries ----------------------------------------------------------------------------------------------

test("retries: transient errors back off 1/5/30 min then fail; permanent errors fail at once; the failed retry button re-queues", async () => {
  const shop = newShop();
  const v = variant();
  const s = await addSignup(db, { shop, email: "known@x.com", variant: v });
  await enqueueSignupConfirmation(db, { shop, entry: s.entry, variant: v });
  const mailer = recorder({ fail: "transient" });
  let t = new Date(NOW);
  const expectBackoff = [60_000, 5 * 60_000, null];
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const r = await processFlowDeliveries(db, { shop, mailer, now: t });
    const [d] = await deliveries(shop);
    if (expectBackoff[i]) {
      assert.deepEqual([r.retried, d.status, d.attempts], [1, "QUEUED", i + 1]);
      assert.equal(d.nextAttemptAt.getTime() - t.getTime(), expectBackoff[i]);
      assert.equal((await processFlowDeliveries(db, { shop, mailer, now: new Date(t.getTime() + 1000) })).retried, 0, "not retried before it is due");
      t = new Date(d.nextAttemptAt.getTime() + 1);
    } else {
      assert.deepEqual([r.failed, d.status, d.attempts], [1, "FAILED", MAX_ATTEMPTS]);
    }
  }
  assert.equal(await retryFailedDeliveries(db, shop, { now: t }), 1);
  assert.equal((await deliveries(shop))[0].status, "QUEUED");
  const ok = await processFlowDeliveries(db, { shop, mailer: recorder(), now: t });
  assert.equal(ok.sent, 1);

  const shop2 = newShop();
  const s2 = await addSignup(db, { shop: shop2, email: "known@x.com", variant: v });
  await enqueueSignupConfirmation(db, { shop: shop2, entry: s2.entry, variant: v });
  const perm = await processFlowDeliveries(db, { shop: shop2, mailer: recorder({ fail: "permanent" }), now: NOW });
  assert.deepEqual([perm.failed, (await deliveries(shop2))[0].status], [1, "FAILED"]);
});

test("nothing is sent (and nothing is lost) unless the sender is the shop's Gmail", async () => {
  const shop = newShop();
  const v = variant();
  const s = await addSignup(db, { shop, email: "known@x.com", variant: v });
  await enqueueSignupConfirmation(db, { shop, entry: s.entry, variant: v });
  const sent = [];
  const r = await processFlowDeliveries(db, { shop, mailer: { send: async (m) => sent.push(m) }, now: NOW });
  assert.deepEqual([r.sent, sent.length, (await deliveries(shop))[0].status], [0, 0, "QUEUED"]);
  assert.deepEqual(await processFlowDeliveries(db, { shop, mailer: null, now: NOW }), idle);
});

// ---- pre-order lines from orders ---------------------------------------------------------------------------

const orderPayload = (o = {}) => ({
  id: 5001, name: "#1001", customer: { id: 77, email: "known@x.com" },
  line_items: [
    { id: 1, variant_id: 111, product_id: 999, title: "Shoe", variant_title: "Red", quantity: 2, properties: [{ name: "_preorder", value: "true" }, { name: "_preorder_ship_date", value: "2026-11-13" }] },
    { id: 2, variant_id: 222, product_id: 999, title: "Shoe", variant_title: "Blue", quantity: 1, properties: [] },
  ],
  ...o,
});
const seedConfig = (shop, over = {}) => db.preorderConfig.create({ data: { shop, productId: "999", variantId: "111", productTitle: "Shoe", variantTitle: "Red", shipDate: D("2026-11-13"), ...over } });
/** Gmail keeps the buyer's address (it needs it for ship-date emails). */
const record = (shop, payload) => recordPreorderOrder(db, { shop, payload, storeEmail: true });

test("orders: only pre-order lines are stored, and without the address unless Gmail needs it; webhook retries are idempotent", async () => {
  const shop = newShop();
  await seedConfig(shop);
  assert.deepEqual(await recordPreorderOrder(db, { shop, payload: orderPayload() }), { stored: 1 });
  assert.deepEqual(await recordPreorderOrder(db, { shop, payload: orderPayload() }), { stored: 0 });
  const rows = await db.preorderOrder.findMany({ where: { shop } });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].customerId, rows[0].variantId, rows[0].quantity, rows[0].orderName, dateKey(rows[0].lastShipDate)], ["77", "111", 2, "#1001", "2026-11-13"]);
  assert.ok(!JSON.stringify(rows).includes("@"), "no email stored by default");
  assert.deepEqual(await recordPreorderOrder(db, { shop, payload: { id: 9, line_items: [{ id: 1, variant_id: 5, properties: [] }] } }), { stored: 0 });
  assert.deepEqual(await recordPreorderOrder(db, { shop, payload: {} }), { stored: 0 });
  assert.equal((await recordPreorderOrder(db, { shop, payload: orderPayload({ id: 5002, customer: null }) })).stored, 1);
  assert.equal((await db.preorderOrder.findFirst({ where: { shop, orderId: "5002" } })).customerId, null);
});

// ---- ship-date reminders and change notices ----------------------------------------------------------------

const allOn = { emailShipReminder: true, emailShipDateChange: true, emailSignupConfirmation: true, shipReminderDays: 3 };
const resolveHandles = async () => new Map([["111", "shoe"]]);

test("reminder: queued once, only inside the window, only while the toggle is on, sent to the order's address", async () => {
  const shop = newShop();
  await seedConfig(shop);
  await record(shop, orderPayload());
  const run = (settings, now) => enqueueShipEmails(db, { shop, settings, resolveHandles, now });
  assert.deepEqual(await run(allOn, new Date("2026-11-09T12:00:00Z")), { reminders: 0, changes: 0, skipped: 0 }); // 4 days out
  assert.deepEqual(await run({ ...allOn, emailShipReminder: false }, NOW), { reminders: 0, changes: 0, skipped: 0 }); // toggle off
  assert.equal((await run(allOn, NOW)).reminders, 1);                // Nov 13 00:00 vs Nov 10 12:00 = 2.5 days
  assert.equal((await run(allOn, new Date("2026-11-11T12:00:00Z"))).reminders, 0, "never twice for the same date");
  assert.equal((await run(allOn, new Date("2026-11-14T00:00:00Z"))).reminders, 0, "no reminder once the date has passed");
  const [d] = await deliveries(shop);
  assert.deepEqual([d.kind, d.status, d.eventId], ["SHIP_REMINDER", "QUEUED", "reminder:2026-11-13"]);
  const mailer = recorder();
  assert.equal((await processFlowDeliveries(db, { shop, mailer, now: NOW })).sent, 1);
  assert.equal(mailer.sent[0].to, "known@x.com");
  assert.equal(mailer.sent[0].subject, "Your pre-order ships soon: Shoe (Red)");
  assert.ok(mailer.sent[0].text.includes(`https://${shop}/products/shoe`) && /13 November 2026/.test(mailer.sent[0].text));
});

test("reminder: the days setting controls the window", async () => {
  const shop = newShop();
  await seedConfig(shop);
  await record(shop, orderPayload());
  const at = new Date("2026-11-08T00:00:00Z"); // 5 days out
  assert.equal((await enqueueShipEmails(db, { shop, settings: { ...allOn, shipReminderDays: 3 }, resolveHandles, now: at })).reminders, 0);
  assert.equal((await enqueueShipEmails(db, { shop, settings: { ...allOn, shipReminderDays: 7 }, resolveHandles, now: at })).reminders, 1);
});

test("change notice: sent once when the date moves; lastShipDate follows; no stale mail after the toggle is turned on", async () => {
  const shop = newShop();
  await seedConfig(shop);
  await record(shop, orderPayload());
  const far = new Date("2026-10-01T00:00:00Z");
  assert.equal((await enqueueShipEmails(db, { shop, settings: allOn, resolveHandles, now: far })).changes, 0, "no change yet");
  await db.preorderConfig.updateMany({ where: { shop }, data: { shipDate: D("2026-12-01") } });
  assert.equal((await enqueueShipEmails(db, { shop, settings: allOn, resolveHandles, now: far })).changes, 1);
  assert.equal((await enqueueShipEmails(db, { shop, settings: allOn, resolveHandles, now: far })).changes, 0, "once per change");
  const [d] = await deliveries(shop);
  assert.deepEqual([d.kind, d.eventId, JSON.parse(d.payload).shipDate], ["SHIP_DATE_CHANGE", "change:2026-12-01", "2026-12-01"]);
  assert.equal(dateKey((await db.preorderOrder.findFirst({ where: { shop } })).lastShipDate), "2026-12-01");
  // toggle off: the date moves again, nobody is mailed, but the record is brought up to date...
  await db.preorderConfig.updateMany({ where: { shop }, data: { shipDate: D("2026-12-20") } });
  assert.equal((await enqueueShipEmails(db, { shop, settings: { ...allOn, emailShipDateChange: false }, resolveHandles, now: far })).changes, 0);
  assert.equal(dateKey((await db.preorderOrder.findFirst({ where: { shop } })).lastShipDate), "2026-12-20");
  // ...so switching it on later does not mail the old change
  assert.equal((await enqueueShipEmails(db, { shop, settings: allOn, resolveHandles, now: far })).changes, 0);
  assert.equal((await deliveries(shop)).length, 1);
  const mailer = recorder();
  await processFlowDeliveries(db, { shop, mailer, now: far });
  assert.equal(mailer.sent[0].subject, "New expected ship date for your pre-order: Shoe (Red)");
  assert.match(mailer.sent[0].text, /1 December 2026/);
});

test("change notice uses a campaign's ship date when the variant has none of its own, and is not followed by a duplicate reminder", async () => {
  const shop = newShop();
  const camp = await db.campaign.create({ data: { shop, name: "Launch", shipDate: D("2026-11-20"), state: "PUBLISHED" } });
  await seedConfig(shop, { shipDate: null, campaignId: camp.id });
  await record(shop, orderPayload({ line_items: [{ id: 1, variant_id: 111, product_id: 999, title: "Shoe", quantity: 1, properties: [{ name: "_preorder", value: "true" }] }] }));
  assert.equal(dateKey((await db.preorderOrder.findFirst({ where: { shop } })).lastShipDate), "2026-11-20", "falls back to the campaign date");
  await db.campaign.update({ where: { id: camp.id }, data: { shipDate: D("2026-11-12") } }); // moved up, now inside the window
  const r = await enqueueShipEmails(db, { shop, settings: allOn, resolveHandles, now: NOW });
  assert.deepEqual([r.changes, r.reminders], [1, 0], "the change notice already told them the date");
  assert.deepEqual((await deliveries(shop)).map((d) => d.kind), ["SHIP_DATE_CHANGE"]);
});

test("ship-date emails: orders without an address are recorded as skipped, cancelled orders are left alone", async () => {
  const shop = newShop();
  await seedConfig(shop);
  await record(shop, orderPayload({ id: 1, customer: null }));
  await record(shop, orderPayload({ id: 2 }));
  await cancelPreorderOrder(db, { shop, payload: { id: 2 } });
  const r = await enqueueShipEmails(db, { shop, settings: allOn, resolveHandles, now: NOW });
  assert.deepEqual([r.reminders, r.skipped], [0, 1]);
  const [d] = await deliveries(shop);
  assert.deepEqual([d.status, d.lastError, d.kind], ["SKIPPED", SKIP_NO_EMAIL, "SHIP_REMINDER"]);
  const mailer = recorder();
  assert.deepEqual(await processFlowDeliveries(db, { shop, mailer, now: NOW }), idle);
  assert.equal(mailer.sent.length, 0);
});

// ---- the queue: isolation from restock, runner, scheduler ------------------------------------------------------

test("restock and the new kinds share the table but never each other's rows", async () => {
  const shop = newShop();
  await db.shopSettings.create({ data: { shop, ...allOn } });
  const v = variant({ inventoryQuantity: 0 });
  const s = await addSignup(db, { shop, email: "known@x.com", variant: v });
  await enqueueSignupConfirmation(db, { shop, entry: s.entry, variant: v });
  const mailer = recorder();
  // the restock sender ignores the confirmation (the variant is out of stock and must not block it either)
  const restocked = { ...v, inventoryQuantity: 5 };
  assert.equal((await enqueueRestock(db, { shop, variant: restocked, now: NOW })).queued, 1);
  const r = await processQueue(db, { shop, mailer, stockCheck: async () => restocked, now: NOW });
  assert.equal(r.sent, 1);
  assert.deepEqual(mailer.sent.map((m) => /back in stock/.test(m.subject)), [true], "only the restock email went out");
  assert.deepEqual((await deliveries(shop)).map((d) => [d.kind, d.status]), [["SIGNUP_CONFIRMATION", "QUEUED"], ["RESTOCK", "ACCEPTED"]]);
  // the extra-email processor sends the confirmation, and leaves the (now NOTIFIED) entry alone
  assert.equal((await processFlowDeliveries(db, { shop, mailer, now: NOW })).sent, 1);
  assert.match(mailer.sent[1].subject, /on the list/);
  assert.equal((await db.waitlistEntry.findFirst({ where: { shop } })).status, "NOTIFIED");
});

test("runner: one pass queues ship-date emails and sends them; the scheduler sees shops with open pre-orders", async () => {
  const shop = newShop();
  await db.shopSettings.create({ data: { shop, ...allOn } });
  await seedConfig(shop);
  await record(shop, orderPayload());
  assert.ok((await shopsWithDueWork(db, NOW)).includes(shop), "a shop with open pre-orders is visited");
  const admin = adminStub();
  const mailer = recorder();
  const r = await runQueueForShop({ db, shop, admin, mailer, now: NOW });
  assert.equal(r.sent, 1);
  assert.equal(mailer.sent.length, 1);
  assert.ok(mailer.sent[0].text.includes(`https://${shop}/products/shoe`));
  assert.equal((await runQueueForShop({ db, shop, admin, mailer, now: NOW })).sent, 0, "a second pass sends nothing");
  assert.equal(mailer.sent.length, 1);
  assert.equal(await queueDepth(db, shop), 0);
  // not Gmail: nothing queued, nothing sent
  const shop2 = newShop();
  await db.shopSettings.create({ data: { shop: shop2, ...allOn } });
  await seedConfig(shop2);
  await record(shop2, orderPayload());
  const sent = [];
  assert.deepEqual(await runFlowKinds(db, { shop: shop2, admin, mailer: { send: async (m) => sent.push(m) }, now: NOW }), idle);
  assert.equal((await deliveries(shop2)).length, 0);
});

// ---- pre-order confirmation ---------------------------------------------------------------------------------

test("pre-order confirmation wording: one email lists every pre-order item with its quantity and ship date", () => {
  const one = buildPreorderConfirmationEmail({ shop: "s.myshopify.com", orderName: "#1001", lines: [{ productTitle: "Shoe", variantTitle: "Red", quantity: 2, shipDate: "2026-11-13", productHandle: "shoe" }] });
  assert.equal(one.subject, "Your pre-order is confirmed: Shoe (Red)");
  assert.match(one.text, /2 × Shoe \(Red\)/); assert.match(one.text, /13 November 2026/); assert.match(one.text, /order #1001/);
  assert.match(one.text, /https:\/\/s\.myshopify\.com\/products\/shoe/);
  const two = buildPreorderConfirmationEmail({ shop: "s.myshopify.com", orderName: "#1002", lines: [
    { productTitle: "Shoe <b>", variantTitle: "", quantity: 1, shipDate: "2026-11-13", productHandle: "shoe" },
    { productTitle: "Hat", variantTitle: "Blue", quantity: 3, shipDate: null, productHandle: "hat" }] });
  assert.equal(two.subject, "Your pre-order is confirmed: Shoe <b> and 1 more");
  assert.ok(two.html.includes("Shoe &lt;b&gt;") && !two.html.includes("<b>"), "HTML is escaped");
  assert.match(two.text, /3 × Hat \(Blue\)/);
  assert.doesNotMatch(two.text.split("\n").find((l) => l.includes("Hat")), /ship/, "an item without a date says nothing about shipping");
});

const twoLineOrder = (o = {}) => orderPayload({
  id: 6001, name: "#6001",
  line_items: [
    { id: 1, variant_id: 111, product_id: 999, title: "Shoe", variant_title: "Red", quantity: 2, properties: [{ name: "_preorder", value: "true" }, { name: "_preorder_ship_date", value: "2026-11-13" }] },
    { id: 2, variant_id: 333, product_id: 998, title: "Hat", variant_title: "Blue", quantity: 1, properties: [{ name: "_preorder", value: "true" }, { name: "_preorder_ship_date", value: "2026-12-01" }] },
    { id: 3, variant_id: 444, product_id: 997, title: "Sock", quantity: 1, properties: [] },
  ],
  ...o,
});
const seedTwo = async (shop) => { await seedConfig(shop); await seedConfig(shop, { productId: "998", variantId: "333", productTitle: "Hat", variantTitle: "Blue", shipDate: D("2026-12-01") }); };
const handlesFor = async () => new Map([["111", "shoe"], ["333", "hat"]]);

test("pre-order confirmation: ONE email per order, listing only the pre-order lines, queued once", async () => {
  const shop = newShop();
  await seedTwo(shop);
  await record(shop, twoLineOrder());
  assert.deepEqual(await enqueuePreorderConfirmation(db, { shop, orderId: "6001", resolveHandles: handlesFor }), { queued: true });
  assert.deepEqual(await enqueuePreorderConfirmation(db, { shop, orderId: "6001", resolveHandles: handlesFor }), { queued: false }, "a webhook retry queues nothing");
  const [d] = await deliveries(shop);
  assert.deepEqual([(await deliveries(shop)).length, d.kind, d.status, d.eventId], [1, "PREORDER_CONFIRMATION", "QUEUED", "confirm:6001"]);
  const p = JSON.parse(d.payload);
  assert.deepEqual(p.lines.map((l) => [l.productTitle, l.quantity, l.shipDate, l.productHandle]), [["Shoe", 2, "2026-11-13", "shoe"], ["Hat", 1, "2026-12-01", "hat"]]);
  assert.ok(!d.payload.includes("@"), "no email address in the payload");
  const mailer = recorder();
  assert.equal((await processFlowDeliveries(db, { shop, mailer, now: NOW })).sent, 1);
  assert.deepEqual([mailer.sent[0].to, mailer.sent[0].subject], ["known@x.com", "Your pre-order is confirmed: Shoe (Red) and 1 more"]);
  assert.ok(mailer.sent[0].text.includes("Hat") && !mailer.sent[0].text.includes("Sock"));
  assert.equal((await processFlowDeliveries(db, { shop, mailer, now: NOW })).sent, 0, "never twice");
});

test("pre-order confirmation: no address is skipped, a cancelled order is not confirmed, a normal order queues nothing", async () => {
  const shop = newShop();
  await seedTwo(shop);
  await recordPreorderOrder(db, { shop, payload: twoLineOrder({ id: 1, customer: null }) });       // no address stored
  assert.deepEqual(await enqueuePreorderConfirmation(db, { shop, orderId: "1", resolveHandles: handlesFor }), { queued: false });
  const [skipped] = await deliveries(shop);
  assert.deepEqual([skipped.status, skipped.lastError], ["SKIPPED", SKIP_NO_EMAIL]);
  await record(shop, twoLineOrder({ id: 2 }));
  await cancelPreorderOrder(db, { shop, payload: { id: 2 } });
  assert.deepEqual(await enqueuePreorderConfirmation(db, { shop, orderId: "2", resolveHandles: handlesFor }), { queued: false });
  await record(shop, orderPayload({ id: 3, line_items: [{ id: 1, variant_id: 5, product_id: 1, title: "Plain", quantity: 1, properties: [] }] }));
  assert.deepEqual(await enqueuePreorderConfirmation(db, { shop, orderId: "3", resolveHandles: handlesFor }), { queued: false });
  assert.equal((await deliveries(shop)).length, 1, "only the skipped record exists");
});

test("orders/create: the confirmation is queued only when the toggle is on AND Gmail can send; the order is always recorded", async () => {
  const shop = newShop();
  await seedTwo(shop);
  const ready = { configured: true, channel: "smtp" };
  const run = (id, status, payload = twoLineOrder({ id })) => handleOrderCreate({ db, shop, payload, admin: adminStub(), emailStatus: status });
  // toggle off (no settings row)
  let r = await run(6101, ready);
  assert.deepEqual([r.stored, r.confirmationQueued], [2, false]);
  await db.shopSettings.create({ data: { shop, emailPreorderConfirmation: true } });
  // toggle on, Gmail not connected: recorded without an address, nothing queued
  r = await run(6102, { configured: false, channel: null });
  assert.deepEqual([r.stored, r.confirmationQueued], [2, false]);
  assert.equal((await db.preorderOrder.findFirst({ where: { shop, orderId: "6102" } })).email, null, "the address is only kept when Gmail sends");
  assert.equal((await deliveries(shop)).length, 0);
  // toggle on + Gmail: queued, the address is kept, a webhook retry queues nothing more
  r = await run(6103, ready);
  assert.deepEqual([r.stored, r.confirmationQueued], [2, true]);
  assert.equal((await db.preorderOrder.findFirst({ where: { shop, orderId: "6103" } })).email, "known@x.com");
  r = await run(6103, ready);
  assert.deepEqual([r.stored, r.confirmationQueued], [0, false]);
  assert.deepEqual((await deliveries(shop)).map((d) => [d.kind, d.eventId]), [["PREORDER_CONFIRMATION", "confirm:6103"]]);
  // an order without pre-order lines is ignored entirely
  r = await run(6104, ready, orderPayload({ id: 6104, line_items: [{ id: 1, variant_id: 5, product_id: 1, title: "Plain", quantity: 1, properties: [] }] }));
  assert.deepEqual([r.stored, r.confirmationQueued], [0, false]);
});

test("pre-order confirmation: customers/redact removes the queued confirmation", async () => {
  const shop = newShop();
  await seedTwo(shop);
  await record(shop, twoLineOrder());
  await enqueuePreorderConfirmation(db, { shop, orderId: "6001", resolveHandles: handlesFor });
  assert.equal((await deliveries(shop)).length, 1);
  await handleCustomerRedact({ db, shop, payload: { customer: { id: 77, email: "known@x.com" } } });
  assert.equal((await deliveries(shop)).length, 0);
  assert.equal(await db.preorderOrder.count({ where: { shop } }), 0);
});

// ---- privacy ----------------------------------------------------------------------------------------------

test("privacy: customers/redact removes the customer's pre-order lines and their emails; shop/redact removes everything", async () => {
  const shop = newShop(), other = newShop();
  for (const s of [shop, other]) {
    await seedConfig(s);
    await record(s, orderPayload({ id: 1 }));
    await record(s, orderPayload({ id: 2, customer: { id: 88 } }));
    await enqueueShipEmails(db, { shop: s, settings: allOn, resolveHandles, now: NOW });
  }
  assert.equal((await deliveries(shop)).length, 2);
  const out = await handleCustomerRedact({ db, shop, payload: { customer: { id: 77, email: "known@x.com" } } });
  assert.ok(out.deleted >= 1);
  assert.deepEqual((await db.preorderOrder.findMany({ where: { shop } })).map((o) => o.customerId), ["88"]);
  assert.equal((await deliveries(shop)).length, 1, "the redacted customer's deliveries are gone");
  assert.equal((await db.preorderOrder.count({ where: { shop: other } })), 2, "other shops are untouched");
  assert.equal(await db.notificationAttempt.count({ where: { shop, deliveryId: { notIn: (await deliveries(shop)).map((d) => d.id) } } }), 0);
  await handleShopRedact({ db, shop });
  assert.equal(await db.preorderOrder.count({ where: { shop } }), 0);
  assert.equal(await db.preorderOrder.count({ where: { shop: other } }), 2);
});
