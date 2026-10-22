import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

process.env.SHOPIFY_API_KEY = "test_key";
process.env.SHOPIFY_API_SECRET = "test_secret";
process.env.SHOPIFY_APP_URL = "https://app.example.com";
process.env.SCOPES = "read_products";

const { authenticate } = await import("../app/shopify.server.js");
const SECRET = "test_secret";

function webhook(body, hmacSecret = SECRET) {
  return new Request("https://app.example.com/webhooks/inventory_levels/update", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": createHmac("sha256", hmacSecret).update(body).digest("base64"),
      "X-Shopify-Shop-Domain": "t.myshopify.com", "X-Shopify-Topic": "inventory_levels/update",
      "X-Shopify-API-Version": "2026-07", "X-Shopify-Webhook-Id": "w-1",
    },
    body,
  });
}

test("webhook with valid HMAC is accepted", async () => {
  const ctx = await authenticate.webhook(webhook('{"inventory_item_id":1,"available":3}'));
  assert.equal(ctx.shop, "t.myshopify.com"); assert.equal(ctx.webhookId, "w-1");
});

test("webhook with bad HMAC is rejected with 401", async () => {
  await assert.rejects(authenticate.webhook(webhook('{"a":1}', "wrong")), (r) => r instanceof Response && r.status === 401);
});

test("tampered body is rejected", async () => {
  const req = webhook('{"a":1}');
  const tampered = new Request(req.url, { method: "POST", headers: req.headers, body: '{"a":2}' });
  await assert.rejects(authenticate.webhook(tampered), (r) => r instanceof Response && r.status === 401);
});

test("app proxy requests without a valid signature are rejected", async () => {
  const unsigned = new Request("https://app.example.com/proxy/config?shop=t.myshopify.com&product=1&timestamp=1&signature=bad");
  await assert.rejects(authenticate.public.appProxy(unsigned), (r) => r instanceof Response && r.status >= 400);
});

test("admin routes reject unauthenticated requests", async () => {
  const req = new Request("https://app.example.com/app/waitlist");
  await assert.rejects(authenticate.admin(req), (r) => r instanceof Response);
});
