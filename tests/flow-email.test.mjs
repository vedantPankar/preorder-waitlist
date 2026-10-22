import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, variant } from "./helpers.mjs";
import { getMailer, flowPayload, FLOW_TRIGGERS, FLOW_TRIGGER_HANDLE, SKIP_NO_CUSTOMER } from "../app/lib/mailer.server.js";
import { addSignup } from "../app/lib/waitlist.server.js";
import { handleSignupRequest } from "../app/lib/signup.server.js";
import { enqueueSignupConfirmation, enqueueShipEmails, processFlowDeliveries, runFlowKinds, dateKey } from "../app/lib/flow-notify.server.js";
import { processQueue, enqueueRestock, retryFailedDeliveries, MAX_ATTEMPTS } from "../app/lib/notify.server.js";
import { runQueueForShop, shopsWithDueWork, queueDepth } from "../app/lib/queue-runner.server.js";
import { recordPreorderOrder, cancelPreorderOrder } from "../app/lib/preorder-orders.server.js";
import { handleCustomerRedact, handleShopRedact } from "../app/lib/webhooks.server.js";
import { parseSettingsForm, settingsView } from "../app/lib/settings.server.js";
import { isValidEmail, cleanText } from "../app/lib/validation.server.js";

let db;
before(async () => { db = await createTestDb(); });

const FLOW_ENV = { EMAIL_PROVIDER: "shopify_flow" };
let n = 0;
const newShop = () => `fe${++n}.myshopify.com`;
const D = (s) => new Date(`${s}T00:00:00Z`);
const NOW = new Date("2026-11-10T12:00:00Z");

/** Fake Admin: answers the customer lookup (by email) and the Flow trigger, and records every trigger fired. */
function flowAdmin({ customers = { "known@x.com": "gid://shopify/Customer/77" }, fail = null, userErrors = [] } = {}) {
  const triggers = [], lookups = [];
  return {
    triggers, lookups,
    graphql: async (query, opts) => {
      const json = async () => {
        if (query.includes("customers(")) {
          const email = /email:"([^"]*)"/.exec(opts.variables.query)?.[1];
          lookups.push(email);
          return { data: { customers: { nodes: customers[email] ? [{ id: customers[email] }] : [] } } };
        }
        if (query.includes("flowTriggerReceive")) {
          if (fail === "network") throw new Error("boom");
          if (fail === "api") return { errors: [{ message: "throttled" }] };
          triggers.push(opts.variables);
          return { data: { flowTriggerReceive: { userErrors } } };
        }
        // variant lookup (fetchVariants)
        return { data: { nodes: [{ id: "gid://shopify/ProductVariant/111", title: "Red", inventoryQuantity: 0, inventoryPolicy: "DENY", product: { id: "gid://shopify/Product/999", title: "Shoe", handle: "shoe" } }] } };
      };
      return { json };
    },
  };
}
const flowMailerFor = (admin) => getMailer(FLOW_ENV, undefined, { admin });
const deliveries = (shop, where = {}) => db.notificationDelivery.findMany({ where: { shop, ...where }, orderBy: { queuedAt: "asc" } });

// ---- trigger payloads ---------------------------------------------------------------------------------------

