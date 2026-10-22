// Pre-order lines of Shopify orders, kept so ship-date emails know who to tell. Stores a Shopify customer id and
// product facts only (no name, email or address).
import { effectiveShipDate } from "./campaign.server";

const isPreorderLine = (li) => Array.isArray(li?.properties) && li.properties.some((p) => p?.name === "_preorder" && String(p.value) === "true");
const dateFromProperty = (li) => {
  const v = li.properties.find((p) => p?.name === "_preorder_ship_date")?.value;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? ""));
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

/**
 * orders/create: remember each pre-order line. Idempotent per (order, line item). Returns how many were stored.
 * `storeEmail`: keep the buyer's address (only when the shop sends its own emails, e.g. Gmail; Flow needs just the customer id).
 */
export async function recordPreorderOrder(db, { shop, payload, storeEmail = false }) {
  const orderId = payload?.id != null ? String(payload.id) : null;
  if (!orderId) return { stored: 0 };
  const customerId = payload.customer?.id != null ? String(payload.customer.id) : null;
  const email = storeEmail ? String(payload.email ?? payload.customer?.email ?? "").trim().toLowerCase().slice(0, 254) || null : null;
  let stored = 0;
  for (const li of (payload.line_items ?? []).filter((l) => l?.variant_id && l?.id != null && isPreorderLine(l))) {
    const variantId = String(li.variant_id);
    const config = await db.preorderConfig.findUnique({ where: { shop_variantId: { shop, variantId } } });
    const campaign = config?.campaignId ? await db.campaign.findFirst({ where: { id: config.campaignId, shop } }) : null;
    // What the customer was shown at checkout wins over whatever the config says now.
    const told = dateFromProperty(li) ?? (config ? effectiveShipDate(config, campaign) : null);
    try {
      await db.preorderOrder.create({
        data: {
          shop, orderId, lineItemId: String(li.id), orderName: payload.name ? String(payload.name).slice(0, 40) : null, customerId, email, variantId,
          productId: String(li.product_id ?? config?.productId ?? ""), productTitle: String(li.title ?? config?.productTitle ?? "").slice(0, 255),
          variantTitle: li.variant_title ? String(li.variant_title).slice(0, 255) : config?.variantTitle ?? null,
          quantity: Math.max(1, Number(li.quantity) || 1), lastShipDate: told,
        },
      });
      stored++;
    } catch (e) {
      if (e?.code !== "P2002") throw e; // webhook retry: already stored
    }
  }
  return { stored };
}

/** orders/cancelled: stop ship-date emails for the order. */
export async function cancelPreorderOrder(db, { shop, payload }) {
  if (payload?.id == null) return { cancelled: 0 };
  const { count } = await db.preorderOrder.updateMany({ where: { shop, orderId: String(payload.id) }, data: { status: "CANCELLED" } });
  return { cancelled: count };
}

/** customers/redact: delete this customer's pre-order lines and the ship-date deliveries about them. */
export async function redactCustomerPreorders(db, { shop, customerId, email }) {
  const or = [...(customerId != null ? [{ customerId: String(customerId) }] : []), ...(email ? [{ email: String(email).trim().toLowerCase() }] : [])];
  if (!or.length) return { deleted: 0 };
  const rows = await db.preorderOrder.findMany({ where: { shop, OR: or }, select: { id: true } });
  const ids = rows.map((r) => r.id);
  if (!ids.length) return { deleted: 0 };
  const deliveries = await db.notificationDelivery.findMany({ where: { shop, entryId: { in: ids } }, select: { id: true } });
  await db.notificationAttempt.deleteMany({ where: { shop, deliveryId: { in: deliveries.map((d) => d.id) } } });
  await db.notificationDelivery.deleteMany({ where: { shop, entryId: { in: ids } } });
  const { count } = await db.preorderOrder.deleteMany({ where: { shop, id: { in: ids } } });
  return { deleted: count };
}
