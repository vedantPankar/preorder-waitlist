import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, variant } from "./helpers.mjs";
import { encryptSecret, decryptSecret, scrub, secretsAvailable, SecretKeyMissingError } from "../app/lib/secrets.server.js";
import { createGmailMailer, normalizeAccount, reserveSlot, nextDayStart, dayKey, classifySmtpError, AUTH_MESSAGE, AUTH_FLAG } from "../app/lib/gmail.server.js";
import { getShopMailer, getEmailStatus, gmailState, anyGmailShop } from "../app/lib/shop-mailer.server.js";
import { applyGmailCredentials, normalizeAppPassword } from "../app/lib/gmail-settings.server.js";
import { parseSettingsForm, settingsView } from "../app/lib/settings.server.js";
import { addSignup } from "../app/lib/waitlist.server.js";
import { enqueueRestock, processQueue, retryFailedDeliveries } from "../app/lib/notify.server.js";
import { handleSignupRequest } from "../app/lib/signup.server.js";
import { enqueueSignupConfirmation, enqueueShipEmails, processFlowDeliveries, SKIP_NO_EMAIL } from "../app/lib/flow-notify.server.js";
import { recordPreorderOrder } from "../app/lib/preorder-orders.server.js";
import { handleCustomerRedact } from "../app/lib/webhooks.server.js";
import { SKIP_NO_CUSTOMER } from "../app/lib/mailer.server.js";
import { isValidEmail, cleanText } from "../app/lib/validation.server.js";

process.env.SHOPIFY_API_SECRET ||= "test-api-secret-0123456789";
const PW = "abcdefghijklmnop"; // a well-formed app password
const ENV = { SHOPIFY_API_SECRET: "test-api-secret-0123456789" };

let db;
before(async () => { db = await createTestDb(); });
let n = 0;
const newShop = () => `gm${++n}.myshopify.com`;
const D = (s) => new Date(`${s}T00:00:00Z`);
const NOON = new Date("2026-11-10T12:00:00Z");

/** A fake SMTP transport factory; `t.fail` (an error, or a function (message) => error|null) makes sends fail. */
function fakeTransport() {
  const t = { calls: [], created: 0, fail: null, verifyFail: null, accepted: true };
  t.factory = (opts) => {
    t.created++;
    return {
      sendMail: async (m) => {
        t.calls.push({ ...m, auth: opts.auth });
        const err = typeof t.fail === "function" ? t.fail(m) : t.fail;
        if (err) throw err;
        return { accepted: t.accepted ? [m.to] : [], rejected: t.accepted ? [] : [m.to], messageId: `<m${t.calls.length}@gmail>` };
      },
      verify: async () => { if (t.verifyFail) throw t.verifyFail; return true; },
    };
  };
  return t;
}
const smtpErr = (code, response, extra = {}) => Object.assign(new Error(`${code} ${response} ${PW}`), { responseCode: code, response: `${response} ${PW}`, ...extra });
const authErr = () => smtpErr(535, "5.7.8 Username and Password not accepted", { code: "EAUTH" });

async function connect(shop, { address = "store@gmail.com", cap = 400, password = PW, extra = {} } = {}) {
  const data = { gmailAddress: address, gmailPasswordEnc: encryptSecret(password, { shop, env: ENV }), dailySendCap: cap, ...extra };
  await db.shopSettings.upsert({ where: { shop }, create: { shop, ...data }, update: data });
}
const deliveries = (shop, where = {}) => db.notificationDelivery.findMany({ where: { shop, ...where }, orderBy: { queuedAt: "asc" } });
const smtp = (shop, t, extra = {}) => getShopMailer(db, shop, { env: ENV, transportFactory: t.factory, ...extra });

/** Captures everything written to the console while `fn` runs. */
async function captureLogs(fn) {
  const lines = [];
  const orig = {};
  for (const k of ["log", "info", "warn", "error", "debug"]) { orig[k] = console[k]; console[k] = (...a) => lines.push(a.map(String).join(" ")); }
  try { await fn(); } finally { for (const k of Object.keys(orig)) console[k] = orig[k]; }
  return lines.join("\n");
}

// ---- encryption -----------------------------------------------------------------------------------------------

