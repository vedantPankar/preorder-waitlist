import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getShopMailer } from "../lib/shop-mailer.server";
import { handleInventoryLevelUpdate } from "../lib/webhooks.server";

export const action = async ({ request }) => {
  // authenticate.webhook verifies the HMAC signature and throws a 401 on failure.
  const { shop, webhookId, payload, admin } = await authenticate.webhook(request);
  await handleInventoryLevelUpdate({ db, shop, webhookId, payload, admin, mailer: await getShopMailer(db, shop, { admin }) });
  return new Response();
};
