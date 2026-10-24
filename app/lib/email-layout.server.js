// The look of the emails the app sends: six layouts, an accent colour, an optional logo, a font style and a header style. Only the HTML is styled;
// the wording, the subjects and the plain-text versions belong to the callers and are not touched here.
// Email clients are picky, so the designed layouts are table-based with inline styles only (no <style> blocks, no web fonts).
import { escapeHtml } from "./html.server";

export const EMAIL_TEMPLATES = { classic: "Classic", modern: "Modern", minimal: "Minimal", bold: "Bold", elegant: "Elegant", dark: "Dark" };
// Safe system font stacks only: email clients ignore web fonts. null = the template's own font (Elegant is serif, the rest sans-serif).
export const EMAIL_FONTS = { sans: "Sans-serif", serif: "Serif", rounded: "Rounded" };
export const EMAIL_HEADERS = { logo: "Show logo", name: "Show store name", none: "Hide header" };
const FONT_STACKS = {
  sans: "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  serif: "Georgia,'Times New Roman',Times,serif",
  rounded: "ui-rounded,'SF Pro Rounded','Hiragino Maru Gothic ProN',Quicksand,Nunito,'Trebuchet MS',Verdana,sans-serif",
};
const NATIVE_FONT = { elegant: "serif" };
export const DEFAULT_EMAIL_TEMPLATE = "classic";
export const DEFAULT_ACCENT = "#006F5C";
const HEX = /^#[0-9a-fA-F]{6}$/;

/** A valid #RRGGBB colour (upper-cased), or null. */
export function cleanAccent(value) {
  const c = String(value ?? "").trim();
  return HEX.test(c) ? c.toUpperCase() : null;
}

