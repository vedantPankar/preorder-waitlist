import { authenticate } from "../shopify.server";

// Waitlist data (email + product/variant) is exportable from the Waitlist page;
// the merchant fulfils data requests. Nothing is auto-sent and no PII is logged.
export const action = async ({ request }) => {
  await authenticate.webhook(request);
  return new Response();
};
