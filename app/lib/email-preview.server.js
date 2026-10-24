// Sample versions of every email the app sends, for the Email templates page (preview and test send).
import { buildPreorderConfirmationEmail, buildShipEmail, buildSignupConfirmationEmail } from "./email-templates.server";
import { buildEmail } from "./notify.server";

export const PREVIEW_KINDS = {
  restock: "Back in stock",
  signup: "Waitlist signup confirmation",
  preorder: "Pre-order confirmation",
  reminder: "Ship-date reminder",
  change: "Ship-date change",
};

const SAMPLE = { productTitle: "The Out of Stock Snowboard", variantTitle: "Ocean", productHandle: "out-of-stock-snowboard" };

/** `{ subject, text, html }` for a kind, filled with sample data. Unknown kinds fall back to the restock email. */
export function buildPreviewEmail(kind, { shop, brand, settings }) {
  const ship = { ...SAMPLE, orderName: "#1042", shipDate: "2026-12-12" };
  switch (kind) {
    case "signup": return buildSignupConfirmationEmail({ shop, ...SAMPLE, brand });
    case "preorder": return buildPreorderConfirmationEmail({ shop, orderName: "#1042", brand, lines: [{ ...SAMPLE, quantity: 1, shipDate: "2026-12-12" }, { productTitle: "Gift card", variantTitle: "$50", quantity: 2, shipDate: "2026-12-20", productHandle: "gift-card" }] });
    case "reminder": return buildShipEmail("SHIP_REMINDER", { shop, ...ship, brand });
    case "change": return buildShipEmail("SHIP_DATE_CHANGE", { shop, ...ship, shipDate: "2026-12-19", brand });
    default: return buildEmail({ shop, brand, settings, variant: { ...SAMPLE, variantId: "1" }, delivery: null });
  }
}
