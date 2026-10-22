// Preloaded into the server process (NODE_OPTIONS=--import). Intercepts outbound
// fetch (Shopify Admin GraphQL) and the SMTP transport the Gmail sender builds (nodemailer).
// State lives in a JSON file the e2e script controls; every outbound call is appended to a log.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import nodemailer from "nodemailer";

const STATE = process.env.E2E_STATE;
const LOG = process.env.E2E_LOG;
const realFetch = globalThis.fetch;
const log = (entry) => appendFileSync(LOG, JSON.stringify(entry) + "\n");
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Gmail sending goes through nodemailer: accept every message and log it instead of opening a connection.
nodemailer.createTransport = () => ({
  verify: async () => true,
  sendMail: async (message) => {
    log({ kind: "email", to: message.to, subject: message.subject });
    return { messageId: "mock", accepted: [message.to] };
  },
});

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (/\.myshopify\.com\/admin\/api\/[^/]+\/graphql\.json/.test(url)) {
    const { query, variables } = JSON.parse(init.body);
    const state = JSON.parse(readFileSync(STATE, "utf8"));
    const node = (v) => ({ id: `gid://shopify/ProductVariant/${v.id}`, title: v.title, inventoryQuantity: v.qty, inventoryPolicy: v.policy, product: { id: `gid://shopify/Product/${v.productId}`, title: v.productTitle, handle: v.handle } });
    if (query.includes("mutation")) {
      const input = variables.variants[0];
      const v = state.variants.find((x) => `gid://shopify/ProductVariant/${x.id}` === input.id);
      if (v) v.policy = input.inventoryPolicy;
      writeFileSync(STATE, JSON.stringify(state));
      log({ kind: "policy", variant: input.id, policy: input.inventoryPolicy });
      return json({ data: { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } } });
    }
    if (query.includes("inventoryItem(")) {
      return json({ data: { inventoryItem: { variants: { nodes: state.variants.filter((v) => String(v.inventoryItemId) === variables.id.split("/").pop()).map(node) } } } });
    }
    if (query.includes("nodes(ids")) {
      return json({ data: { nodes: variables.ids.map((id) => { const v = state.variants.find((x) => `gid://shopify/ProductVariant/${x.id}` === id); return v ? node(v) : null; }) } });
    }
    log({ kind: "unhandled-graphql", query: query.slice(0, 80) });
    return json({ data: {} });
  }
  if (url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")) return realFetch(input, init);
  log({ kind: "unexpected-fetch", url });
  return json({}, 500);
};
