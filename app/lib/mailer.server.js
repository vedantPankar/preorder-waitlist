// Email provider selected via environment variables:
//   EMAIL_PROVIDER = "resend" | "postmark" | "shopify_flow"
//   (shopify_flow needs no key or sender: each restock email is handed to a Shopify Flow
//    workflow built by the merchant, which sends it with Shopify Email from the store's sender)
//   EMAIL_API_KEY  = provider API key (server-side only, never sent to the browser)
//   EMAIL_FROM     = verified sender address, e.g. "store@example.com" or "Store <store@example.com>"
// With no valid configuration getMailer() returns null and nothing is sent.

const ENDPOINTS = {
  resend: "https://api.resend.com/emails",
  postmark: "https://api.postmarkapp.com/email",
};
export const FLOW_PROVIDER = "shopify_flow";
export const FLOW_TRIGGER_HANDLE = "waitlist-restock-notification";
const ADDRESS_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

/** Pulls the bare address out of "Name <a@b.com>" or "a@b.com"; null when invalid. */
export function parseSender(value) {
  const raw = String(value ?? "").trim();
  const angle = raw.match(/<([^<>]+)>\s*$/);
  const address = (angle ? angle[1] : raw).trim();
  return ADDRESS_RE.test(address) && address.length <= 254 ? address : null;
}

/**
 * Describes what is wrong with the email configuration, in actionable terms.
 * Never includes the API key value.
 */
export function getMailerStatus(env = process.env) {
  const provider = (env.EMAIL_PROVIDER || "").toLowerCase();
  const problems = [];
  if (provider === FLOW_PROVIDER) return { configured: true, provider, channel: "flow", problems, vars: { EMAIL_PROVIDER: true, EMAIL_API_KEY: true, EMAIL_FROM: true } };
  if (!provider) problems.push("EMAIL_PROVIDER is not set. Use \"resend\", \"postmark\" or \"shopify_flow\".");
  else if (!ENDPOINTS[provider]) problems.push(`EMAIL_PROVIDER "${provider}" is not supported. Use "resend", "postmark" or "shopify_flow".`);
  if (!env.EMAIL_API_KEY) problems.push("EMAIL_API_KEY is not set.");
  if (!env.EMAIL_FROM) problems.push("EMAIL_FROM is not set. Use a sender address verified with your email provider.");
  else if (!parseSender(env.EMAIL_FROM)) problems.push("EMAIL_FROM is not a valid email address.");
  // Which variables are present (never their values), for the setup checklist.
  const vars = { EMAIL_PROVIDER: !!ENDPOINTS[provider], EMAIL_API_KEY: !!env.EMAIL_API_KEY, EMAIL_FROM: !!env.EMAIL_FROM && !!parseSender(env.EMAIL_FROM) };
  return { configured: problems.length === 0, provider: ENDPOINTS[provider] ? provider : null, channel: "provider", problems, vars };
}

const customerLookup = `#graphql
  query WaitlistCustomerByEmail($query: String!) { customers(first: 1, query: $query) { nodes { id } } }`;
const flowTrigger = `#graphql
  mutation WaitlistFlowTrigger($handle: String, $payload: JSON) {
    flowTriggerReceive(handle: $handle, payload: $payload) { userErrors { field message } }
  }`;

/** Flow trigger handle per email kind (the ship-date kinds share one trigger and differ by its `Reason` field). */
export const FLOW_TRIGGERS = {
  RESTOCK: FLOW_TRIGGER_HANDLE,
  SIGNUP_CONFIRMATION: "waitlist-signup-confirmation",
  SHIP_REMINDER: "preorder-ship-date-update",
  SHIP_DATE_CHANGE: "preorder-ship-date-update",
};
export const SKIP_NO_CUSTOMER = "skipped: no Shopify customer";

const productFields = (customerId, c) => ({
  customer_id: Number(customerId), "Product title": c.productTitle ?? "", "Variant title": c.variantTitle ?? "",
  "Product link": c.productUrl ?? "", "Store domain": c.shop ?? "",
});

/** The Flow trigger payload for one email (field names match the trigger extensions' settings). */
export function flowPayload(kind, customerId, c = {}) {
  if (kind === "SHIP_REMINDER" || kind === "SHIP_DATE_CHANGE") {
    return { ...productFields(customerId, c), Reason: kind === "SHIP_REMINDER" ? "reminder" : "changed", "Order name": c.orderName ?? "", "Ship date": c.shipDate ?? "" };
  }
  return productFields(customerId, c);
}