test("encryption: round trip, random IV, bound to the shop, tamper-proof, key-dependent, never plaintext", () => {
  const a = encryptSecret(PW, { shop: "a.myshopify.com", env: ENV }), b = encryptSecret(PW, { shop: "a.myshopify.com", env: ENV });
  assert.match(a, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.notEqual(a, b, "a fresh IV for every value");
  assert.ok(!a.includes(PW));
  assert.equal(decryptSecret(a, { shop: "a.myshopify.com", env: ENV }), PW);
  assert.equal(decryptSecret(a, { shop: "b.myshopify.com", env: ENV }), null, "a copy in another shop's row does not decrypt");
  const [v, iv, tag, ct] = a.split(".");
  const flip = Buffer.from(ct, "base64url"); flip[0] ^= 1;
  assert.equal(decryptSecret([v, iv, tag, flip.toString("base64url")].join("."), { shop: "a.myshopify.com", env: ENV }), null, "tampered ciphertext");
  assert.equal(decryptSecret(a.replace(/^v1/, "v2"), { shop: "a.myshopify.com", env: ENV }), null);
  for (const junk of [null, undefined, "", "v1.x", "v1...", 42]) assert.equal(decryptSecret(junk, { shop: "a.myshopify.com", env: ENV }), null);
  assert.equal(decryptSecret(a, { shop: "a.myshopify.com", env: { SHOPIFY_API_SECRET: "a-different-secret-value" } }), null, "a rotated key cannot read it");
});

test("key management: EMAIL_SETTINGS_KEY wins over SHOPIFY_API_SECRET; no key means a clear error and nothing is encrypted", () => {
  const dedicated = { ...ENV, EMAIL_SETTINGS_KEY: "dedicated-key-material" };
  const blob = encryptSecret(PW, { shop: "s", env: dedicated });
  assert.equal(decryptSecret(blob, { shop: "s", env: dedicated }), PW);
  assert.equal(decryptSecret(blob, { shop: "s", env: ENV }), null, "the API secret alone is not the dedicated key");
  assert.equal(secretsAvailable({}), false); assert.equal(secretsAvailable({ SHOPIFY_API_SECRET: "short" }), false); assert.equal(secretsAvailable(ENV), true);
  assert.throws(() => encryptSecret(PW, { shop: "s", env: {} }), (e) => e instanceof SecretKeyMissingError && !e.message.includes(PW));
  assert.equal(decryptSecret(blob, { shop: "s", env: {} }), null, "decrypting without a key is a null, not a crash");
  assert.equal(scrub(`failed with ${PW} and ${PW}`, [PW, "ab"]), "failed with [hidden] and [hidden]");
});

// ---- storing credentials -----------------------------------------------------------------------------------------

test("saving: the app password is verified, encrypted at rest, and never comes back out", async () => {
  const shop = newShop();
  const t = fakeTransport();
  const form = (o) => new URLSearchParams({ _form: "settings", dailySendCap: "400", ...o });
  const parsed = parseSettingsForm(form({ gmailAddress: "Store@Gmail.com", gmailPassword: PW }), null, { isValidEmail, cleanText });
  assert.ok(!JSON.stringify(parsed.data).includes(PW), "the parser never sees or returns the password");
  assert.equal(parsed.data.gmailAddress, "store@gmail.com");
  const r = await applyGmailCredentials({ db, shop, current: null, data: parsed.data, password: "abcd efgh ijkl mnop", env: ENV, transportFactory: t.factory });
  assert.ok(!r.errors, JSON.stringify(r));
  assert.equal(r.data.gmailPasswordEnc.startsWith("v1."), true);
  await db.shopSettings.upsert({ where: { shop }, create: { shop, ...r.data }, update: r.data });
  const row = await db.shopSettings.findUnique({ where: { shop } });
  assert.ok(!JSON.stringify(row).includes("abcdefghijklmnop") && !JSON.stringify(row).includes("abcd efgh"), "no plaintext in the database row");
  assert.equal(decryptSecret(row.gmailPasswordEnc, { shop, env: ENV }), "abcdefghijklmnop", "spaces from Google's display are not part of the password");
  const view = settingsView(row);
  assert.deepEqual([view.gmailAddress, view.gmailConfigured, view.dailySendCap], ["store@gmail.com", true, 400]);
  assert.ok(!JSON.stringify(view).includes("v1.") && !Object.keys(view).some((k) => /password/i.test(k) && k !== "gmailConfigured"), "the page data holds no password or ciphertext");
  const status = await getEmailStatus(db, shop, { env: ENV });
  assert.deepEqual([status.configured, status.channel, status.gmail.state, status.gmail.address], [true, "smtp", "ok", "store@gmail.com"]);
  assert.ok(!JSON.stringify(status).includes(PW) && !JSON.stringify(status).includes("v1."), "the status shown in Settings is secret-free");
  assert.equal(normalizeAppPassword(" ab cd\nef "), "abcdef");
});

test("saving: rejects a wrong-format password, a changed address without a password, a rejected login, and a server with no key", async () => {
  const shop = newShop();
  const t = fakeTransport();
  const base = { gmailAddress: "store@gmail.com", dailySendCap: 400 };
  const run = (over) => applyGmailCredentials({ db, shop, current: null, data: base, env: ENV, transportFactory: t.factory, ...over });
  assert.match((await run({ password: "my-real-gmail-password" })).errors.gmailPassword, /not an app password/);
  assert.match((await run({ password: "" })).errors.gmailPassword, /Enter the app password/, "an address with no password");
  assert.match((await run({ password: PW, data: { ...base, gmailAddress: null } })).errors.gmailAddress, /Gmail address/);
  assert.match((await run({ password: PW, env: {} })).errors.gmailPassword, /encryption key/);
  t.verifyFail = authErr();
  const rej = await run({ password: PW });
  assert.match(rej.errors.gmailPassword, /rejected this app password/);
  assert.ok(!JSON.stringify(rej).includes(PW), "the rejection does not echo the password");
  assert.equal(await db.shopSettings.count({ where: { shop } }), 0, "nothing was stored");
  t.verifyFail = Object.assign(new Error("down"), { code: "ETIMEDOUT" });
  const soft = await run({ password: PW });
  assert.ok(soft.data.gmailPasswordEnc && /could not be reached/.test(soft.warning), "an unreachable Gmail does not block saving");
  // keeping the saved password: same address, blank password field
  const keep = await applyGmailCredentials({ db, shop, current: { gmailAddress: "store@gmail.com", gmailPasswordEnc: "x" }, data: base, password: "", env: ENV });
  assert.deepEqual(keep.data, base);
  assert.match((await applyGmailCredentials({ db, shop, current: { gmailAddress: "old@gmail.com", gmailPasswordEnc: "x" }, data: base, password: "", env: ENV })).errors.gmailPassword, /Enter the app password/, "a new address needs its own password");
});

test("settings form: the daily cap and the address are validated; defaults are 400 and not configured", () => {
  const deps = { isValidEmail, cleanText };
  const f = (o) => new URLSearchParams({ _form: "settings", ...o });
  assert.deepEqual([settingsView(null).dailySendCap, settingsView(null).gmailConfigured], [400, false]);
  for (const bad of ["0", "2001", "1.5", "x", ""]) assert.ok(parseSettingsForm(f({ dailySendCap: bad }), null, deps).errors?.dailySendCap, `cap ${JSON.stringify(bad)}`);
  assert.equal(parseSettingsForm(f({ dailySendCap: "250" }), null, deps).data.dailySendCap, 250);
  assert.ok(parseSettingsForm(f({ dailySendCap: "400", gmailAddress: "not-an-email" }), null, deps).errors.gmailAddress);
  assert.equal(parseSettingsForm(f({ dailySendCap: "400", gmailAddress: "" }), { gmailAddress: "keep@gmail.com" }, deps).data.gmailAddress, "keep@gmail.com", "a blank address keeps the stored one");
});

// ---- channel precedence ------------------------------------------------------------------------------------------

test("channel precedence: shop Gmail > environment; unusable Gmail sends nothing instead of switching sender", async () => {
  const t = fakeTransport();
  const flowEnv = { ...ENV, EMAIL_PROVIDER: "shopify_flow" };
  const admin = { graphql: async () => ({ json: async () => ({}) }) };
  const none = newShop();
  assert.equal(await getShopMailer(db, none, { env: ENV, transportFactory: t.factory }), null, "no Gmail, no env: nothing");
  assert.equal((await getShopMailer(db, none, { env: flowEnv, admin, transportFactory: t.factory })).channel, "flow", "no Gmail: the environment sender");
  const ok = newShop(); await connect(ok);
  const m = await getShopMailer(db, ok, { env: flowEnv, admin, transportFactory: t.factory });
  assert.deepEqual([m.provider, m.channel], ["gmail", "smtp"], "Gmail wins over the environment");
  const bad = newShop(); await connect(bad, { extra: { gmailAuthError: AUTH_FLAG } });
  assert.equal(await getShopMailer(db, bad, { env: flowEnv, admin, transportFactory: t.factory }), null, "sign-in rejected: not the environment sender either");
  const rotated = newShop(); await connect(rotated);
  assert.equal(await getShopMailer(db, rotated, { env: { ...flowEnv, SHOPIFY_API_SECRET: "rotated-secret-value-1" }, admin }), null, "undecryptable password: nothing is sent");
  assert.equal((await getEmailStatus(db, rotated, { env: { SHOPIFY_API_SECRET: "rotated-secret-value-1" } })).gmail.state, "unreadable");
  assert.equal(gmailState({ gmailAddress: "a@b.co", gmailPasswordEnc: null }, { shop: "x" }).state, "none", "an address without a password is not configured");
  await db.shopSettings.update({ where: { shop: ok }, data: { gmailAddress: null, gmailPasswordEnc: null } });
  assert.equal((await getShopMailer(db, ok, { env: flowEnv, admin, transportFactory: t.factory })).channel, "flow", "after disconnecting, the environment again");
  assert.equal(await anyGmailShop(db), true);
});

// ---- guests --------------------------------------------------------------------------------------------------------

const restock = (v) => ({ ...v, inventoryQuantity: 5 });
const waitFor = async (shop, emails, v = variant()) => { for (const email of emails) await addSignup(db, { shop, email, variant: v }); };

test("guests: a back-in-stock email goes to any waitlist address through Gmail (no Shopify customer needed)", async () => {
  const shop = newShop(); await connect(shop);
  const t = fakeTransport();
  await waitFor(shop, ["guest@example.com"]);
  const v = restock(variant());
  await enqueueRestock(db, { shop, variant: v, now: NOON });
  const r = await processQueue(db, { shop, mailer: await smtp(shop, t), stockCheck: async () => v, now: NOON });
  assert.deepEqual([r.sent, r.skipped, r.failed], [1, 0, 0]);
  assert.equal(t.calls[0].to, "guest@example.com");
  assert.equal(t.calls[0].auth.user, "store@gmail.com"); assert.equal(t.calls[0].auth.pass, PW);
  assert.equal(t.calls[0].from, "store@gmail.com");
  assert.match(t.calls[0].subject, /back in stock/);
  assert.equal((await db.waitlistEntry.findFirst({ where: { shop } })).status, "NOTIFIED");
});

test("guests: the signup confirmation is sent to a guest through Gmail, the entry stays waiting, and a duplicate signup is not confirmed twice", async () => {
  const shop = newShop(); await connect(shop, { extra: { emailSignupConfirmation: true } });
  const t = fakeTransport();
  const admin = { graphql: async () => ({ json: async () => ({ data: { nodes: [{ id: "gid://shopify/ProductVariant/111", title: "Red", inventoryQuantity: 0, inventoryPolicy: "DENY", product: { id: "gid://shopify/Product/999", title: "Shoe", handle: "shoe" } }] } }) }) };
  const input = { email: "Guest@Example.com", productId: "999", variantId: "111" };
  const first = await handleSignupRequest({ db, admin, shop, input, canConfirm: true });
  assert.equal(first.confirmationQueued, true);
  assert.equal((await handleSignupRequest({ db, admin, shop, input, canConfirm: true })).confirmationQueued, false);
  const mailer = await smtp(shop, t);
  const r = await processFlowDeliveries(db, { shop, mailer, now: NOON });
  assert.equal(r.sent, 1);
  assert.equal(t.calls[0].to, "guest@example.com");
  assert.equal(t.calls[0].subject, "You're on the list for Shoe (Red)");
  assert.match(t.calls[0].text, /https:\/\/gm\d+\.myshopify\.com\/products\/shoe/);
  assert.equal((await db.waitlistEntry.findFirst({ where: { shop } })).status, "ACTIVE");
  assert.equal((await processFlowDeliveries(db, { shop, mailer, now: NOON })).sent, 0);
});

test("ship-date emails through Gmail: sent to the order's address; an order without an address is skipped; Flow still needs a customer", async () => {
  const shop = newShop(); await connect(shop, { extra: { emailShipReminder: true, shipReminderDays: 3 } });
  await db.preorderConfig.create({ data: { shop, productId: "999", variantId: "111", productTitle: "Shoe", variantTitle: "Red", shipDate: D("2026-11-13") } });
  const order = (id, over) => ({ id, name: `#${id}`, email: `Buyer${id}@Example.com`, customer: null, line_items: [{ id: 1, variant_id: 111, product_id: 999, title: "Shoe", variant_title: "Red", quantity: 1, properties: [{ name: "_preorder", value: "true" }] }], ...over });
  await recordPreorderOrder(db, { shop, payload: order(1), storeEmail: true });
  await recordPreorderOrder(db, { shop, payload: order(2), storeEmail: false });
  assert.equal((await db.preorderOrder.findFirst({ where: { shop, orderId: "1" } })).email, "buyer1@example.com");
  assert.equal((await db.preorderOrder.findFirst({ where: { shop, orderId: "2" } })).email, null, "the address is only kept when the shop sends its own emails");
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  const r = await enqueueShipEmails(db, { shop, settings, now: NOON, direct: true });
  assert.deepEqual([r.reminders, r.skipped], [1, 1]);
  assert.deepEqual((await deliveries(shop)).map((d) => [d.status, d.lastError]).sort(), [["QUEUED", null], ["SKIPPED", SKIP_NO_EMAIL]]);
  const t = fakeTransport();
  assert.equal((await processFlowDeliveries(db, { shop, mailer: await smtp(shop, t), now: NOON })).sent, 1);
  assert.equal(t.calls[0].to, "buyer1@example.com");
  assert.equal(t.calls[0].subject, "Your pre-order ships soon: Shoe (Red)");
  assert.match(t.calls[0].text, /13 November 2026/);
  // with Flow the same guest order (customer id only) is skipped as before
  const flow = newShop();
  await db.preorderConfig.create({ data: { shop: flow, productId: "999", variantId: "111", productTitle: "Shoe", shipDate: D("2026-11-13") } });
  await recordPreorderOrder(db, { shop: flow, payload: order(3) });
  const fr = await enqueueShipEmails(db, { shop: flow, settings: { emailShipReminder: true, shipReminderDays: 3 }, now: NOON, direct: false });
  assert.equal(fr.skipped, 1);
  assert.equal((await deliveries(flow))[0].lastError, SKIP_NO_CUSTOMER);
  // privacy: redaction by the buyer's address removes the stored line
  await handleCustomerRedact({ db, shop, payload: { customer: { email: "Buyer1@Example.com" } } });
  assert.equal(await db.preorderOrder.count({ where: { shop, orderId: "1" } }), 0);
});

// ---- the daily cap -------------------------------------------------------------------------------------------------

test("daily cap: 30 concurrent sends against a cap of 5 take exactly 5, atomically", async () => {
  const shop = newShop(); await connect(shop, { cap: 5, address: "cap.store@gmail.com" });
  const t = fakeTransport();
  const mailer = await smtp(shop, t, { now: () => NOON });
  const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => mailer.send({ to: `c${i}@x.com`, subject: "s", text: "t", html: "h" })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
  assert.equal(t.calls.length, 5, "only 5 messages reached Gmail");
  const refused = results.filter((r) => r.status === "rejected").map((r) => r.reason);
  assert.ok(refused.every((e) => e.quota === true && e.retryable === true && e.deferUntil.getTime() === nextDayStart(NOON).getTime()));
  assert.equal((await db.emailQuota.findUnique({ where: { account_day: { account: "capstore@gmail.com", day: dayKey(NOON) } } })).count, 5);
});

test("daily cap: shops sharing one Gmail account share one budget (dots, +tags and googlemail.com are the same account)", async () => {
  assert.equal(normalizeAccount("My.Store+promo@GoogleMail.com"), "mystore@gmail.com");
  assert.equal(normalizeAccount("A.B@yourdomain.com"), "a.b@yourdomain.com", "dots count outside gmail.com");
  const [a, b] = [newShop(), newShop()];
  await connect(a, { cap: 6, address: "shared.acct@gmail.com" });
  await connect(b, { cap: 6, address: "sharedacct+shop2@googlemail.com" });
  const t = fakeTransport();
  const [ma, mb] = [await smtp(a, t, { now: () => NOON }), await smtp(b, t, { now: () => NOON })];
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? ma : mb).send({ to: `s${i}@x.com`, subject: "s", text: "t", html: "h" })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 6, "6 for the account, not 6 per shop");
  assert.equal(t.calls.length, 6);
  // a stricter shop cap on the shared account applies to the shared count
  const strict = newShop(); await connect(strict, { cap: 2, address: "sharedacct@gmail.com" });
  await assert.rejects(async () => (await smtp(strict, t, { now: () => NOON })).send({ to: "z@x.com", subject: "s", text: "t", html: "h" }), (e) => e.quota === true);
});