test("each kind fires its own trigger with the documented payload", async () => {
  const ctx = { shop: "s.myshopify.com", productTitle: "Shoe", variantTitle: "Red", productUrl: "https://s.myshopify.com/products/shoe", orderName: "#1001", shipDate: "2026-11-13" };
  assert.deepEqual(Object.keys(FLOW_TRIGGERS).sort(), ["RESTOCK", "SHIP_DATE_CHANGE", "SHIP_REMINDER", "SIGNUP_CONFIRMATION"]);
  assert.equal(FLOW_TRIGGERS.RESTOCK, FLOW_TRIGGER_HANDLE);
  const base = { customer_id: 77, "Product title": "Shoe", "Variant title": "Red", "Product link": ctx.productUrl, "Store domain": "s.myshopify.com" };
  assert.deepEqual(flowPayload("SIGNUP_CONFIRMATION", 77, ctx), base);
  assert.deepEqual(flowPayload("SHIP_REMINDER", 77, ctx), { ...base, Reason: "reminder", "Order name": "#1001", "Ship date": "2026-11-13" });
  assert.deepEqual(flowPayload("SHIP_DATE_CHANGE", 77, ctx), { ...base, Reason: "changed", "Order name": "#1001", "Ship date": "2026-11-13" });

  const admin = flowAdmin();
  const mailer = flowMailerFor(admin);
  await mailer.send({ to: "known@x.com", kind: "SIGNUP_CONFIRMATION", context: ctx });
  await mailer.send({ customerId: "gid://shopify/Customer/77", kind: "SHIP_REMINDER", context: ctx });
  await mailer.send({ customerId: 77, kind: "SHIP_DATE_CHANGE", context: ctx });
  assert.deepEqual(admin.triggers.map((t) => t.handle), ["waitlist-signup-confirmation", "preorder-ship-date-update", "preorder-ship-date-update"]);
  assert.deepEqual(admin.triggers.map((t) => t.payload.Reason), [undefined, "reminder", "changed"]);
  assert.deepEqual(admin.lookups, ["known@x.com"], "a known customer id needs no lookup");
});

test("no Shopify customer is a skip (not a failure) for every kind; unknown kinds are rejected", async () => {
  const admin = flowAdmin();
  const mailer = flowMailerFor(admin);
  for (const kind of ["RESTOCK", "SIGNUP_CONFIRMATION"]) {
    await assert.rejects(() => mailer.send({ to: "guest@x.com", kind, context: {} }), (e) => e.skip === true && e.retryable === false && /No Shopify customer/.test(e.message));
  }
  await assert.rejects(() => mailer.send({ kind: "SHIP_REMINDER", context: {} }), (e) => e.skip === true);
  assert.equal(admin.triggers.length, 0, "no trigger is fired for a guest");
  await assert.rejects(() => mailer.send({ customerId: 1, kind: "NOPE", context: {} }), /Unknown email kind/);
  assert.equal(mailer.channel, "flow");
  assert.equal(getMailer({ EMAIL_PROVIDER: "resend", EMAIL_API_KEY: "k", EMAIL_FROM: "a@b.com" }).channel, undefined);
});

// ---- settings toggles ---------------------------------------------------------------------------------------

