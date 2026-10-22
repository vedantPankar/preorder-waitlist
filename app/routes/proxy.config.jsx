import { authenticate } from "../shopify.server";
import db from "../db.server";
import { storefrontConfig } from "../lib/preorder.server";
import { reconcileShop } from "../lib/campaign.server";
import { storefrontDisplay } from "../lib/settings.server";
import { toNumericId } from "../lib/validation.server";

// Storefront -> /apps/waitlist/config?product=<id>: public pre-order settings.
export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.public.appProxy(request);
  const productId = toNumericId(new URL(request.url).searchParams.get("product"));
  if (!session || !productId) return Response.json({ variants: [], waitlistEnabled: false }, { status: session ? 422 : 503 });
  const now = new Date();
  // A campaign may have started/ended since anything last touched Shopify: bring the
  // inventory policy in line before answering. Never let a Shopify hiccup break the page.
  if (admin) {
    try { await reconcileShop(db, admin, session.shop, now, { productId }); } catch (e) { console.error("Campaign reconcile failed:", e?.message); }
  }
  const [variants, settings] = await Promise.all([
    storefrontConfig(db, session.shop, productId, { now }),
    db.shopSettings.findUnique({ where: { shop: session.shop } }),
  ]);
  return Response.json(
    { waitlistEnabled: settings?.waitlistEnabled !== false, requirePreorderLogin: settings?.requirePreorderLogin === true, serverNow: now.toISOString(), display: storefrontDisplay(settings), variants },
    { headers: { "Cache-Control": "no-store" } },
  );
};
