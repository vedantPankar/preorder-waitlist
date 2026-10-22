import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createTestDb, variant, fakeMailer, fakeAdmin } from "./helpers.mjs";
import { notifyVariant } from "../app/lib/notify.server.js";
import { handleInventoryLevelUpdate } from "../app/lib/webhooks.server.js";

let db;
before(async () => { db = await createTestDb(); });
const stocked = variant({ inventoryQuantity: 9 });

async function seed(shop, n) {
  await db.waitlistEntry.createMany({
    data: Array.from({ length: n }, (_, i) => ({ shop, email: `u${i}@x.com`, variantId: "111", productId: "999", productTitle: "Shoe" })),
  });
}

test("notifies everyone when more than one batch (500) is waiting", async () => {
  const shop = "big.myshopify.com";
  await seed(shop, 1230);
  const mailer = fakeMailer();
  const r = await notifyVariant(db, { shop, variant: stocked, mailer, budgetMs: 60_000 });
  assert.equal(r.sent, 1230); assert.equal(r.remaining, 0);
  assert.equal(new Set(mailer.sent.map((m) => m.to)).size, 1230); // nobody emailed twice
  assert.equal(await db.waitlistEntry.count({ where: { shop, status: "NOTIFIED" } }), 1230);
});

test("a time budget stops early, reports remaining, and a second run finishes without duplicates", async () => {
  const shop = "budget.myshopify.com";
  await seed(shop, 40);
  const mailer = fakeMailer();
  const slow = { send: async (m) => { await new Promise((r) => setTimeout(r, 5)); return mailer.send(m); } };
  const first = await notifyVariant(db, { shop, variant: stocked, mailer: slow, budgetMs: 30, concurrency: 2 });
  assert.ok(first.remaining > 0 && first.sent < 40 && first.remaining === 40 - first.sent); // on a slow host it may send nothing; nothing may be lost
  const second = await notifyVariant(db, { shop, variant: stocked, mailer, budgetMs: 60_000 });
  assert.equal(second.remaining, 0);
  assert.equal(new Set(mailer.sent.map((m) => m.to)).size, 40);
  assert.equal(mailer.sent.length, 40);
});

test("a failing provider aborts early instead of burning every entry's attempts", async () => {
  const shop = "down.myshopify.com";
  await seed(shop, 60);
  const r = await notifyVariant(db, { shop, variant: stocked, mailer: fakeMailer({ fail: true }), budgetMs: 60_000, concurrency: 1 });
  assert.equal(r.aborted, true);
  // Most of the list was never even attempted (still waiting / queued, attempts untouched).
  assert.ok(await db.waitlistEntry.count({ where: { shop, status: "ACTIVE" } }) + (await db.notificationDelivery.count({ where: { shop, attempts: 0 } })) > 40);
  assert.ok((await db.notificationDelivery.count({ where: { shop, attempts: { gt: 0 } } })) <= 20, "only a handful of deliveries were attempted");
});

test("webhook schedules background continuation when work remains", async () => {
  const shop = "bg.myshopify.com";
  await seed(shop, 30);
  const admin = fakeAdmin(() => ({ data: { inventoryItem: { variants: { nodes: [{ id: "gid://shopify/ProductVariant/111", title: "Red", inventoryQuantity: 9, inventoryPolicy: "DENY", product: { id: "gid://shopify/Product/999", title: "Shoe", handle: "shoe" } }] } } } }));
  const mailer = fakeMailer(); const jobs = [];
  await handleInventoryLevelUpdate({ db, shop, webhookId: "bg1", payload: { inventory_item_id: 1, available: 9 }, admin, mailer, budgetMs: 0, schedule: (fn) => jobs.push(fn) });
  assert.equal(jobs.length, 1);
  await jobs[0]();
  assert.equal(await db.waitlistEntry.count({ where: { shop, status: "NOTIFIED" } }), 30);
});

// ---- app proxy signature (valid path)
test("app proxy accepts a correctly signed request and rejects a tampered one", async () => {
  process.env.SHOPIFY_API_KEY = "k"; process.env.SHOPIFY_API_SECRET = "proxy_secret";
  process.env.SHOPIFY_APP_URL = "https://app.example.com"; process.env.SCOPES = "read_products";
  const { authenticate } = await import("../app/shopify.server.js");
  const params = { shop: "t.myshopify.com", path_prefix: "/apps/waitlist", timestamp: String(Math.floor(Date.now() / 1000)), product: "1" };
  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("");
  const signature = createHmac("sha256", "proxy_secret").update(message).digest("hex");
  const url = (p, sig) => `https://app.example.com/proxy/config?${new URLSearchParams({ ...p, signature: sig })}`;
  const ok = await authenticate.public.appProxy(new Request(url(params, signature)));
  assert.ok(ok);
  await assert.rejects(authenticate.public.appProxy(new Request(url({ ...params, shop: "evil.myshopify.com" }, signature))), (r) => r instanceof Response && r.status >= 400);
});
