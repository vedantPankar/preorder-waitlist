import { authenticate } from "../shopify.server";
import db from "../db.server";
import { recordClick } from "../lib/notify.server";

// Opt-in click tracking for restock emails: /apps/waitlist/r/<token>. The app proxy
// signature establishes the shop; we count the click (no IP, no user agent stored) and
// redirect to a product path that this app generated itself, never to a user-supplied URL.
export const loader = async ({ request, params }) => {
  const { session } = await authenticate.public.appProxy(request);
  const fallback = "/";
  if (!session) return new Response(null, { status: 302, headers: { Location: fallback, "Cache-Control": "no-store" } });
  let target = null;
  try { target = await recordClick(db, session.shop, params.token); } catch { target = null; }
  const safe = typeof target === "string" && target.startsWith("/products/") ? target : fallback;
  return new Response(null, { status: 302, headers: { Location: safe, "Cache-Control": "no-store" } });
};
