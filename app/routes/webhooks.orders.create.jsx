import { authenticate } from "../shopify.server";
import db from "../db.server";
import { recordPreorderOrder } from "../lib/preorder-orders.server";
import { getEmailStatus } from "../lib/shop-mailer.server";

export const action = async ({ request }) => {
  const { shop, payload } = await authenticate.webhook(request);
  // The address is only kept when the shop sends its own emails (Gmail); Shopify Flow needs just the customer id.
  const channel = (await getEmailStatus(db, shop)).channel;
  await recordPreorderOrder(db, { shop, payload, storeEmail: channel === "smtp" });
  return new Response();
};
