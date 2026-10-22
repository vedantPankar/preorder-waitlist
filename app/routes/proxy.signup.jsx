import { setImmediate } from "node:timers";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { handleSignupRequest } from "../lib/signup.server";
import { getEmailStatus, getShopMailer } from "../lib/shop-mailer.server";
import { processFlowDeliveries } from "../lib/flow-notify.server";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// Storefront -> /apps/waitlist/signup (Shopify app proxy). The proxy signature
// is verified by authenticate.public.appProxy, which establishes the shop.
export const action = async ({ request }) => {
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin || !session) return json({ ok: false, error: "app_not_installed", message: "Notifications are unavailable right now." }, 503);

  let input;
  try {
    const type = request.headers.get("content-type") || "";
    input = type.includes("application/json") ? await request.json() : Object.fromEntries(await request.formData());
  } catch {
    return json({ ok: false, error: "bad_request", message: "Invalid request." }, 400);
  }
  // The confirmation goes out through the shop's own Gmail.
  const status_ = await getEmailStatus(db, session.shop);
  const canConfirm = status_.configured;
  const { status, body, confirmationQueued } = await handleSignupRequest({ db, admin, shop: session.shop, input, canConfirm });
  // Send the queued confirmation after answering: the visitor never waits for the email to send. If this is lost
  // (process exit) the queue runner / scheduler sends it later.
  if (confirmationQueued) setImmediate(async () => processFlowDeliveries(db, { shop: session.shop, mailer: await getShopMailer(db, session.shop, { admin }), budgetMs: 8000 }).catch((e) => console.error("Signup confirmation failed:", e?.message)));
  return json(body, status);
};
