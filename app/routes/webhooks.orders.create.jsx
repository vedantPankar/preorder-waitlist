import { authenticate } from "../shopify.server";
import db from "../db.server";
import { recordPreorderOrder } from "../lib/preorder-orders.server";
import { getEmailStatus } from "../lib/shop-mailer.server";

export const action = async ({ request }) => {
  const { shop, payload } = await authenticate.webhook(request);
  // The buyer's address is only kept when the shop sends through Gmail, which needs it for ship-date emails.
  const channel = (await getEmailStatus(db, shop)).channel;
  await recordPreorderOrder(db, { shop, payload, storeEmail: channel === "smtp" });
  return new Response();
};
