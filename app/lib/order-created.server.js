// orders/create: remember the order's pre-order lines and, when the shop turned it on and its Gmail can send,
// queue the pre-order confirmation email. Returns { stored, confirmationQueued }; `confirmationQueued` tells the
// route it may send the queued email now (never sent from here, so the webhook answers fast).
import { recordPreorderOrder } from "./preorder-orders.server";
import { enqueuePreorderConfirmation } from "./flow-notify.server";
import { fetchVariants } from "./shopify-data.server";

export async function handleOrderCreate({ db, shop, payload, admin, emailStatus }) {
  // The buyer's address is only kept when the shop sends through Gmail, which needs it for these emails.
  const { stored } = await recordPreorderOrder(db, { shop, payload, storeEmail: emailStatus?.channel === "smtp" });
  const settings = await db.shopSettings.findUnique({ where: { shop }, select: { emailPreorderConfirmation: true } });
  if (!stored || !emailStatus?.configured || !settings?.emailPreorderConfirmation) return { stored, confirmationQueued: false };
  const resolveHandles = async (ids) => (admin ? new Map((await fetchVariants(admin, ids)).map((v) => [v.variantId, v.productHandle])) : new Map());
  const { queued } = await enqueuePreorderConfirmation(db, { shop, orderId: String(payload.id), resolveHandles });
  return { stored, confirmationQueued: queued };
}
