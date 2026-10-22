import { setImmediate } from "node:timers";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { handleOrderCreate } from "../lib/order-created.server";
import { processFlowDeliveries } from "../lib/flow-notify.server";
import { getEmailStatus, getShopMailer } from "../lib/shop-mailer.server";

export const action = async ({ request }) => {
  const { shop, payload, admin } = await authenticate.webhook(request);
  const { confirmationQueued } = await handleOrderCreate({ db, shop, payload, admin, emailStatus: await getEmailStatus(db, shop) });
  // Send the queued confirmation after answering Shopify. If this is lost (process exit) the queue runner sends it later.
  if (confirmationQueued) setImmediate(async () => processFlowDeliveries(db, { shop, mailer: await getShopMailer(db, shop), budgetMs: 8000 }).catch((e) => console.error("Pre-order confirmation send failed:", e?.message)));
  return new Response();
};