test("daily cap: the first send of a day creates the row without a race (concurrent first sends)", async () => {
  const account = "firstday@gmail.com";
  const rs = await Promise.all(Array.from({ length: 12 }, () => reserveSlot(db, { account, cap: 3, now: NOON })));
  assert.equal(rs.filter((r) => r.ok).length, 3);
  assert.equal((await db.emailQuota.findUnique({ where: { account_day: { account, day: dayKey(NOON) } } })).count, 3);
});

test("daily cap: callers racing on the first send of a day never get a false 'limit reached' while there is room", async () => {
  for (let round = 0; round < 25; round++) {
    const account = `race${round}@gmail.com`;
    const rs = await Promise.all(Array.from({ length: 8 }, () => reserveSlot(db, { account, cap: 8, now: NOON })));
    assert.equal(rs.filter((r) => r.ok).length, 8, `round ${round}: all 8 fit in a cap of 8`);
    assert.equal((await reserveSlot(db, { account, cap: 8, now: NOON })).ok, false, "and the 9th is refused");
    assert.equal((await db.emailQuota.findUnique({ where: { account_day: { account, day: dayKey(NOON) } } })).count, 8);
  }
});

test("carry-over: 12 waiting customers, cap 5: sent 5 + 5 + 2 over three days, nobody dropped or emailed twice", async () => {
  const shop = newShop(); await connect(shop, { cap: 5, address: "carry@gmail.com" });
  const emails = Array.from({ length: 12 }, (_, i) => `w${i}@example.com`);
  await waitFor(shop, emails);
  const v = restock(variant());
  const t = fakeTransport();
  let clock = new Date("2026-11-10T09:00:00Z");
  const mailer = await smtp(shop, t, { now: () => clock });
  const pass = async () => {
    await enqueueRestock(db, { shop, variant: v, limit: 100, now: clock });
    return processQueue(db, { shop, mailer, stockCheck: async () => v, now: clock });
  };
  const day1 = await pass();
  assert.equal(day1.sent, 5); assert.ok(day1.deferred >= 1 && day1.failed === 0 && day1.retried === 0);
  const waiting = await deliveries(shop, { status: "QUEUED" });
  assert.equal(waiting.length, 7);
  assert.ok(waiting.every((d) => d.attempts === 0 || d.nextAttemptAt.getTime() <= clock.getTime() || d.nextAttemptAt.getTime() === nextDayStart(clock).getTime()), "deferred deliveries keep their attempts");
  const deferred = waiting.filter((d) => d.nextAttemptAt.getTime() === nextDayStart(clock).getTime());
  assert.ok(deferred.length >= 1 && deferred.every((d) => d.attempts === 0 && /limit/i.test(d.lastError)));
  assert.equal((await pass()).sent, 0, "later the same day nothing more goes out");
  assert.equal(t.calls.length, 5);
  clock = new Date("2026-11-11T00:00:05Z"); // the next window opens
  assert.equal((await pass()).sent, 5);
  clock = new Date("2026-11-12T00:00:05Z");
  assert.equal((await pass()).sent, 2);
  assert.equal(t.calls.length, 12);
  assert.deepEqual(t.calls.map((c) => c.to).sort(), [...emails].sort(), "every customer exactly once");
  assert.equal(await db.waitlistEntry.count({ where: { shop, status: "NOTIFIED" } }), 12);
  assert.equal(await deliveries(shop, { status: "ACCEPTED" }).then((x) => x.length), 12);
  assert.equal(await deliveries(shop, { status: "FAILED" }).then((x) => x.length), 0);
});

