// Fixed wording for the emails the app sends itself (through the shop's Gmail).
// The back-in-stock email lives in notify.server.js (buildEmail).
import { escapeHtml } from "./html.server";

const productName = (p) => (p.variantTitle ? `${p.productTitle} (${p.variantTitle})` : p.productTitle);
const productUrl = (shop, handle) => `https://${shop}${handle ? `/products/${encodeURIComponent(handle)}` : ""}`;
const longDate = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(iso ?? "") : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
};
const wrap = (lines, url, footer) => ({
  text: `${lines.join("\n\n")}\n\n${url}\n\n${footer}`,
  html: `${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("")}<p><a href="${escapeHtml(url)}">View the product</a></p><p style="color:#6d7175;font-size:12px">${escapeHtml(footer)}</p>`,
});

export function buildSignupConfirmationEmail({ shop, productTitle, variantTitle, productHandle }) {
  const name = productName({ productTitle, variantTitle });
  const url = productUrl(shop, productHandle);
  return {
    subject: `You're on the list for ${name}`.slice(0, 200),
    ...wrap([`You're on the waitlist for ${name}.`, "We'll send you one email as soon as it's back in stock."], url, "You received this email because you asked to be notified. We will not email you about this product again unless you sign up again."),
  };
}

export function buildShipEmail(kind, { shop, productTitle, variantTitle, orderName, shipDate, productHandle }) {
  const name = productName({ productTitle, variantTitle });
  const order = orderName ? ` (order ${orderName})` : "";
  const date = longDate(shipDate);
  const changed = kind === "SHIP_DATE_CHANGE";
  return {
    subject: (changed ? `New expected ship date for your pre-order: ${name}` : `Your pre-order ships soon: ${name}`).slice(0, 200),
    ...wrap(
      changed ? [`The expected ship date for your pre-order of ${name}${order} has changed.`, `New expected ship date: ${date}.`] : [`Your pre-order of ${name}${order} is expected to ship on ${date}.`],
      productUrl(shop, productHandle),
      "You received this email because you placed a pre-order. Dates are estimates and can change.",
    ),
  };
}

/** One email per order, listing every pre-order item: `lines` = [{ productTitle, variantTitle, quantity, shipDate, productHandle }]. */
export function buildPreorderConfirmationEmail({ shop, orderName, lines }) {
  const first = lines[0];
  const more = lines.length > 1 ? ` and ${lines.length - 1} more` : "";
  const order = orderName ? ` (order ${orderName})` : "";
  const items = lines.map((l) => `${l.quantity} × ${productName(l)}${l.shipDate ? `, expected to ship on ${longDate(l.shipDate)}` : ""}`);
  return {
    subject: `Your pre-order is confirmed: ${productName(first)}${more}`.slice(0, 200),
    ...wrap(
      [`Thank you! We've received your pre-order${order}.`, ...items],
      productUrl(shop, first.productHandle),
      "You received this email because you placed a pre-order. Dates are estimates and can change.",
    ),
  };
}
