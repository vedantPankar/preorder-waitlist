import { authenticate } from "../shopify.server";
import db from "../db.server";
import { handleReserveRequest } from "../lib/reserve-request.server";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// Storefront -> /apps/waitlist/reserve (Shopify app proxy; signature verified by authenticate.public.appProxy).
// Takes (or releases) a short hold on pre-order units BEFORE the item is added to the cart.
export const action = async ({ request }) => {
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ ok: false, error: "app_not_installed", message: "Pre-orders are unavailable right now." }, 503);
  let input;
  try { input = await request.json(); } catch { return json({ ok: false, error: "bad_request", message: "Invalid request." }, 400); }
  // The app proxy signs `logged_in_customer_id`; it is empty for guests.
  const loggedInCustomerId = new URL(request.url).searchParams.get("logged_in_customer_id") || null;
  const { status, body } = await handleReserveRequest({ db, shop: session.shop, input, loggedInCustomerId });
  return json(body, status);
};
