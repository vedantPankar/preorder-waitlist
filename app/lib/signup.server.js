import { fetchVariants } from "./shopify-data.server";
import { toNumericId, isValidEmail } from "./validation.server";
import { addSignup, WaitlistError } from "./waitlist.server";
import { enqueueSignupConfirmation } from "./flow-notify.server";

const MESSAGES = {
  invalid_email: "Please enter a valid email address.",
  invalid_product: "This product could not be found.",
  waitlist_disabled: "The waitlist is not available right now.",
  in_stock: "This item is currently in stock.",
};

/**
 * Handles a public signup request. Returns { status, body } for the route; `confirmationQueued` tells the route it
 * may send the queued signup confirmation now (never part of the JSON body).
 * `canConfirm`: the shop's email channel can send the confirmation (Shopify Flow or its own Gmail).
 */
export async function handleSignupRequest({ db, admin, shop, input, canConfirm = false }) {
  // Honeypot: bots fill hidden fields. Pretend success, store nothing.
  if (input?.website) return { status: 200, body: { ok: true, result: "created" } };

  const settings = await db.shopSettings.findUnique({ where: { shop } });
  if (settings && settings.waitlistEnabled === false) {
    return { status: 403, body: { ok: false, error: "waitlist_disabled", message: MESSAGES.waitlist_disabled } };
  }
  if (!isValidEmail(input?.email)) return { status: 422, body: { ok: false, error: "invalid_email", message: MESSAGES.invalid_email } };
  const productId = toNumericId(input?.productId);
  const variantId = toNumericId(input?.variantId);
  if (!productId || !variantId) return { status: 422, body: { ok: false, error: "invalid_product", message: MESSAGES.invalid_product } };

  const [variant] = await fetchVariants(admin, [variantId]);
  if (!variant || variant.productId !== productId) {
    return { status: 422, body: { ok: false, error: "invalid_product", message: MESSAGES.invalid_product } };
  }
  if (variant.inventoryQuantity > 0) {
    return { status: 409, body: { ok: false, error: "in_stock", message: MESSAGES.in_stock } };
  }
  try {
    const { result, entry } = await addSignup(db, { shop, email: input.email, variant });
    let confirmationQueued = false;
    if (result === "created" && entry && canConfirm && settings?.emailSignupConfirmation === true) {
      confirmationQueued = (await enqueueSignupConfirmation(db, { shop, entry, variant })).queued;
    }
    return { status: 200, body: { ok: true, result }, confirmationQueued };
  } catch (error) {
    if (error instanceof WaitlistError) return { status: 422, body: { ok: false, error: error.code, message: error.message } };
    throw error;
  }
}