test("carry-over: signup confirmations over the cap also wait for tomorrow", async () => {
  const shop = newShop(); await connect(shop, { cap: 1, address: "carry2@gmail.com" });
  const v = variant();
  for (const e of ["a@x.com", "b@x.com"]) { const s = await addSignup(db, { shop, email: e, variant: v }); await enqueueSignupConfirmation(db, { shop, entry: s.entry, variant: v }); }
  const t = fakeTransport();
  let clock = NOON;
  const mailer = await smtp(shop, t, { now: () => clock });
  const day1 = await processFlowDeliveries(db, { shop, mailer, now: clock });
  assert.deepEqual([day1.sent, day1.deferred], [1, 1]);
  clock = new Date(nextDayStart(NOON).getTime() + 1000);
  assert.equal((await processFlowDeliveries(db, { shop, mailer, now: clock })).sent, 1);
  assert.equal(t.calls.length, 2);
});

// ---- failures ------------------------------------------------------------------------------------------------------

test("SMTP failures: a rejected sign-in is permanent, flagged for a Settings warning, stops the sending and never leaks the password", async () => {
  const shop = newShop(); await connect(shop, { address: "auth@gmail.com" });
  await waitFor(shop, ["a@x.com", "b@x.com", "c@x.com"]);
  const v = restock(variant());
  await enqueueRestock(db, { shop, variant: v, now: NOON });
  const t = fakeTransport(); t.fail = authErr();
  let r;
  const logs = await captureLogs(async () => { r = await processQueue(db, { shop, mailer: await smtp(shop, t), stockCheck: async () => v, now: NOON }); });
  assert.deepEqual([r.sent, r.failed], [0, 3]);
  assert.equal(t.calls.length, 1, "after the first rejected sign-in the mailer stops trying (no repeated bad logins)");
  const rows = await deliveries(shop);
  assert.ok(rows.every((d) => d.status === "FAILED" && d.lastError === AUTH_MESSAGE));
  const attempts = await db.notificationAttempt.findMany({ where: { shop } });
  assert.ok(attempts.every((a) => a.retryable === false && a.error === AUTH_MESSAGE));
  assert.ok(![logs, JSON.stringify(rows), JSON.stringify(attempts)].some((x) => x.includes(PW)), "the password appears in no log, delivery or attempt");
  assert.equal((await db.emailQuota.findFirst({ where: { account: "auth@gmail.com" } }))?.count ?? 0, 0, "failed sends do not use up the daily budget");
  const row = await db.shopSettings.findUnique({ where: { shop } });
  assert.equal(row.gmailAuthError, AUTH_FLAG);
  const status = await getEmailStatus(db, shop, { env: ENV });
  assert.deepEqual([status.gmail.state, status.configured], ["auth_failed", false]);
  assert.match(status.problems[0], /rejected the sign-in/);
  assert.ok(!JSON.stringify(status).includes(PW));
  assert.equal(await smtp(shop, t), null, "nothing more is sent until the merchant fixes it");
  // fixing it: a new app password clears the warning, and the failed deliveries can be retried
  const fixed = await applyGmailCredentials({ db, shop, current: row, data: { gmailAddress: "auth@gmail.com", dailySendCap: 400 }, password: "qrstuvwxyzabcdef", env: ENV, transportFactory: fakeTransport().factory });
  await db.shopSettings.update({ where: { shop }, data: fixed.data });
  assert.equal((await db.shopSettings.findUnique({ where: { shop } })).gmailAuthError, null);
  assert.equal(await retryFailedDeliveries(db, shop, { now: NOON }), 3);
  const t2 = fakeTransport();
  assert.equal((await processQueue(db, { shop, mailer: await smtp(shop, t2), stockCheck: async () => v, now: NOON })).sent, 3);
});

