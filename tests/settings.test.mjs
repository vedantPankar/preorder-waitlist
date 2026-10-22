import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestDb } from "./helpers.mjs";
import { formDefaults, parseSettingsForm, settingsView, storefrontDisplay } from "../app/lib/settings.server.js";
import { cleanText, isValidEmail } from "../app/lib/validation.server.js";
import vm from "node:vm";

const sandbox = { globalThis: null };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL("../extensions/waitlist-preorder/assets/wp-common.js", import.meta.url), "utf8"), sandbox);
const C = sandbox.WPCommon;
const deps = { isValidEmail, cleanText };
const f = (o) => ({ get: (k) => (k in o ? o[k] : null) });
let db;
before(async () => { db = await createTestDb(); });

test("defaults when no row exists; storefront display stays off until customised", () => {
  const v = settingsView(null);
  assert.deepEqual([v.defaultButtonText, v.buttonStyle, v.buttonColor, v.countdownStyle, v.displayCustomized], ["Pre-Order Now", "solid", "#006F5C", "dhms", false]);
  assert.equal(storefrontDisplay(null), null);
  assert.equal(storefrontDisplay({ displayCustomized: false, buttonColor: "#111111" }), null);
  assert.equal(storefrontDisplay({ displayCustomized: true, buttonColor: "#111111" }).buttonColor, "#111111");
  assert.deepEqual(formDefaults({ defaultMaxQuantity: 100, defaultTargetUnits: 200, defaultShowCountdown: true }).maxQuantity, 100);
});

test("a full form validates and normalises", () => {
  const r = parseSettingsForm(f({ _form: "settings", defaultButtonText: " Pre-Order Now ", defaultMaxQuantity: "100", defaultTargetUnits: "200", defaultShowCountdown: "on", buttonStyle: "outline", buttonColor: "#006f5c", buttonTextColor: "#ffffff", progressColor: "#00aa00", countdownStyle: "hms", retentionDays: "90", restockCoveragePct: "50", restockBuffer: "0", subject: "", replyToEmail: "" }), null, deps);
  assert.ok(r.data, JSON.stringify(r));
  assert.deepEqual([r.data.defaultMaxQuantity, r.data.defaultTargetUnits, r.data.buttonColor, r.data.defaultShowCountdown, r.data.defaultShowProgress, r.data.displayCustomized, r.data.subject], [100, 200, "#006F5C", true, false, true, "{{product}} is back in stock"]);
});

test("invalid values are rejected field by field", () => {
  const r = parseSettingsForm(f({ _form: "settings", defaultMaxQuantity: "0", defaultTargetUnits: "1.5", buttonColor: "red", buttonStyle: "neon", countdownStyle: "x", retentionDays: "0", replyToEmail: "nope" }), null, deps);
  assert.deepEqual(Object.keys(r.errors).sort(), ["buttonColor", "buttonStyle", "countdownStyle", "defaultMaxQuantity", "defaultTargetUnits", "replyToEmail", "retentionDays"]);
});

test("blank optional limit clears it; a form without a field keeps the stored value", () => {
  const cur = { defaultMaxQuantity: 7, defaultTargetUnits: 9, buttonColor: "#123456", displayCustomized: true, waitlistEnabled: false };
  assert.equal(parseSettingsForm(f({ _form: "settings", defaultMaxQuantity: "" }), cur, deps).data.defaultMaxQuantity, null);
  const keep = parseSettingsForm(f({ restockBuffer: "3" }), cur, deps).data;
  assert.deepEqual([keep.defaultMaxQuantity, keep.defaultTargetUnits, keep.buttonColor, keep.waitlistEnabled, keep.restockBuffer], [7, 9, "#123456", false, 3]);
});

test("require-login toggle: off by default, saved from the form, kept when the form omits it", async () => {
  assert.equal(settingsView(null).requirePreorderLogin, false);
  assert.equal(parseSettingsForm(f({ _form: "settings" }), null, deps).data.requirePreorderLogin, false);
  const on = parseSettingsForm(f({ _form: "settings", requirePreorderLogin: "on" }), null, deps).data;
  assert.equal(on.requirePreorderLogin, true);
  assert.equal(parseSettingsForm(f({ restockBuffer: "3" }), { requirePreorderLogin: true }, deps).data.requirePreorderLogin, true);
  await db.shopSettings.upsert({ where: { shop: "login.myshopify.com" }, create: { shop: "login.myshopify.com", ...on }, update: on });
  assert.equal((await db.shopSettings.findUnique({ where: { shop: "login.myshopify.com" } })).requirePreorderLogin, true);
  await db.shopSettings.deleteMany({ where: { shop: "login.myshopify.com" } });
  assert.equal(settingsView(await db.shopSettings.findUnique({ where: { shop: "login.myshopify.com" } })).requirePreorderLogin, false);
});

test("settings persist in the database and reset returns to defaults", async () => {
  const data = parseSettingsForm(f({ _form: "settings", buttonColor: "#112233", countdownStyle: "compact" }), null, deps).data;
  await db.shopSettings.upsert({ where: { shop: "s.myshopify.com" }, create: { shop: "s.myshopify.com", ...data }, update: data });
  const row = await db.shopSettings.findUnique({ where: { shop: "s.myshopify.com" } });
  assert.deepEqual(storefrontDisplay(row), { buttonStyle: "solid", buttonColor: "#112233", buttonTextColor: "#FFFFFF", progressColor: "#006F5C", countdownStyle: "compact" });
  await db.shopSettings.deleteMany({ where: { shop: "s.myshopify.com" } });
  assert.equal(storefrontDisplay(await db.shopSettings.findUnique({ where: { shop: "s.myshopify.com" } })), null);
});

test("countdown styles format as labelled", () => {
  const ms = (90061) * 1000; // 1d 01:01:01
  assert.equal(C.formatCountdown(ms).text, "1d 01:01:01");
  assert.equal(C.formatCountdown(ms, "compact").text, "1d 01:01:01");
  assert.equal(C.formatCountdown(ms, "dhms").text, "1d 01h 01m 01s");
  assert.equal(C.formatCountdown(ms, "hms").text, "25h 01m 01s");
  assert.equal(C.formatCountdown(0, "dhms").done, true);
});

test("block opts in to the app look by default, and the storefront script applies it only then", () => {
  const liquid = readFileSync(new URL("../extensions/waitlist-preorder/blocks/preorder_button.liquid", import.meta.url), "utf8");
  assert.match(liquid, /data-use-app-style="\{\{ block\.settings\.use_app_style \}\}"/);
  assert.match(liquid, /"id": "use_app_style"[^}]*"default": true/);
  const js = readFileSync(new URL("../extensions/waitlist-preorder/assets/preorder.js", import.meta.url), "utf8");
  assert.match(js, /dataset\.useAppStyle === 'true' \? d : null/);
});