/**
 * Delivery through Shopify Flow: finds the Shopify customer (unless the caller already has the id) and fires
 * the trigger for the email kind. "Accepted" then means Flow accepted the trigger; the merchant's workflow
 * (e.g. Shopify Email "Send marketing email") does the actual sending. A recipient who is not a Shopify
 * customer cannot be emailed this way: that is a *skip* (`error.skip`), not a failure.
 */
function flowMailer(admin) {
  return {
    provider: FLOW_PROVIDER,
    channel: "flow",
    async send({ to, customerId: knownCustomerId, kind = "RESTOCK", context = {} }) {
      const fail = (message, extra = {}) => Object.assign(new Error(message), { retryable: false, ...extra });
      const noCustomer = () => fail("No Shopify customer exists for this email, so Shopify Flow cannot email them", { skip: true });
      const handle = FLOW_TRIGGERS[kind];
      if (!handle) throw fail(`Unknown email kind ${kind}`);
      let customerId = knownCustomerId ? String(knownCustomerId).split("/").pop() : null;
      if (!customerId) {
        if (!to) throw noCustomer();
        try {
          const q = `email:"${String(to).replace(/["\\]/g, "")}"`;
          const res = await (await admin.graphql(customerLookup, { variables: { query: q } })).json();
          if (res.errors?.length) throw fail("Could not look up the customer in Shopify", { retryable: true });
          customerId = res.data?.customers?.nodes?.[0]?.id?.split("/").pop();
        } catch (error) {
          throw error?.retryable === false ? error : Object.assign(new Error("Could not look up the customer in Shopify"), { retryable: true });
        }
      }
      // Shopify Email sends to customers; a visitor who never became a customer has no record to send to.
      if (!customerId) throw noCustomer();
      let result;
      try {
        result = await (await admin.graphql(flowTrigger, { variables: { handle, payload: flowPayload(kind, customerId, context) } })).json();
      } catch {
        throw Object.assign(new Error("Shopify Flow could not be reached"), { retryable: true });
      }
      if (result.errors?.length) throw Object.assign(new Error("Shopify rejected the Flow trigger request"), { retryable: true });
      const userErrors = result.data?.flowTriggerReceive?.userErrors ?? [];
      if (userErrors.length) throw fail(`Shopify Flow: ${String(userErrors[0].message).slice(0, 120)}`);
      return { id: null };
    },
  };
}

export function getMailer(env = process.env, fetchImpl = fetch, { admin = null } = {}) {
  if (!getMailerStatus(env).configured) return null;
  if ((env.EMAIL_PROVIDER || "").toLowerCase() === FLOW_PROVIDER) return admin ? flowMailer(admin) : null;
  const provider = env.EMAIL_PROVIDER.toLowerCase();
  const apiKey = env.EMAIL_API_KEY;
  const from = parseSender(env.EMAIL_FROM);

  return {
    provider,
    /**
     * Resolves once the provider ACCEPTED the message ({ id }). Throws an Error
     * with `.status` (HTTP status, when there was a response) and `.retryable`
     * on failure. Nothing here logs or returns the recipient address.
     */
    async send({ to, subject, html, text, fromName, replyTo, idempotencyKey }) {
      const sender = fromName ? `${fromName.replace(/[<>"]/g, "")} <${from}>` : from;
      let request;
      if (provider === "resend") {
        request = {
          headers: { Authorization: `Bearer ${apiKey}`, ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
          body: { from: sender, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) },
        };
      } else {
        request = {
          headers: { "X-Postmark-Server-Token": apiKey },
          body: { From: sender, To: to, Subject: subject, HtmlBody: html, TextBody: text, ...(replyTo ? { ReplyTo: replyTo } : {}) },
        };
      }
      let response;
      try {
        response = await fetchImpl(ENDPOINTS[provider], {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", ...request.headers },
          body: JSON.stringify(request.body),
        });
      } catch {
        throw Object.assign(new Error("Email provider could not be reached"), { retryable: true });
      }
      if (!response.ok) {
        // Status only: never include the response body or recipient in errors.
        const status = response.status;
        throw Object.assign(new Error(`Email provider responded with HTTP ${status}`), {
          status, retryable: status === 429 || status === 408 || status >= 500,
        });
      }
      let id = null;
      try {
        const body = await response.json();
        id = String(body?.id ?? body?.MessageID ?? "").slice(0, 100) || null;
      } catch { /* an accepted send without a parsable body is still accepted */ }
      return { id };
    },
  };
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
