import { authenticate } from "../shopify.server";
import db from "../db.server";
import { handleCustomerRedact } from "../lib/webhooks.server";

export const action = async ({ request }) => {
  const { shop, payload } = await authenticate.webhook(request);
  await handleCustomerRedact({ db, shop, payload });
  return new Response();
};
