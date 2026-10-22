import { authenticate } from "../shopify.server";
import db from "../db.server";
import { handleShopRedact } from "../lib/webhooks.server";

export const action = async ({ request }) => {
  const { shop } = await authenticate.webhook(request);
  await handleShopRedact({ db, shop });
  return new Response();
};