/** An https:// image address without credentials, quotes or spaces, or null. */
export function cleanLogoUrl(value) {
  const s = String(value ?? "").trim();
  if (!s || s.length > 500 || /[\s"'<>\\]/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
  return u.href;
}

/** The brand to render with, from a ShopSettings row (or nothing). Anything invalid falls back to the default look. */
export function brandFromSettings(row) {
  const template = Object.hasOwn(EMAIL_TEMPLATES, row?.emailTemplate) ? row.emailTemplate : DEFAULT_EMAIL_TEMPLATE;
  return {
    template, accent: cleanAccent(row?.emailAccentColor), logoUrl: cleanLogoUrl(row?.emailLogoUrl),
    font: Object.hasOwn(EMAIL_FONTS, row?.emailFont) ? row.emailFont : null,
    header: Object.hasOwn(EMAIL_HEADERS, row?.emailHeader) ? row.emailHeader : null,
  };
}

/** Validates the Email templates form. Blank accent / logo mean "use the default". @returns {{ errors: object } | { data: object }} */
export function parseEmailLookForm(form) {
  const errors = {};
  const template = String(form.get("emailTemplate") ?? "");
  if (!Object.hasOwn(EMAIL_TEMPLATES, template)) errors.emailTemplate = "Choose one of the templates.";
  const accentRaw = String(form.get("emailAccentColor") ?? "").trim();
  let accent = null;
  if (accentRaw) {
    accent = cleanAccent(accentRaw);
    if (!accent) errors.emailAccentColor = "Enter a colour like #006F5C.";
    else if (accent === DEFAULT_ACCENT) accent = null; // the default stays "unset", so Classic keeps its current look
  }
  const logoRaw = String(form.get("emailLogoUrl") ?? "").trim();
  let logoUrl = null;
  if (logoRaw) {
    logoUrl = cleanLogoUrl(logoRaw);
    if (!logoUrl) errors.emailLogoUrl = "Enter an image address that starts with https://";
  }
  // Blank = "template default" for both choices.
  const fontRaw = String(form.get("emailFont") ?? "").trim();
  if (fontRaw && !Object.hasOwn(EMAIL_FONTS, fontRaw)) errors.emailFont = "Choose one of the font styles.";
  const headerRaw = String(form.get("emailHeader") ?? "").trim();
  if (headerRaw && !Object.hasOwn(EMAIL_HEADERS, headerRaw)) errors.emailHeader = "Choose one of the header styles.";
  return Object.keys(errors).length ? { errors } : { data: { emailTemplate: template, emailAccentColor: accent, emailLogoUrl: logoUrl, emailFont: fontRaw || null, emailHeader: headerRaw || null } };
}

// Black or white text, whichever reads better on the accent colour (WCAG relative luminance).
function readableOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#202223" : "#FFFFFF";
}

// A paragraph is a string, or a list of strings and { strong } pieces. Everything is escaped here.
const inline = (p) => (Array.isArray(p) ? p : [p]).map((s) => (typeof s === "string" ? escapeHtml(s) : `<strong>${escapeHtml(s.strong)}</strong>`)).join("");

const fontStack = (b) => FONT_STACKS[b.font ?? NATIVE_FONT[b.template] ?? "sans"];
const accentOf = (b) => b.accent ?? DEFAULT_ACCENT;

/** What the header shows: "logo", "name" or "none". Unset = the logo if there is one, else the store name (Classic: else nothing). */
function headerMode(b, whenNoLogo) {
  if (b.header === "none" || b.header === "name") return b.header;
  return b.logoUrl ? "logo" : whenNoLogo;
}
const logoImg = (b, shop, style) => `<img src="${escapeHtml(b.logoUrl)}" alt="${escapeHtml(shop)}" style="${style}">`;

function classic({ brand, shop, paragraphs, button, footer }) {
  const mode = headerMode(brand, "none");
  const header = mode === "logo" ? `<p>${logoImg(brand, shop, "max-width:200px;max-height:60px;border:0")}</p>` : mode === "name" ? `<p><strong>${escapeHtml(shop)}</strong></p>` : "";
  const link = brand.accent ? ` style="color:${brand.accent}"` : "";
  const inner = `${header}${paragraphs.map((p) => `<p>${inline(p)}</p>`).join("")}<p><a href="${escapeHtml(button.url)}"${link}>${escapeHtml(button.label)}</a></p><p style="color:#6d7175;font-size:12px">${escapeHtml(footer)}</p>`;
  return brand.font ? `<div style="font-family:${fontStack(brand)}">${inner}</div>` : inner;
}

const page = (shop, body, background, scheme = "light") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="${scheme}"><title>${escapeHtml(shop)}</title></head><body style="margin:0;padding:0;background:${background}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${background}" style="background:${background}"><tr><td align="center" style="padding:24px 12px">${body}</td></tr></table></body></html>`;

// A solid button that survives Outlook (a coloured cell around the link). `extra` adds link styles.
const solidButton = (url, label, bg, fg, font, { size = 16, pad = "12px 24px", radius = 6 } = {}) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${bg}" style="background:${bg};border-radius:${radius}px"><a href="${escapeHtml(url)}" style="display:inline-block;padding:${pad};font-family:${font};font-size:${size}px;font-weight:700;color:${fg};text-decoration:none">${escapeHtml(label)}</a></td></tr></table>`;

function modern({ brand, shop, paragraphs, button, footer }) {
  const accent = accentOf(brand), font = fontStack(brand), mode = headerMode(brand, "name");
  const header = mode === "logo" ? logoImg(brand, shop, "display:block;max-width:200px;max-height:60px;border:0") : mode === "name" ? `<span style="font-size:18px;font-weight:700;color:#202223">${escapeHtml(shop)}</span>` : "";
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${inline(p)}</p>`).join("");
  return page(shop, `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background:#ffffff;border-top:4px solid ${accent};border-radius:8px">
${header ? `<tr><td style="padding:28px 32px 12px;font-family:${font}">${header}</td></tr>\n` : ""}<tr><td style="padding:${header ? 8 : 28}px 32px 8px;font-family:${font};font-size:16px;line-height:1.55;color:#202223">${body}</td></tr>
<tr><td style="padding:8px 32px 28px">${solidButton(button.url, button.label, accent, readableOn(accent), font)}</td></tr>
<tr><td style="padding:16px 32px 28px;border-top:1px solid #e3e5e7;font-family:${font};font-size:12px;line-height:1.5;color:#6d7175">${escapeHtml(footer)}</td></tr></table>`, "#f1f2f4");
}

function minimal({ brand, shop, paragraphs, button, footer }) {
  const accent = accentOf(brand), font = fontStack(brand), mode = headerMode(brand, "name");
  const header = mode === "logo" ? logoImg(brand, shop, "display:block;max-width:180px;max-height:48px;border:0") : mode === "name" ? `<span style="font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#6d7175">${escapeHtml(shop)}</span>` : "";
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${inline(p)}</p>`).join("");
  return page(shop, `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;text-align:left">
<tr><td style="padding:${header ? "0 0 20px" : "0"};border-bottom:2px solid ${accent};font-family:${font}">${header || "&nbsp;"}</td></tr>
<tr><td style="padding:24px 0 8px;font-family:${font};font-size:16px;line-height:1.6;color:#202223">${body}</td></tr>
<tr><td style="padding:0 0 28px"><a href="${escapeHtml(button.url)}" style="display:inline-block;padding:10px 20px;font-family:${font};font-size:15px;font-weight:600;color:${accent};text-decoration:none;border:1px solid ${accent};border-radius:4px">${escapeHtml(button.label)}</a></td></tr>
<tr><td style="padding:0;font-family:${font};font-size:12px;line-height:1.5;color:#6d7175">${escapeHtml(footer)}</td></tr></table>`, "#ffffff");
}

