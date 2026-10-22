const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isValidEmail(value) {
  const email = normalizeEmail(value);
  return email.length <= 254 && EMAIL_RE.test(email);
}

/** Accepts "123" or "gid://shopify/Product/123"; returns the numeric string or null. */
export function toNumericId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = String(value).match(/^(?:gid:\/\/shopify\/\w+\/)?(\d{1,20})$/);
  return match ? match[1] : null;
}

export function toGid(type, id) {
  const numeric = toNumericId(id);
  return numeric ? `gid://shopify/${type}/${numeric}` : null;
}

export function isValidShopDomain(shop) {
  return typeof shop === "string" && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

export function cleanText(value, max) {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

/** Parses "YYYY-MM-DD" into a UTC Date, or null. */
export function parseDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? null
    : date;
}

export function parsePositiveInt(value, max = 1_000_000) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= max ? n : NaN;
}