test("SMTP failures: network errors and 4xx replies are retried with the queue's backoff; 5xx and rejected recipients are permanent", async () => {
  const shop = newShop(); await connect(shop, { address: "retry@gmail.com" });
  await waitFor(shop, ["a@x.com"]);
  const v = restock(variant());
  await enqueueRestock(db, { shop, variant: v, now: NOON });
  const t = fakeTransport(); t.fail = Object.assign(new Error(`getaddrinfo ${PW}`), { code: "ETIMEDOUT" });
  let r = await processQueue(db, { shop, mailer: await smtp(shop, t), stockCheck: async () => v, now: NOON });
  assert.deepEqual([r.retried, r.failed], [1, 0]);
  let [d] = await deliveries(shop);
  assert.deepEqual([d.status, d.attempts, d.nextAttemptAt.getTime() - NOON.getTime()], ["QUEUED", 1, 60_000]);
  assert.match(d.lastError, /could not be reached/); assert.ok(!d.lastError.includes(PW));
  t.fail = smtpErr(421, "4.7.0 Try again later");
  const later = new Date(NOON.getTime() + 61_000);
  r = await processQueue(db, { shop, mailer: await smtp(shop, t), stockCheck: async () => v, now: later });
  [d] = await deliveries(shop);
  assert.deepEqual([r.retried, d.attempts, d.nextAttemptAt.getTime() - later.getTime()], [1, 2, 5 * 60_000]);
  assert.match(d.lastError, /SMTP 421/);
  t.fail = null;
  const much = new Date(later.getTime() + 6 * 60_000);
  assert.equal((await processQueue(db, { shop, mailer: await smtp(shop, t), stockCheck: async () => v, now: much })).sent, 1, "and it goes out once Gmail recovers");

  const perm = newShop(); await connect(perm, { address: "perm@gmail.com" });
  await waitFor(perm, ["a@x.com", "b@x.com"]);
  await enqueueRestock(db, { shop: perm, variant: v, now: NOON });
  const t2 = fakeTransport(); t2.fail = (m) => (m.to === "a@x.com" ? smtpErr(550, "5.1.1 The email account that you tried to reach does not exist") : null);
  const pr = await processQueue(db, { shop: perm, mailer: await smtp(perm, t2), stockCheck: async () => v, now: NOON });
  assert.deepEqual([pr.sent, pr.failed], [1, 1]);
  const failed = (await deliveries(perm, { status: "FAILED" }))[0];
  assert.deepEqual([failed.attempts, failed.lastError], [1, "Gmail rejected the message (SMTP 550)."]);
  const t3 = fakeTransport(); t3.accepted = false;
  const rej = await (await smtp(perm, t3, { now: () => NOON })).send({ to: "q@x.com", subject: "s", text: "t", html: "h" }).catch((e) => e);
  assert.equal(rej.retryable, false);
});

