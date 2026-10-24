// End-to-end check against the real built server. Run via `npm run test:e2e`.
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { encryptSecret } from "../../app/lib/secrets.server.js";

const PORT = 3911, BASE = `http://localhost:${PORT}`;
const KEY = "e2e_key", SECRET = "e2e_secret", SHOP = "e2e-shop.myshopify.com", OTHER = "other-shop.myshopify.com";
const dir = mkdtempSync(join(tmpdir(), "wp-e2e-"));
const STATE = join(dir, "state.json"), LOG = join(dir, "log.jsonl");
const DEV_DB = new URL("../../prisma/dev.sqlite", import.meta.url).pathname, BACKUP = join(dir, "dev.sqlite.bak");
const hadDb = existsSync(DEV_DB);
if (hadDb) copyFileSync(DEV_DB, BACKUP);

const state = { variants: [
  { id: 111, inventoryItemId: 5001, title: "Red", productId: 999, productTitle: "Shoe", handle: "shoe", qty: 0, policy: "DENY" },
  { id: 222, inventoryItemId: 5002, title: "Blue", productId: 999, productTitle: "Shoe", handle: "shoe", qty: 0, policy: "DENY" },
] };
const setQty = (id, qty) => { const cur = JSON.parse(readFileSync(STATE, "utf8")); cur.variants.find((v) => v.id === id).qty = qty; writeFileSync(STATE, JSON.stringify(cur)); };
const logs = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
writeFileSync(STATE, JSON.stringify(state));

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`); };

const db = new PrismaClient();
const server = spawn("node_modules/.bin/react-router-serve", ["build/server/index.js"], {
  env: { ...process.env, PORT, NODE_ENV: "production", SHOPIFY_API_KEY: KEY, SHOPIFY_API_SECRET: SECRET, SHOPIFY_APP_URL: BASE,
    SCOPES: "read_inventory,write_products", CRON_SECRET: "e2e-cron-secret-0123456789",
    E2E_STATE: STATE, E2E_LOG: LOG, NODE_OPTIONS: `--import ${new URL("./mock-shopify.mjs", import.meta.url).pathname}` },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOut = ""; server.stdout.on("data", (d) => (serverOut += d)); server.stderr.on("data", (d) => (serverOut += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hmacB64 = (body) => createHmac("sha256", SECRET).update(body).digest("base64");
async function webhook(topic, payload, { id, shop = SHOP, secretBody } = {}) {
  const body = JSON.stringify(payload);
  return fetch(`${BASE}/webhooks/${topic}`, { method: "POST", headers: {
    "Content-Type": "application/json", "X-Shopify-Hmac-Sha256": secretBody ?? hmacB64(body), "X-Shopify-Shop-Domain": shop,
    "X-Shopify-Topic": topic, "X-Shopify-API-Version": "2026-07", "X-Shopify-Webhook-Id": id } , body });
}
function proxyUrl(path, params, tamper) {
  const p = { shop: SHOP, path_prefix: "/apps/waitlist", timestamp: String(Math.floor(Date.now() / 1000)), ...params };
  const sig = createHmac("sha256", SECRET).update(Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join("")).digest("hex");
  return `${BASE}/proxy/${path}?${new URLSearchParams({ ...(tamper ? { ...p, shop: tamper } : p), signature: sig })}`;
}
const signup = (email, variantId = "111", extra = {}) => fetch(proxyUrl("signup", {}), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, productId: "999", variantId, ...extra }) });
function jwt(shop) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b({ alg: "HS256", typ: "JWT" }), pay = b({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: KEY, sub: "1", exp: now + 300, nbf: now - 10, iat: now, jti: `j${Math.random()}`, sid: "s1" });
  return `${head}.${pay}.${createHmac("sha256", SECRET).update(`${head}.${pay}`).digest("base64url")}`;
}
const admin = (shop, path, form) => fetch(`${BASE}${path}`, { method: form ? "POST" : "GET", headers: { Authorization: `Bearer ${jwt(shop)}`, "User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36" }, body: form ? new URLSearchParams(form) : undefined, redirect: "manual" });
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };

try {
  await db.waitlistEntry.deleteMany({ where: { shop: { in: [SHOP, OTHER] } } });
  await db.preorderConfig.deleteMany({ where: { shop: { in: [SHOP, OTHER] } } });
  await db.processedWebhook.deleteMany({ where: { shop: { in: [SHOP, OTHER] } } });
  for (const t of ["campaign", "preorderReservation", "notificationDelivery", "notificationAttempt", "restockEvent"]) await db[t].deleteMany({ where: { shop: { in: [SHOP, OTHER] } } });
  for (const shop of [SHOP, OTHER]) await db.session.upsert({ where: { id: `offline_${shop}` }, update: {}, create: { id: `offline_${shop}`, shop, state: "x", isOnline: false, scope: "read_inventory,write_products", accessToken: "shpat_mock", expires: new Date(Date.now() + 3600_000), refreshToken: "mock_refresh", refreshTokenExpires: new Date(Date.now() + 86400_000) } });
  if (!(await waitFor(async () => (await fetch(BASE + "/auth/login").catch(() => null))?.status > 0, 15000))) throw new Error("server did not start\n" + serverOut);

  // ---- security
  check("proxy: unsigned request rejected", (await fetch(`${BASE}/proxy/config?shop=${SHOP}&product=999&signature=bad`)).status >= 400);
  check("proxy: tampered shop rejected", (await fetch(proxyUrl("config", { product: "999" }, OTHER))).status >= 400);
  check("webhook: bad HMAC -> 401", (await webhook("inventory_levels/update", { inventory_item_id: 5001, available: 3 }, { id: "bad1", secretBody: "AAAA" })).status === 401);
  check("admin: no session token rejected", [302, 401, 410].includes((await fetch(`${BASE}/app/waitlist.data`, { redirect: "manual" })).status));

  // ---- waitlist signup
  let r = await signup("Alice@Example.com");
  let body = await r.json();
  check("signup: success persists a row", r.status === 200 && body.result === "created" && (await db.waitlistEntry.count({ where: { shop: SHOP } })) === 1, JSON.stringify(body));
  body = await (await signup("alice@example.com")).json();
  check("signup: duplicate (case-insensitive) not stored twice", body.result === "duplicate" && (await db.waitlistEntry.count({ where: { shop: SHOP } })) === 1);
  check("signup: invalid email -> 422", (await signup("nope")).status === 422);
  check("signup: wrong product/variant pair -> 422", (await signup("b@example.com", "111", { productId: "123" })).status === 422);
  check("signup: unknown variant -> 422", (await signup("b@example.com", "999999")).status === 422);
  setQty(222, 7);
  check("signup: in-stock variant refused (409)", (await signup("b@example.com", "222")).status === 409);
  setQty(222, 0);
  await signup("bob@example.com");
  const stored = await db.waitlistEntry.findFirst({ where: { shop: SHOP, email: "alice@example.com" } });
  check("signup: row linked to correct shop/product/variant", stored?.productId === "999" && stored?.variantId === "111" && stored?.shop === SHOP, JSON.stringify(stored));

  // ---- restock notification (sent through the shop's Gmail; the SMTP transport is mocked in the server process)
  const gmailData = { gmailAddress: "store@gmail.com", gmailPasswordEnc: encryptSecret("abcdefghijklmnop", { shop: SHOP, env: { SHOPIFY_API_SECRET: SECRET } }), dailySendCap: 400, gmailAuthError: null };
  await db.shopSettings.upsert({ where: { shop: SHOP }, create: { shop: SHOP, ...gmailData }, update: gmailData });
  setQty(111, 5);
  r = await webhook("inventory_levels/update", { inventory_item_id: 5001, location_id: 1, available: 5 }, { id: "evt-restock-1" });
  check("restock webhook accepted (200)", r.status === 200, String(r.status));
  await waitFor(() => logs().filter((l) => l.kind === "email").length >= 2);
  let emails = logs().filter((l) => l.kind === "email");
  check("restock: each waiting customer emailed exactly once", emails.length === 2 && new Set(emails.map((e) => e.to)).size === 2, JSON.stringify(emails));
  check("restock: entries marked NOTIFIED", (await db.waitlistEntry.count({ where: { shop: SHOP, status: "NOTIFIED" } })) === 2);
  check("restock: durable queue recorded one ACCEPTED delivery + attempt per customer", (await db.notificationDelivery.count({ where: { shop: SHOP, status: "ACCEPTED" } })) === 2 && (await db.notificationAttempt.count({ where: { shop: SHOP, outcome: "ACCEPTED" } })) === 2);
  await webhook("inventory_levels/update", { inventory_item_id: 5001, location_id: 1, available: 5 }, { id: "evt-restock-1" });
  await webhook("inventory_levels/update", { inventory_item_id: 5001, location_id: 1, available: 6 }, { id: "evt-restock-2" });
  await sleep(500);
  check("restock: replayed + repeated webhooks send no duplicates", logs().filter((l) => l.kind === "email").length === 2);
  check("restock: the other variant's waiters are unaffected", (await db.waitlistEntry.count({ where: { shop: SHOP, variantId: "222", status: "ACTIVE" } })) === 0);

  // ---- admin (session-token auth) + isolation
  r = await admin(SHOP, "/app/waitlist.data");
  const text = await r.text();
  check("admin: waitlist loader returns this shop's entries", r.status === 200 && text.includes("alice@example.com") && text.includes("bob@example.com"), `${r.status} ${text.slice(0, 200)}`);
  r = await admin(OTHER, "/app/waitlist.data");
  const otherText = await r.text();
  check("admin: other shop cannot see them", r.status === 200 && !otherText.includes("alice@example.com"), `${r.status}`);
  const aliceId = stored.id;
  await admin(OTHER, "/app/waitlist.data", { intent: "delete", ids: aliceId });
  check("admin: other shop cannot delete this shop's entry", !!(await db.waitlistEntry.findUnique({ where: { id: aliceId } })));
  await admin(SHOP, "/app/waitlist.data", { intent: "remove", ids: aliceId });
  check("admin: owner can remove an entry", (await db.waitlistEntry.findUnique({ where: { id: aliceId } }))?.status === "REMOVED");
  for (const p of ["", "/preorders", "/email-templates", "/settings"]) {
    r = await admin(SHOP, p ? `/app${p}.data` : "/app.data?_routes=routes%2Fapp%2Croutes%2Fapp._index");
    check(`admin: page /app${p} loads`, r.status === 200, `${r.status}`);
  }

  // ---- pre-orders
  // Stand-alone config row (the app creates these rows through campaigns; seeded directly here)
  await db.preorderConfig.create({ data: { shop: SHOP, productId: "999", variantId: "111", productTitle: "Shoe", variantTitle: "Red", buttonText: "Reserve Yours", shipDate: new Date("2026-12-24"), maxQuantity: 3, previousInventoryPolicy: "DENY" } });
  { const cur = JSON.parse(readFileSync(STATE, "utf8")); cur.variants.find((v) => v.id === 111).policy = "CONTINUE"; writeFileSync(STATE, JSON.stringify(cur)); }
  setQty(111, -2);
  await webhook("inventory_levels/update", { inventory_item_id: 5001, location_id: 1, available: -2 }, { id: "evt-pre-1" });
  r = await fetch(proxyUrl("config", { product: "999" }));
  let cj = await r.json();
  check("preorder: storefront config shows remaining quota & ship date", r.status === 200 && cj.variants[0]?.remaining === 1 && cj.variants[0]?.shipDate === "2026-12-24" && cj.variants[0]?.buttonText === "Reserve Yours", JSON.stringify(cj));
  const before = logs().filter((l) => l.kind === "policy" && l.policy === "DENY").length;
  setQty(111, -3);
  await webhook("inventory_levels/update", { inventory_item_id: 5001, location_id: 1, available: -3 }, { id: "evt-pre-2" });
  await waitFor(() => logs().filter((l) => l.kind === "policy" && l.policy === "DENY").length > before);
  cj = await (await fetch(proxyUrl("config", { product: "999" }))).json();
  check("preorder: at the limit selling is closed and storefront shows sold out", logs().filter((l) => l.kind === "policy" && l.policy === "DENY").length > before && cj.variants[0]?.soldOut === true, JSON.stringify(cj));
  cj = await (await fetch(proxyUrl("config", { product: "999" }, undefined))).json();
  await db.preorderConfig.create({ data: { shop: OTHER, productId: "999", variantId: "111", productTitle: "Other", buttonText: "OTHER" } });
  const mine = await (await fetch(proxyUrl("config", { product: "999" }))).json();
  check("preorder: storefront config is shop-scoped", mine.variants.every((v) => v.buttonText !== "OTHER"));

  // ---- public privacy policy (no login)
  r = await fetch(`${BASE}/privacy`);
  const policy = await r.text();
  check("privacy: /privacy opens without a login and names the data the app stores", r.status === 200 && policy.includes("Privacy Policy") && policy.includes("Gmail") && policy.includes("info@mobidrag.com"), `${r.status}`);
  check("privacy: the policy page sets no cookies", !r.headers.get("set-cookie"));
  const home = await (await fetch(`${BASE}/`)).text();
  check("name: the home page title and heading carry the app name", /<title>Mobi-Preorder &amp; Back in Stock<\/title>/.test(home) && home.includes("Mobi-Preorder &amp; Back in Stock"), home.slice(0, 200));

  // ---- email templates (admin)
  r = await admin(SHOP, "/app/email-templates.data", { intent: "save", emailTemplate: "modern", emailAccentColor: "#b42318", emailLogoUrl: "https://cdn.example.com/logo.png" });
  let look = await db.shopSettings.findUnique({ where: { shop: SHOP } });
  check("email templates: look saved from admin", r.status === 200 && look?.emailTemplate === "modern" && look.emailAccentColor === "#B42318" && look.emailLogoUrl === "https://cdn.example.com/logo.png", `${r.status} ${JSON.stringify(look)}`);
  await admin(SHOP, "/app/email-templates.data", { intent: "save", emailTemplate: "fancy", emailAccentColor: "red", emailLogoUrl: "http://x.com/a.png" });
  look = await db.shopSettings.findUnique({ where: { shop: SHOP } });
  check("email templates: an invalid look is rejected and the saved one is kept", look?.emailTemplate === "modern" && look.emailAccentColor === "#B42318");
  r = await admin(SHOP, "/app/email-templates.data", { intent: "preview", emailTemplate: "minimal", emailAccentColor: "nonsense", emailLogoUrl: "javascript:alert(1)", kind: "preorder" });
  const previewText = await r.text();
  check("email templates: preview renders a draft, falling back safely on bad values", r.status === 200 && previewText.includes("pre-order") && !previewText.includes("javascript:alert"), `${r.status}`);
  await admin(OTHER, "/app/email-templates.data", { intent: "save", emailTemplate: "minimal", emailAccentColor: "#112233", emailLogoUrl: "" });
  check("email templates: the look is per shop", (await db.shopSettings.findUnique({ where: { shop: SHOP } }))?.emailTemplate === "modern" && (await db.shopSettings.findUnique({ where: { shop: OTHER } }))?.emailTemplate === "minimal");
  r = await admin(SHOP, "/app/email-templates.data", { intent: "save", emailTemplate: "elegant", emailAccentColor: "#B42318", emailLogoUrl: "", emailFont: "rounded", emailHeader: "none" });
  look = await db.shopSettings.findUnique({ where: { shop: SHOP } });
  check("email templates: template, font and header saved", r.status === 200 && look?.emailTemplate === "elegant" && look.emailFont === "rounded" && look.emailHeader === "none" && look.emailLogoUrl === null, JSON.stringify(look));
  await admin(SHOP, "/app/email-templates.data", { intent: "save", emailTemplate: "dark", emailFont: "comic", emailHeader: "huge" });
  check("email templates: an invalid font or header is rejected", (await db.shopSettings.findUnique({ where: { shop: SHOP } }))?.emailTemplate === "elegant");
  const thumbText = await (await admin(SHOP, "/app/email-templates.data", { intent: "preview", emailTemplate: "bold", kind: "restock" })).text();
  check("email templates: the preview returns a thumbnail for every template", thumbText.includes("thumbs") && ["bold", "elegant", "dark", "classic"].every((t) => thumbText.includes(t)));
  await db.shopSettings.update({ where: { shop: SHOP }, data: { emailTemplate: "classic", emailAccentColor: null, emailLogoUrl: null, emailFont: null, emailHeader: null } });

  // ---- waitlist on/off setting (admin -> storefront)
  let cfgBody = await (await fetch(proxyUrl("config", { product: "999" }))).json();
  check("settings: storefront config reports waitlist enabled by default", cfgBody.waitlistEnabled === true);
  await admin(SHOP, "/app/settings.data", { fromName: "", replyToEmail: "", subject: "{{product}} is back", retentionDays: "90" }); // checkbox unchecked => disabled
  cfgBody = await (await fetch(proxyUrl("config", { product: "999" }))).json();
  check("settings: unchecking the box disables the waitlist on the storefront", cfgBody.waitlistEnabled === false, JSON.stringify(cfgBody));
  r = await signup("late@example.com");
  check("settings: signup refused (403) while disabled", r.status === 403 && (await db.waitlistEntry.count({ where: { shop: SHOP, email: "late@example.com" } })) === 0, String(r.status));
  await admin(SHOP, "/app/settings.data", { waitlistEnabled: "on", fromName: "", replyToEmail: "", subject: "{{product}} is back", retentionDays: "90" });
  check("settings: re-enabling restores signups", (await signup("late@example.com")).status === 200);

  // ---- campaigns, reservations, scheduler, click tracking, new admin pages
  r = await admin(SHOP, "/app/campaigns/new.data", { intent: "save", name: "Launch", startDate: "", endDate: "", shipDate: "2026-12-24", maxQuantity: "3", targetUnits: "10", buttonText: "Reserve", showCountdown: "", showProgress: "on", variantId: "gid://shopify/ProductVariant/222" });
  const camp = await db.campaign.findFirst({ where: { shop: SHOP } });
  check("campaign: created from admin (draft) and its variant linked", !!camp && camp.state === "DRAFT" && (await db.preorderConfig.count({ where: { shop: SHOP, campaignId: camp.id } })) === 1, `${r.status} ${JSON.stringify(camp)}`);
  check("campaign: draft is not exposed to the storefront", ((await (await fetch(proxyUrl("config", { product: "999" }))).json()).variants ?? []).every((v) => v.variantId !== "222"));
  const policiesBefore = logs().filter((l) => l.kind === "policy").length;
  await admin(SHOP, `/app/campaigns/${camp.id}.data`, { intent: "publish" });
  check("campaign: publishing opens selling (policy CONTINUE)", logs().filter((l) => l.kind === "policy").length > policiesBefore && logs().filter((l) => l.kind === "policy").at(-1).policy === "CONTINUE");
  cj = await (await fetch(proxyUrl("config", { product: "999" }))).json();
  const cv = cj.variants.find((v) => v.variantId === "222");
  check("campaign: storefront config has phase, countdown/progress data and server time", cv?.phase === "active" && cv.campaign?.progress?.target === 10 && cv.remaining === 3 && !!cj.serverNow, JSON.stringify(cv));
  const reserveCall = (body) => fetch(proxyUrl("reserve", {}), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId: "999", variantId: "222", quantity: 1, ...body }) });
  const results = await Promise.all(Array.from({ length: 12 }, () => reserveCall({})));
  const bodies = await Promise.all(results.map((x) => x.json()));
  check("reserve: 12 simultaneous HTTP requests against a limit of 3 -> exactly 3 holds", bodies.filter((b) => b.ok).length === 3 && (await db.preorderConfig.findFirst({ where: { shop: SHOP, variantId: "222" } })).reservedCount === 3, JSON.stringify(bodies.map((b) => b.error ?? "ok")));
  check("reserve: refused requests get a clear message and 409", results.filter((x) => x.status === 409).length === 9 && bodies.find((b) => !b.ok).message.length > 5);
  const held = bodies.find((b) => b.ok);
  r = await fetch(proxyUrl("reserve", {}), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent: "release", reservationId: held.reservationId }) });
  check("reserve: a hold can be released and the unit becomes available again", (await r.json()).released === true && (await (await reserveCall({})).json()).ok === true);
  check("reserve: unsigned request rejected", (await fetch(`${BASE}/proxy/reserve?shop=${SHOP}&signature=bad`, { method: "POST", body: "{}" })).status >= 400);
  check("reserve: other shop cannot reserve this shop's variant", (await (await fetch(proxyUrl("reserve", {}, undefined).replace(SHOP, OTHER), { method: "POST", body: "{}" })).status) >= 400);
  // ---- require customer login for pre-orders (Settings -> proxy config -> signed reserve)
  const settingsForm = { waitlistEnabled: "on", fromName: "", replyToEmail: "", subject: "{{product}} is back", retentionDays: "90" };
  const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const heldRows = () => db.preorderReservation.findMany({ where: { shop: SHOP, status: "HELD" } });
  check("login: off by default; storefront config says so", (await (await fetch(proxyUrl("config", { product: "999" }))).json()).requirePreorderLogin === false);
  const heldBefore = await heldRows();
  await post(proxyUrl("reserve", {}), { intent: "release", reservationId: heldBefore[0].id }); // free one unit for the login checks
  await admin(SHOP, "/app/settings.data", { ...settingsForm, requirePreorderLogin: "on" });
  check("login: turning it on is reported to the storefront", (await (await fetch(proxyUrl("config", { product: "999" }))).json()).requirePreorderLogin === true);
  const heldOn = (await heldRows()).length;
  r = await reserveCall({});
  const guestBody = await r.json();
  check("login: signed guest request gets 401 login_required and no hold", r.status === 401 && guestBody.error === "login_required" && (await heldRows()).length === heldOn, JSON.stringify(guestBody));
  check("login: a forged logged_in_customer_id (bad signature) is rejected", (await fetch(`${proxyUrl("reserve", {})}&logged_in_customer_id=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId: "999", variantId: "222", quantity: 1 }) })).status >= 400 && (await heldRows()).length === heldOn);
  r = await post(proxyUrl("reserve", { logged_in_customer_id: "8123" }), { productId: "999", variantId: "222", quantity: 1 });
  const memberBody = await r.json();
  check("login: signed logged-in customer gets the hold", r.status === 200 && memberBody.ok === true && (await heldRows()).length === heldOn + 1, JSON.stringify(memberBody));
  check("login: a guest can still release a hold while login is required", (await (await post(proxyUrl("reserve", {}), { intent: "release", reservationId: memberBody.reservationId })).json()).released === true);
  await admin(SHOP, "/app/settings.data", settingsForm); // switch unchecked => off again
  r = await reserveCall({});
  const guestOff = await r.json();
  check("login: when off, guests can pre-order exactly as before", r.status === 200 && guestOff.ok === true, JSON.stringify(guestOff));

  await admin(SHOP, `/app/campaigns/${camp.id}.data`, { intent: "pause" });
  check("campaign: pausing closes selling and storefront reports it", logs().filter((l) => l.kind === "policy").at(-1).policy === "DENY" && (await (await fetch(proxyUrl("config", { product: "999" }))).json()).variants.find((v) => v.variantId === "222").phase === "paused");
  check("reserve: paused campaign refuses holds", (await reserveCall({})).status === 409);
  check("campaign: other shop cannot control it", await (async () => { await admin(OTHER, `/app/campaigns/${camp.id}.data`, { intent: "delete" }); return !!(await db.campaign.findUnique({ where: { id: camp.id } })); })());

  // scheduler endpoint (external cron) and click tracking
  check("cron: 401 with a wrong secret", (await fetch(`${BASE}/api/notifications/run`, { method: "POST", headers: { Authorization: "Bearer nope-nope-nope-nope" } })).status === 401);
  check("cron: 404 for GET (no information leak)", (await fetch(`${BASE}/api/notifications/run`)).status === 404);
  r = await fetch(`${BASE}/api/notifications/run?shop=${SHOP}`, { method: "POST", headers: { Authorization: "Bearer e2e-cron-secret-0123456789" } }); // limited to the test shop: the suite runs on the dev database
  const cron = await r.json();
  check("cron: authorised run succeeds and reports per-shop counts only", r.status === 200 && cron.operational === true && !JSON.stringify(cron).includes("@"), JSON.stringify(cron));
  const delivery = await db.notificationDelivery.findFirst({ where: { shop: SHOP, status: "ACCEPTED" } });
  r = await fetch(proxyUrl(`r/${delivery.trackingToken}`, {}), { redirect: "manual" });
  check("click: tracked link redirects to the product path and counts the click", r.status === 302 && r.headers.get("location").startsWith("/products/") && (await db.notificationDelivery.findUnique({ where: { id: delivery.id } })).clickCount === 1, `${r.status} ${r.headers.get("location")}`);
  r = await fetch(proxyUrl("r/not-a-real-token-value", {}), { redirect: "manual" });
  check("click: unknown token goes to the storefront home, no error", r.status === 302 && r.headers.get("location") === "/");
  for (const p of ["/notifications", "/campaigns", `/campaigns/${camp.id}`]) {
    r = await admin(SHOP, `/app${p}.data`);
    check(`admin: page /app${p} loads`, r.status === 200, `${r.status}`);
  }
  r = await admin(OTHER, "/app/campaigns.data");
  check("admin: other shop sees none of this shop's campaigns", r.status === 200 && !(await r.text()).includes("Launch"));
  await admin(SHOP, `/app/campaigns/${camp.id}.data`, { intent: "delete" });
  check("campaign: deleting restores the variant's original policy and removes its config", (await db.preorderConfig.count({ where: { shop: SHOP, variantId: "222" } })) === 0 && logs().filter((l) => l.kind === "policy").at(-1).policy === "DENY");

  // ---- orders webhooks (ship-date emails) and the extra-email settings
  const orderBody = (id, customer) => ({ id, name: `#${id}`, customer, line_items: [{ id: id * 10, variant_id: 222, product_id: 999, title: "Shoe", variant_title: "Blue", quantity: 1, properties: [{ name: "_preorder", value: "true" }, { name: "_preorder_ship_date", value: "2026-12-24" }] }] });
  check("orders: bad HMAC -> 401", (await webhook("orders/create", orderBody(7001, { id: 4242 }), { id: "ord-bad", secretBody: "AAAA" })).status === 401);
  check("orders: orders/create stores the pre-order line with the customer id and, because Gmail sends the ship-date emails, the buyer's address", (await webhook("orders/create", orderBody(7001, { id: 4242, email: "buyer@example.com" }), { id: "ord-1" })).status === 200
    && (await db.preorderOrder.findMany({ where: { shop: SHOP, orderId: "7001" } })).length === 1
    && (await db.preorderOrder.findFirst({ where: { shop: SHOP, orderId: "7001" } })).customerId === "4242"
    && (await db.preorderOrder.findFirst({ where: { shop: SHOP, orderId: "7001" } })).email === "buyer@example.com");
  await webhook("orders/create", orderBody(7001, { id: 4242 }), { id: "ord-1" });
  await webhook("orders/create", orderBody(7001, { id: 4242 }), { id: "ord-1-retry" });
  check("orders: a redelivered webhook does not duplicate the line", (await db.preorderOrder.count({ where: { shop: SHOP, orderId: "7001" } })) === 1);
  await webhook("orders/create", { id: 7002, name: "#7002", customer: { id: 4242 }, line_items: [{ id: 1, variant_id: 222, properties: [] }] }, { id: "ord-2" });
  check("orders: lines that are not pre-orders are ignored", (await db.preorderOrder.count({ where: { shop: SHOP, orderId: "7002" } })) === 0);
  check("orders: orders/cancelled stops ship-date emails for that order", (await webhook("orders/cancelled", { id: 7001 }, { id: "ord-c1" })).status === 200 && (await db.preorderOrder.findFirst({ where: { shop: SHOP, orderId: "7001" } })).status === "CANCELLED");
  const extraForm = { waitlistEnabled: "on", fromName: "", replyToEmail: "", subject: "{{product}} is back", retentionDays: "90" };
  const settingsRow = () => db.shopSettings.findUnique({ where: { shop: SHOP } });
  check("extra emails: off by default, 3 days", await (async () => { const s = await settingsRow(); return s.emailSignupConfirmation === false && s.emailShipReminder === false && s.emailShipDateChange === false && s.shipReminderDays === 3; })());
  await admin(SHOP, "/app/settings.data", { ...extraForm, emailSignupConfirmation: "on", emailShipReminder: "on", emailShipDateChange: "on", shipReminderDays: "5" });
  check("extra emails: Settings saves the three toggles and the days", await (async () => { const s = await settingsRow(); return s.emailSignupConfirmation && s.emailShipReminder && s.emailShipDateChange && s.shipReminderDays === 5; })());
  await admin(SHOP, "/app/settings.data", { ...extraForm, emailSignupConfirmation: "on", shipReminderDays: "0" });
  check("extra emails: an invalid number of days is rejected and nothing else changes", (await settingsRow()).shipReminderDays === 5 && (await settingsRow()).emailShipReminder === true);
  r = await signup("newcomer@example.com");
  check("extra emails: with Gmail connected and the toggle on, a signup queues a confirmation, and the signup itself still works", r.status === 200 && (await db.notificationDelivery.count({ where: { shop: SHOP, kind: "SIGNUP_CONFIRMATION" } })) === 1);
  await waitFor(() => logs().some((l) => l.kind === "email" && /on the list/.test(l.subject ?? "")));
  check("extra emails: the confirmation is sent through Gmail to the signup address", logs().some((l) => l.kind === "email" && l.to === "newcomer@example.com" && /on the list/.test(l.subject)));
  const confirmations = () => logs().filter((l) => l.kind === "email" && /pre-order is confirmed/.test(l.subject ?? ""));
  await webhook("orders/create", orderBody(7050, { id: 4300, email: "early@example.com" }), { id: "ord-conf-off" });
  await sleep(400);
  check("orders: with the confirmation toggle off, a pre-order sends no confirmation", confirmations().length === 0);
  await admin(SHOP, "/app/settings.data", { ...extraForm, emailPreorderConfirmation: "on" });
  check("extra emails: Settings saves the pre-order confirmation toggle", (await settingsRow()).emailPreorderConfirmation === true);
  await webhook("orders/create", orderBody(7100, { id: 4301, email: "orderer@example.com" }), { id: "ord-conf-1" });
  await waitFor(() => confirmations().length >= 1);
  check("orders: with the toggle on, a pre-order is confirmed through Gmail to the order's address", confirmations().length === 1 && confirmations()[0].to === "orderer@example.com" && /Shoe/.test(confirmations()[0].subject), JSON.stringify(confirmations()));
  await webhook("orders/create", orderBody(7100, { id: 4301, email: "orderer@example.com" }), { id: "ord-conf-retry" });
  await sleep(500);
  check("orders: a redelivered webhook sends no second confirmation", confirmations().length === 1);

  // ---- Gmail sending settings (nothing here contacts Gmail: no valid app password is ever submitted)
  const GPW = "abcdefghijklmnop", gmailRow = () => db.shopSettings.findUnique({ where: { shop: SHOP } });
  await db.shopSettings.update({ where: { shop: SHOP }, data: { gmailAddress: "store@gmail.com", gmailPasswordEnc: encryptSecret(GPW, { shop: SHOP, env: { SHOPIFY_API_SECRET: SECRET } }), dailySendCap: 400, gmailAuthError: null } });
  const settingsPage = await (await admin(SHOP, "/app/settings.data")).text();
  check("gmail: Settings page data shows the address but never the app password or its ciphertext", settingsPage.includes("store@gmail.com") && !settingsPage.includes(GPW) && !settingsPage.includes((await gmailRow()).gmailPasswordEnc) && !settingsPage.includes("v1."));
  check("gmail: the notification activity page loads with Gmail configured", (await admin(SHOP, "/app/notifications.data")).status === 200);
  r = await admin(SHOP, "/app/settings.data", { ...extraForm, gmailAddress: "other@gmail.com" });
  check("gmail: changing the address without its app password is refused and nothing changes", (await r.text()).includes("Enter the app password") && (await gmailRow()).gmailAddress === "store@gmail.com");
  r = await admin(SHOP, "/app/settings.data", { ...extraForm, gmailAddress: "store@gmail.com", gmailPassword: "hunter2hunter2hunter2" });
  const badPw = await r.text();
  check("gmail: a malformed password is rejected without being echoed, stored or logged", badPw.includes("not an app password") && !badPw.includes("hunter2") && !serverOut.includes("hunter2") && !JSON.stringify(await gmailRow()).includes("hunter2"));
  r = await admin(SHOP, "/app/settings.data", { ...extraForm, gmailAddress: "store@gmail.com", dailySendCap: "5000" });
  check("gmail: an out-of-range daily limit is rejected and the stored limit is kept", (await r.text()).includes("between 1 and 2000") && (await gmailRow()).dailySendCap === 400);
  await admin(SHOP, "/app/settings.data", { ...extraForm, gmailAddress: "store@gmail.com", dailySendCap: "250" });
  check("gmail: the daily limit is saved, and saving without a password keeps the stored one", (await gmailRow()).dailySendCap === 250 && (await gmailRow()).gmailPasswordEnc?.startsWith("v1."));
  await admin(SHOP, "/app/settings.data", { intent: "disconnectGmail" });
  check("gmail: disconnect deletes the address and the stored password", await (async () => { const g = await gmailRow(); return g.gmailAddress === null && g.gmailPasswordEnc === null; })());

  // ---- privacy
  await webhook("orders/create", orderBody(7003, { id: 5151 }), { id: "ord-3" });
  r = await webhook("customers/redact", { customer: { id: 5151, email: "nobody@example.com" } }, { id: "red-0" });
  check("privacy: customers/redact removes the customer's pre-order lines (by customer id)", r.status === 200 && (await db.preorderOrder.count({ where: { shop: SHOP, customerId: "5151" } })) === 0 && (await db.preorderOrder.count({ where: { shop: SHOP, customerId: "4242" } })) === 1);
  await signup("gone@example.com");
  r = await webhook("customers/redact", { customer: { email: "Gone@Example.com" } }, { id: "red-1" });
  check("privacy: customers/redact deletes that customer", r.status === 200 && (await db.waitlistEntry.count({ where: { shop: SHOP, email: "gone@example.com" } })) === 0);
  check("privacy: customers/data_request acknowledged", (await webhook("customers/data_request", { customer: { email: "x@y.z" } }, { id: "dr-1" })).status === 200);
  r = await webhook("shop/redact", {}, { id: "sr-1", shop: OTHER });
  check("privacy: shop/redact wipes only that shop", r.status === 200 && (await db.preorderConfig.count({ where: { shop: OTHER } })) === 0 && (await db.preorderConfig.count({ where: { shop: SHOP } })) > 0);
  await webhook("orders/create", orderBody(7004, { id: 6161 }), { id: "ord-4", shop: OTHER });
  await webhook("shop/redact", {}, { id: "sr-2", shop: OTHER });
  check("privacy: shop/redact also removes that shop's pre-order lines", (await db.preorderOrder.count({ where: { shop: OTHER } })) === 0 && (await db.preorderOrder.count({ where: { shop: SHOP } })) >= 1);

  const bad = logs().filter((l) => l.kind.startsWith("unexpected") || l.kind.startsWith("unhandled"));
  check("no unexpected outbound requests", bad.length === 0, JSON.stringify(bad));
  check("server log contains no customer emails", !/@example\.com/.test(serverOut), serverOut.split("\n").filter((l) => /@example\.com/.test(l)).slice(0, 2).join(" | "));
} catch (e) {
  console.error("HARNESS ERROR", e);
  check("harness ran to completion", false, String(e));
  console.error(serverOut.slice(-1500));
} finally {
  server.kill();
  for (const t of ["campaign", "preorderReservation", "notificationDelivery", "notificationAttempt", "restockEvent"]) await db[t].deleteMany({ where: { shop: { in: [SHOP, OTHER] } } });
  await db.waitlistEntry.deleteMany({ where: { shop: { in: [SHOP, OTHER] } } });
  await db.preorderConfig.deleteMany({ where: { shop: { in: [SHOP, OTHER] } } });
  await db.processedWebhook.deleteMany({ where: { shop: { in: [SHOP, OTHER] } } });
  await db.session.deleteMany({ where: { shop: { in: [SHOP, OTHER] } } });
  await db.shopSettings.deleteMany({ where: { shop: { in: [SHOP, OTHER] } } });
  await db.$disconnect();
  if (hadDb) copyFileSync(BACKUP, DEV_DB);
  rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
