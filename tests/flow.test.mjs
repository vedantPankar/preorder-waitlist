import { test } from "node:test";
import assert from "node:assert/strict";
import { FLOW_TRIGGER_HANDLE, getMailer, getMailerStatus } from "../app/lib/mailer.server.js";
import { buildEmail } from "../app/lib/notify.server.js";

const env = { EMAIL_PROVIDER: "shopify_flow" };
// Fake Admin client: records calls, answers the customer lookup and the Flow mutation.
const fakeAdmin = ({ customer = "gid://shopify/Customer/77", userErrors = [], graphqlErrors = false } = {}) => {
  const calls = [];
  return {
    calls,
    graphql: async (query, { variables }) => {
      calls.push({ query, variables });
      const data = query.includes("customers(") ? { customers: { nodes: customer ? [{ id: customer }] : [] } } : { flowTriggerReceive: { userErrors } };
      return { json: async () => (graphqlErrors ? { errors: [{ message: "x" }] } : { data }) };
    },
  };
};
const msg = { to: "a@b.com", context: { shop: "s.myshopify.com", productTitle: "Board", variantTitle: "Red", productUrl: "https://s.myshopify.com/products/b" } };

test("shopify_flow needs no key or sender, but a mailer needs an admin client", () => {
  const status = getMailerStatus(env);
  assert.equal(status.configured, true);
  assert.equal(status.channel, "flow");
  assert.equal(getMailer(env), null);
  assert.ok(getMailer(env, undefined, { admin: fakeAdmin() }));
});

test("restock email context carries what the Flow trigger needs", () => {
  const { context } = buildEmail({ shop: "s.myshopify.com", variant: { productTitle: "Board", variantTitle: "Red", productHandle: "b", variantId: "5" }, settings: null, delivery: null });
  assert.deepEqual(context, { shop: "s.myshopify.com", productTitle: "Board", variantTitle: "Red", productUrl: "https://s.myshopify.com/products/b?variant=5" });
});

test("known customer: the trigger fires once with the customer id and product details", async () => {
  const admin = fakeAdmin();
  const result = await getMailer(env, undefined, { admin }).send(msg);
  assert.deepEqual(result, { id: null });
  assert.equal(admin.calls.length, 2);
  assert.match(admin.calls[0].variables.query, /^email:"a@b.com"$/);
  assert.equal(admin.calls[1].variables.handle, FLOW_TRIGGER_HANDLE);
  assert.deepEqual(admin.calls[1].variables.payload, { customer_id: 77, "Product title": "Board", "Variant title": "Red", "Product link": msg.context.productUrl, "Store domain": "s.myshopify.com" });
});

test("not a Shopify customer: fails permanently without firing the trigger", async () => {
  const admin = fakeAdmin({ customer: null });
  await assert.rejects(() => getMailer(env, undefined, { admin }).send(msg), (e) => e.retryable === false && /No Shopify customer/.test(e.message));
  assert.equal(admin.calls.length, 1);
});

test("Flow user errors are permanent; API-level errors are retryable", async () => {
  await assert.rejects(() => getMailer(env, undefined, { admin: fakeAdmin({ userErrors: [{ message: "Trigger not found" }] }) }).send(msg), (e) => e.retryable === false && /Trigger not found/.test(e.message));
  await assert.rejects(() => getMailer(env, undefined, { admin: fakeAdmin({ graphqlErrors: true }) }).send(msg), (e) => e.retryable === true);
});

test("a quote in the address cannot alter the customer search", async () => {
  const admin = fakeAdmin();
  await getMailer(env, undefined, { admin }).send({ ...msg, to: 'a"b@c.com' });
  assert.equal(admin.calls[0].variables.query, 'email:"ab@c.com"');
});
