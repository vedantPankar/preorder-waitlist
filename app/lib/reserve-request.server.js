import { releaseReservation, reserve } from "./campaign.server";
import { toNumericId } from "./validation.server";

const MESSAGES = {
  not_configured: "This item is not available for pre-order.",
  closed: "Pre-orders are not open right now.",
  sold_out: "Sorry, this item is no longer available for pre-order.",
  invalid_quantity: "Choose a quantity between 1 and 10.",
  invalid_request: "Invalid request.",
  login_required: "Please log in to pre-order.",
};

/**
 * Handles POST /apps/waitlist/reserve ({intent: "reserve" | "release"}). Returns { status, body }.
 * `loggedInCustomerId` is the signed `logged_in_customer_id` the app proxy adds for a logged-in customer
 * (empty for guests). When the shop requires login, a guest never gets a hold.
 */
export async function handleReserveRequest({ db, shop, input, loggedInCustomerId = null, now = new Date() }) {
  if (input?.intent === "release") {
    const released = await releaseReservation(db, shop, input.reservationId, now);
    return { status: 200, body: { ok: true, released } };
  }
  const variantId = toNumericId(input?.variantId);
  const productId = toNumericId(input?.productId);
  if (!variantId || !productId) return { status: 422, body: { ok: false, error: "invalid_request", message: MESSAGES.invalid_request } };
  const settings = await db.shopSettings.findUnique({ where: { shop }, select: { requirePreorderLogin: true } });
  if (settings?.requirePreorderLogin && !loggedInCustomerId) return { status: 401, body: { ok: false, error: "login_required", message: MESSAGES.login_required } };
  const config = await db.preorderConfig.findUnique({ where: { shop_variantId: { shop, variantId } } });
  // The variant must belong to the product the page says it does (and to this shop).
  if (!config || config.productId !== productId) return { status: 409, body: { ok: false, error: "not_configured", message: MESSAGES.not_configured } };
  const r = await reserve(db, { shop, variantId, quantity: Number(input.quantity), now });
  if (r.ok) {
    return { status: 200, body: { ok: true, limited: r.limited, reservationId: r.reservationId ?? null, expiresAt: r.expiresAt?.toISOString?.() ?? null, remaining: r.remaining } };
  }
  const message = r.error === "limit" ? (r.remaining > 0 ? `Only ${r.remaining} left for pre-order.` : MESSAGES.sold_out) : MESSAGES[r.error] ?? MESSAGES.closed;
  return { status: r.error === "invalid_quantity" ? 422 : 409, body: { ok: false, error: r.error, remaining: r.remaining ?? null, message } };
}