test("settings: new emails are off by default, 3 days, validated, saved and kept when a form omits them", async () => {
  const deps = { isValidEmail, cleanText };
  const f = (o) => new URLSearchParams(o);
  const v = settingsView(null);
  assert.deepEqual([v.emailSignupConfirmation, v.emailShipReminder, v.emailShipDateChange, v.shipReminderDays], [false, false, false, 3]);
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

const signupAdmin = flowAdmin({ customers: { "known@x.com": "gid://shopify/Customer/77" } });
const input = (email = "known@x.com") => ({ email, productId: "999", variantId: "111" });

test("signup confirmation: queued only when the toggle is on AND the channel is Flow; the entry stays waiting", async () => {
  const shop = newShop();
  // toggle off (no settings row): nothing queued
  let r = await handleSignupRequest({ db, admin: signupAdmin, shop, input: input("a@x.com"), canConfirm: true });
  assert.deepEqual([r.status, r.confirmationQueued], [200, false]);
  await db.shopSettings.create({ data: { shop, emailSignupConfirmation: true } });
  // toggle on but not the Flow channel (Resend/Postmark): nothing queued
  r = await handleSignupRequest({ db, admin: signupAdmin, shop, input: input("b@x.com"), canConfirm: false });
  assert.equal(r.confirmationQueued, false);
  assert.equal((await deliveries(shop)).length, 0);
  // on + Flow: one delivery, JSON body unchanged, entry still ACTIVE
  r = await handleSignupRequest({ db, admin: signupAdmin, shop, input: input("known@x.com"), canConfirm: true });
  assert.deepEqual([r.body, r.confirmationQueued], [{ ok: true, result: "created" }, true]);
  const [d] = await deliveries(shop);
  assert.deepEqual([d.kind, d.status, JSON.parse(d.payload).productTitle], ["SIGNUP_CONFIRMATION", "QUEUED", "Shoe"]);
  assert.ok(!d.payload.includes("@"), "no email address in the payload");
  assert.equal((await db.waitlistEntry.findFirst({ where: { shop, email: "known@x.com" } })).status, "ACTIVE");
  // a duplicate signup does not queue a second confirmation
  r = await handleSignupRequest({ db, admin: signupAdmin, shop, input: input("known@x.com"), canConfirm: true });
  assert.deepEqual([r.body.result, r.confirmationQueued], ["duplicate", false]);
  assert.equal((await deliveries(shop)).length, 1);
});

test("signup confirmation: sent once through Flow, accepted, entry still waiting; concurrent runners cannot double-send", async () => {
  const shop = newShop();
  await db.shopSettings.create({ data: { shop, emailSignupConfirmation: true } });
  const admin = flowAdmin();
  await handleSignupRequest({ db, admin, shop, input: input("known@x.com"), canConfirm: true });
  const mailer = flowMailerFor(admin);
  const runs = await Promise.all([processFlowDeliveries(db, { shop, mailer, now: NOW }), processFlowDeliveries(db, { shop, mailer, now: NOW })]);
  assert.equal(runs.reduce((a, r) => a + r.sent, 0), 1);
  assert.equal(admin.triggers.length, 1, "exactly one trigger fired");
  assert.equal(admin.triggers[0].handle, "waitlist-signup-confirmation");
  const [d] = await deliveries(shop);
  assert.deepEqual([d.status, d.attempts], ["ACCEPTED", 1]);
  assert.equal((await db.notificationAttempt.findMany({ where: { shop, deliveryId: d.id } })).map((a) => a.outcome).join(), "ACCEPTED");
  assert.equal((await db.waitlistEntry.findFirst({ where: { shop } })).status, "ACTIVE");
  assert.deepEqual(await processFlowDeliveries(db, { shop, mailer, now: NOW }), { sent: 0, failed: 0, retried: 0, skipped: 0, deferred: 0 }, "nothing is sent twice");
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

test("signup confirmation: a guest (no Shopify customer) is skipped and recorded, not failed or retried", async () => {
  const shop = newShop();
  await db.shopSettings.create({ data: { shop, emailSignupConfirmation: true } });
  const admin = flowAdmin();
  await handleSignupRequest({ db, admin, shop, input: input("guest@x.com"), canConfirm: true });
  const r = await processFlowDeliveries(db, { shop, mailer: flowMailerFor(admin), now: NOW });
  assert.deepEqual([r.sent, r.failed, r.skipped], [0, 0, 1]);
  const [d] = await deliveries(shop);
  assert.deepEqual([d.status, d.lastError], ["SKIPPED", SKIP_NO_CUSTOMER]);
  assert.equal(admin.triggers.length, 0);
  assert.equal((await db.waitlistEntry.findFirst({ where: { shop } })).status, "ACTIVE", "the guest keeps waiting for restock");
  assert.equal(await retryFailedDeliveries(db, shop), 0, "skipped is not a failure to retry");
});

test("signup confirmation: an entry removed before sending is skipped", async () => {
  const shop = newShop();
  const admin = flowAdmin();
  const v = variant();
  const s = await addSignup(db, { shop, email: "known@x.com", variant: v });
  await enqueueSignupConfirmation(db, { shop, entry: s.entry, variant: v });
  await db.waitlistEntry.updateMany({ where: { shop }, data: { status: "REMOVED" } });
  const r = await processFlowDeliveries(db, { shop, mailer: flowMailerFor(admin), now: NOW });
  assert.equal(r.skipped, 1); assert.equal(admin.triggers.length, 0);
});

// ---- retries ----------------------------------------------------------------------------------------------

test("retries: transient errors back off 1/5/30 min then fail; permanent errors fail at once; the failed retry button re-queues", async () => {
  const shop = newShop();
  const v = variant();
  const s = await addSignup(db, { shop, email: "known@x.com", variant: v });
  await enqueueSignupConfirmation(db, { shop, entry: s.entry, variant: v });
  const admin = flowAdmin({ fail: "api" });
  const mailer = flowMailerFor(admin);
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
  const ok = await processFlowDeliveries(db, { shop, mailer: flowMailerFor(flowAdmin()), now: t });
  assert.equal(ok.sent, 1);

  const shop2 = newShop();
  const s2 = await addSignup(db, { shop: shop2, email: "known@x.com", variant: v });
  await enqueueSignupConfirmation(db, { shop: shop2, entry: s2.entry, variant: v });
  const perm = await processFlowDeliveries(db, { shop: shop2, mailer: flowMailerFor(flowAdmin({ userErrors: [{ message: "Trigger not found" }] })), now: NOW });
  assert.deepEqual([perm.failed, (await deliveries(shop2))[0].status], [1, "FAILED"]);
});

test("nothing is sent (and nothing is lost) unless the channel is Flow", async () => {
  const shop = newShop();
  const v = variant();
  const s = await addSignup(db, { shop, email: "known@x.com", variant: v });
  await enqueueSignupConfirmation(db, { shop, entry: s.entry, variant: v });
  const sent = [];
  const r = await processFlowDeliveries(db, { shop, mailer: { send: async (m) => sent.push(m) }, now: NOW });
  assert.deepEqual([r.sent, sent.length, (await deliveries(shop))[0].status], [0, 0, "QUEUED"]);
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

test("orders: only pre-order lines are stored, with no personal data; webhook retries are idempotent", async () => {
  const shop = newShop();
  await seedConfig(shop);
  assert.deepEqual(await recordPreorderOrder(db, { shop, payload: orderPayload() }), { stored: 1 });
  assert.deepEqual(await recordPreorderOrder(db, { shop, payload: orderPayload() }), { stored: 0 });
  const rows = await db.preorderOrder.findMany({ where: { shop } });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].customerId, rows[0].variantId, rows[0].quantity, rows[0].orderName, dateKey(rows[0].lastShipDate)], ["77", "111", 2, "#1001", "2026-11-13"]);
  assert.ok(!JSON.stringify(rows).includes("@"), "no email stored");
  assert.deepEqual(await recordPreorderOrder(db, { shop, payload: { id: 9, line_items: [{ id: 1, variant_id: 5, properties: [] }] } }), { stored: 0 });
  assert.deepEqual(await recordPreorderOrder(db, { shop, payload: {} }), { stored: 0 });
  assert.equal((await recordPreorderOrder(db, { shop, payload: orderPayload({ id: 5002, customer: null }) })).stored, 1);
  assert.equal((await db.preorderOrder.findFirst({ where: { shop, orderId: "5002" } })).customerId, null);
});

// ---- ship-date reminders and change notices ----------------------------------------------------------------

const allOn = { emailShipReminder: true, emailShipDateChange: true, emailSignupConfirmation: true, shipReminderDays: 3 };
const resolveHandles = async () => new Map([["111", "shoe"]]);

test("reminder: queued once, only inside the window, only while the toggle is on, with the documented payload", async () => {
  const shop = newShop();
  await seedConfig(shop);
  await recordPreorderOrder(db, { shop, payload: orderPayload() });
  const run = (settings, now) => enqueueShipEmails(db, { shop, settings, resolveHandles, now });
  assert.deepEqual(await run(allOn, new Date("2026-11-09T12:00:00Z")), { reminders: 0, changes: 0, skipped: 0 }); // 4 days out
  assert.deepEqual(await run({ ...allOn, emailShipReminder: false }, NOW), { reminders: 0, changes: 0, skipped: 0 }); // toggle off
  assert.equal((await run(allOn, NOW)).reminders, 1);                // 3 days out (Nov 13 00:00 vs Nov 10 12:00 = 2.5 days)
  assert.equal((await run(allOn, new Date("2026-11-11T12:00:00Z"))).reminders, 0, "never twice for the same date");
  assert.equal((await run(allOn, new Date("2026-11-14T00:00:00Z"))).reminders, 0, "no reminder once the date has passed");
  const [d] = await deliveries(shop);
  assert.deepEqual([d.kind, d.status, d.eventId], ["SHIP_REMINDER", "QUEUED", "reminder:2026-11-13"]);
  const admin = flowAdmin();
  assert.equal((await processFlowDeliveries(db, { shop, mailer: flowMailerFor(admin), now: NOW })).sent, 1);
  assert.deepEqual(admin.triggers[0], { handle: "preorder-ship-date-update", payload: { customer_id: 77, "Product title": "Shoe", "Variant title": "Red", "Product link": `https://${shop}/products/shoe`, "Store domain": shop, Reason: "reminder", "Order name": "#1001", "Ship date": "2026-11-13" } });
});

test("reminder: the days setting controls the window", async () => {
  const shop = newShop();
  await seedConfig(shop);
  await recordPreorderOrder(db, { shop, payload: orderPayload() });
  const at = new Date("2026-11-08T00:00:00Z"); // 5 days out
  assert.equal((await enqueueShipEmails(db, { shop, settings: { ...allOn, shipReminderDays: 3 }, resolveHandles, now: at })).reminders, 0);
  assert.equal((await enqueueShipEmails(db, { shop, settings: { ...allOn, shipReminderDays: 7 }, resolveHandles, now: at })).reminders, 1);
});

test("change notice: sent once when the date moves; lastShipDate follows; no stale mail after the toggle is turned on", async () => {
  const shop = newShop();
  await seedConfig(shop);
  await recordPreorderOrder(db, { shop, payload: orderPayload() });
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
  const admin = flowAdmin();
  await processFlowDeliveries(db, { shop, mailer: flowMailerFor(admin), now: far });
  assert.equal(admin.triggers[0].payload.Reason, "changed");
});

test("change notice uses a campaign's ship date when the variant has none of its own, and is not followed by a duplicate reminder", async () => {
  const shop = newShop();
  const camp = await db.campaign.create({ data: { shop, name: "Launch", shipDate: D("2026-11-20"), state: "PUBLISHED" } });
  await seedConfig(shop, { shipDate: null, campaignId: camp.id });
  await recordPreorderOrder(db, { shop, payload: orderPayload({ line_items: [{ id: 1, variant_id: 111, product_id: 999, title: "Shoe", quantity: 1, properties: [{ name: "_preorder", value: "true" }] }] }) });
  assert.equal(dateKey((await db.preorderOrder.findFirst({ where: { shop } })).lastShipDate), "2026-11-20", "falls back to the campaign date");
  await db.campaign.update({ where: { id: camp.id }, data: { shipDate: D("2026-11-12") } }); // moved up, now inside the window
  const r = await enqueueShipEmails(db, { shop, settings: allOn, resolveHandles, now: NOW });
  assert.deepEqual([r.changes, r.reminders], [1, 0], "the change notice already told them the date");
  assert.deepEqual((await deliveries(shop)).map((d) => d.kind), ["SHIP_DATE_CHANGE"]);
});

test("ship-date emails: guests are recorded as skipped, cancelled orders are left alone", async () => {
  const shop = newShop();
  await seedConfig(shop);
  await recordPreorderOrder(db, { shop, payload: orderPayload({ id: 1, customer: null }) });
  await recordPreorderOrder(db, { shop, payload: orderPayload({ id: 2 }) });
  await cancelPreorderOrder(db, { shop, payload: { id: 2 } });
  const r = await enqueueShipEmails(db, { shop, settings: allOn, resolveHandles, now: NOW });
  assert.deepEqual([r.reminders, r.skipped], [0, 1]);
  const [d] = await deliveries(shop);
  assert.deepEqual([d.status, d.lastError, d.kind], ["SKIPPED", SKIP_NO_CUSTOMER, "SHIP_REMINDER"]);
  const admin = flowAdmin();
  assert.deepEqual(await processFlowDeliveries(db, { shop, mailer: flowMailerFor(admin), now: NOW }), { sent: 0, failed: 0, retried: 0, skipped: 0, deferred: 0 });
  assert.equal(admin.triggers.length, 0);
});

// ---- the queue: isolation from restock, runner, scheduler ------------------------------------------------------

test("restock and the new kinds share the table but never each other's rows", async () => {
  const shop = newShop();
  await db.shopSettings.create({ data: { shop, ...allOn } });
  const v = variant({ inventoryQuantity: 0 });
  const s = await addSignup(db, { shop, email: "known@x.com", variant: v });
  await enqueueSignupConfirmation(db, { shop, entry: s.entry, variant: v });
  const admin = flowAdmin();
  const mailer = flowMailerFor(admin);
  // the restock sender ignores the confirmation (the variant is out of stock and must not block it either)
  const restocked = { ...v, inventoryQuantity: 5 };
  assert.equal((await enqueueRestock(db, { shop, variant: restocked, now: NOW })).queued, 1);
  const r = await processQueue(db, { shop, mailer, stockCheck: async () => restocked, now: NOW });
  assert.equal(r.sent, 1);
  assert.deepEqual(admin.triggers.map((t) => t.handle), [FLOW_TRIGGER_HANDLE], "only the restock email went out");
  assert.deepEqual((await deliveries(shop)).map((d) => [d.kind, d.status]), [["SIGNUP_CONFIRMATION", "QUEUED"], ["RESTOCK", "ACCEPTED"]]);
  // the flow processor sends the confirmation, and leaves the (now NOTIFIED) entry alone
  assert.equal((await processFlowDeliveries(db, { shop, mailer, now: NOW })).sent, 1);
  assert.equal((await db.waitlistEntry.findFirst({ where: { shop } })).status, "NOTIFIED");
});

test("restock: a waiting guest is skipped (not failed) and shown as skipped: no Shopify customer", async () => {
  const shop = newShop();
  const v = variant({ inventoryQuantity: 0 });
  await addSignup(db, { shop, email: "guest@x.com", variant: v });
  const restocked = { ...v, inventoryQuantity: 5 };
  await enqueueRestock(db, { shop, variant: restocked, now: NOW });
  const admin = flowAdmin();
  const r = await processQueue(db, { shop, mailer: flowMailerFor(admin), stockCheck: async () => restocked, now: NOW });
  assert.deepEqual([r.sent, r.failed, r.skipped], [0, 0, 1]);
  const [d] = await deliveries(shop);
  assert.deepEqual([d.status, d.lastError], ["SKIPPED", SKIP_NO_CUSTOMER]);
  assert.equal(admin.triggers.length, 0);
});

test("runner: one pass queues ship-date emails and sends them; the scheduler sees shops with open pre-orders", async () => {
  const shop = newShop();
  await db.shopSettings.create({ data: { shop, ...allOn } });
  await seedConfig(shop);
  await recordPreorderOrder(db, { shop, payload: orderPayload() });
  assert.ok((await shopsWithDueWork(db, NOW)).includes(shop), "a shop with open pre-orders is visited");
  const admin = flowAdmin();
  const r = await runQueueForShop({ db, shop, admin, mailer: flowMailerFor(admin), now: NOW });
  assert.equal(r.sent, 1);
  assert.equal(admin.triggers.length, 1);
  assert.equal(admin.triggers[0].payload["Product link"], `https://${shop}/products/shoe`);
  assert.equal((await runQueueForShop({ db, shop, admin, mailer: flowMailerFor(admin), now: NOW })).sent, 0, "a second pass sends nothing");
  assert.equal(admin.triggers.length, 1);
  assert.equal(await queueDepth(db, shop), 0);
  // not the Flow channel: nothing queued, nothing sent
  const shop2 = newShop();
  await db.shopSettings.create({ data: { shop: shop2, ...allOn } });
  await seedConfig(shop2);
  await recordPreorderOrder(db, { shop: shop2, payload: orderPayload() });
  const sent = [];
  assert.deepEqual(await runFlowKinds(db, { shop: shop2, admin, mailer: { send: async (m) => sent.push(m) }, now: NOW }), { sent: 0, failed: 0, retried: 0, skipped: 0, deferred: 0 });
  assert.equal((await deliveries(shop2)).length, 0);
});

// ---- privacy ----------------------------------------------------------------------------------------------

test("privacy: customers/redact removes the customer's pre-order lines and their emails; shop/redact removes everything", async () => {
  const shop = newShop(), other = newShop();
  for (const s of [shop, other]) {
    await seedConfig(s);
    await recordPreorderOrder(db, { shop: s, payload: orderPayload({ id: 1 }) });
    await recordPreorderOrder(db, { shop: s, payload: orderPayload({ id: 2, customer: { id: 88 } }) });
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