// Bold: a full-width colour band for the header, a large first line and a big button.
function bold({ brand, shop, paragraphs, button, footer }) {
  const accent = accentOf(brand), font = fontStack(brand), on = readableOn(accent), mode = headerMode(brand, "name");
  const header = mode === "logo" ? logoImg(brand, shop, "display:block;max-width:200px;max-height:60px;border:0")
    : mode === "name" ? `<span style="font-size:20px;font-weight:800;color:${on}">${escapeHtml(shop)}</span>` : "";
  const band = header ? `<tr><td bgcolor="${accent}" style="background:${accent};padding:24px 32px;font-family:${font}">${header}</td></tr>`
    : `<tr><td bgcolor="${accent}" height="8" style="background:${accent};height:8px;line-height:8px;font-size:8px">&nbsp;</td></tr>`;
  const [lead, ...rest] = paragraphs;
  const body = `<p style="margin:0 0 20px;font-size:24px;line-height:1.3;font-weight:800;color:#111213">${inline(lead)}</p>${rest.map((p) => `<p style="margin:0 0 16px">${inline(p)}</p>`).join("")}`;
  return page(shop, `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden">
${band}
<tr><td style="padding:32px 32px 8px;font-family:${font};font-size:16px;line-height:1.6;color:#202223">${body}</td></tr>
<tr><td style="padding:8px 32px 32px">${solidButton(button.url, button.label, accent, on, font, { size: 17, pad: "16px 32px", radius: 8 })}</td></tr>
<tr><td style="padding:16px 32px 28px;background:#f6f6f7;font-family:${font};font-size:12px;line-height:1.5;color:#6d7175">${escapeHtml(footer)}</td></tr></table>`, "#eceef0");
}

// Elegant: serif by default, centred, a hairline divider and a quiet outlined button.
function elegant({ brand, shop, paragraphs, button, footer }) {
  const accent = accentOf(brand), font = fontStack(brand), mode = headerMode(brand, "name");
  const header = mode === "logo" ? logoImg(brand, shop, "display:block;margin:0 auto;max-width:200px;max-height:60px;border:0")
    : mode === "name" ? `<span style="font-size:15px;letter-spacing:.22em;text-transform:uppercase;color:#3a3a3a">${escapeHtml(shop)}</span>` : "";
  const divider = `<table role="presentation" align="center" width="56" cellpadding="0" cellspacing="0" border="0" style="margin:${header ? "20px" : "0"} auto 0"><tr><td bgcolor="${accent}" height="1" style="background:${accent};height:1px;line-height:1px;font-size:1px">&nbsp;</td></tr></table>`;
  const body = paragraphs.map((p) => `<p style="margin:0 0 18px">${inline(p)}</p>`).join("");
  return page(shop, `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e8e1d5;text-align:center">
<tr><td align="center" style="padding:40px 32px 8px;font-family:${font}">${header}${divider}</td></tr>
<tr><td align="center" style="padding:24px 40px 8px;font-family:${font};font-size:17px;line-height:1.75;color:#3a3a3a">${body}</td></tr>
<tr><td align="center" style="padding:8px 32px 36px"><a href="${escapeHtml(button.url)}" style="display:inline-block;padding:14px 32px;font-family:${font};font-size:15px;letter-spacing:.08em;color:${accent};text-decoration:none;border:1px solid ${accent}">${escapeHtml(button.label)}</a></td></tr>
<tr><td align="center" style="padding:20px 32px 32px;border-top:1px solid #efe9de;font-family:${font};font-size:12px;line-height:1.6;color:#8a8478">${escapeHtml(footer)}</td></tr></table>`, "#faf7f2");
}

// Dark: a dark card with light text, drawn explicitly (it does not depend on the mail client's dark mode).
function dark({ brand, shop, paragraphs, button, footer }) {
  const accent = accentOf(brand), font = fontStack(brand), mode = headerMode(brand, "name");
  const header = mode === "logo" ? logoImg(brand, shop, "display:block;max-width:200px;max-height:60px;border:0")
    : mode === "name" ? `<span style="font-size:18px;font-weight:700;color:#ffffff">${escapeHtml(shop)}</span>` : "";
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${inline(p)}</p>`).join("");
  return page(shop, `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#1c1d20" style="width:100%;max-width:600px;background:#1c1d20;border-top:4px solid ${accent};border-radius:8px">
${header ? `<tr><td style="padding:28px 32px 12px;font-family:${font}">${header}</td></tr>\n` : ""}<tr><td style="padding:${header ? 8 : 28}px 32px 8px;font-family:${font};font-size:16px;line-height:1.55;color:#e8eaed">${body}</td></tr>
<tr><td style="padding:8px 32px 28px">${solidButton(button.url, button.label, accent, readableOn(accent), font)}</td></tr>
<tr><td style="padding:16px 32px 28px;border-top:1px solid #34363b;font-family:${font};font-size:12px;line-height:1.5;color:#9aa0a6">${escapeHtml(footer)}</td></tr></table>`, "#0f1012", "dark light");
}

const LAYOUTS = { classic, modern, minimal, bold, elegant, dark };

/**
 * The HTML body of an email.
 * @param {{ template: string, accent: string|null, logoUrl: string|null, font?: string|null, header?: string|null }} brand  (from brandFromSettings)
 * @param {{ shop: string, paragraphs: Array<string|Array<string|{strong: string}>>, button: { label: string, url: string }, footer: string }} content
 */
export function renderEmail(brand, content) {
  // Re-clean everything so a hand-built brand can never put raw values into the markup.
  const b = brandFromSettings({ emailTemplate: brand?.template, emailAccentColor: brand?.accent, emailLogoUrl: brand?.logoUrl, emailFont: brand?.font, emailHeader: brand?.header });
  return LAYOUTS[b.template]({ ...content, brand: b });
}
