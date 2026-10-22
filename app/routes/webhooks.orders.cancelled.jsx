import { authenticate } from "../shopify.server";
import db from "../db.server";
import { cancelPreorderOrder } from "../lib/preorder-orders.server";

export const action = async ({ request }) => {
  const { shop, payload } = await authenticate.webhook(request);
  await cancelPreorderOrder(db, { shop, payload });
  return new Response();
};