test("SMTP failures: Gmail's own 'daily limit exceeded' defers to tomorrow without spending attempts and marks the day used", async () => {
  const shop = newShop(); await connect(shop, { cap: 400, address: "limit@gmail.com" });
  await waitFor(shop, ["a@x.com", "b@x.com"]);
  const v = restock(variant());
  await enqueueRestock(db, { shop, variant: v, now: NOON });
  const t = fakeTransport(); t.fail = smtpErr(550, "5.4.5 Daily user sending limit exceeded");
  const r = await processQueue(db, { shop, mailer: await smtp(shop, t, { now: () => NOON }), stockCheck: async () => v, now: NOON });
  assert.deepEqual([r.sent, r.failed], [0, 0]);
  assert.ok(r.deferred >= 1);
  assert.equal(t.calls.length, 1, "no more attempts once Gmail says the day is used up");
  const rows = await deliveries(shop);
  assert.ok(rows.every((d) => d.status === "QUEUED"));
  assert.equal((await db.emailQuota.findUnique({ where: { account_day: { account: "limit@gmail.com", day: dayKey(NOON) } } })).count, 400);
  const sendLater = new Date(nextDayStart(NOON).getTime() + 1000);
  const t2 = fakeTransport();
  assert.equal((await processQueue(db, { shop, mailer: await smtp(shop, t2, { now: () => sendLater }), stockCheck: async () => v, now: sendLater })).sent, 2);
});

test("error classification: fixed messages only, never the server's text", () => {
  const cases = [
    [authErr(), "auth"], [smtpErr(534, "5.7.9 Application-specific password required"), "auth"], [smtpErr(530, "5.7.0 Authentication Required"), "auth"],
    [smtpErr(550, "5.4.5 Daily user sending limit exceeded"), "limit"], [smtpErr(550, "5.1.1 no such user"), "permanent"], [smtpErr(552, "5.2.2 mailbox full"), "permanent"],
    [smtpErr(450, "4.2.1 try later"), "transient"], [smtpErr(421, "4.7.0 slow down"), "transient"],
    [Object.assign(new Error("x"), { code: "ECONNRESET" }), "transient"], [new Error("something odd"), "transient"],
  ];
  for (const [err, kind] of cases) {
    const c = classifySmtpError(err);
    assert.equal(c.kind, kind, `${err.code ?? err.responseCode}`);
    assert.ok(!c.message.includes(PW) && !c.message.includes("no such user") && !c.message.includes("mailbox"), c.message);
  }
});
