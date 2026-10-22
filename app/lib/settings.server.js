import { DEFAULT_DAILY_CAP, MAX_DAILY_CAP } from "./gmail.server";

// Shop-wide settings: validation of the Settings form, plus the pieces other pages and the
// storefront read (form defaults, storefront display).

export const DEFAULT_SUBJECT = "{{product}} is back in stock";
export const BUTTON_STYLES = ["solid", "outline"];
export const COUNTDOWN_STYLES = { dhms: "Days · Hours · Minutes · Seconds", hms: "Hours · Minutes · Seconds", compact: "Compact (12d 08:24:16)" };
const HEX = /^#[0-9a-fA-F]{6}$/;

const blank = (v) => v === null || v === undefined || String(v).trim() === "";
const flag = (v) => ["on", "true"].includes(String(v));

/** Fields shown on the Settings page, from a ShopSettings row (or nothing). */
export function settingsView(row) {
  const s = row ?? {};
  return {
    fromName: s.fromName ?? "", replyToEmail: s.replyToEmail ?? "", subject: s.subject ?? DEFAULT_SUBJECT,
    retentionDays: s.retentionDays ?? 90, waitlistEnabled: s.waitlistEnabled ?? true, requirePreorderLogin: s.requirePreorderLogin ?? false,
    gmailAddress: s.gmailAddress ?? "", gmailConfigured: Boolean(s.gmailAddress && s.gmailPasswordEnc), dailySendCap: s.dailySendCap ?? DEFAULT_DAILY_CAP, // never the password, not even encrypted
    emailSignupConfirmation: s.emailSignupConfirmation ?? false, emailPreorderConfirmation: s.emailPreorderConfirmation ?? false, emailShipReminder: s.emailShipReminder ?? false, emailShipDateChange: s.emailShipDateChange ?? false, shipReminderDays: s.shipReminderDays ?? 3,
    trackClicks: s.trackClicks ?? false,
    defaultButtonText: s.defaultButtonText ?? "Pre-Order Now", defaultMaxQuantity: s.defaultMaxQuantity ?? "", defaultTargetUnits: s.defaultTargetUnits ?? "",
    defaultShowCountdown: s.defaultShowCountdown ?? false, defaultShowProgress: s.defaultShowProgress ?? false,
    buttonStyle: s.buttonStyle ?? "solid", buttonColor: s.buttonColor ?? "#006F5C", buttonTextColor: s.buttonTextColor ?? "#FFFFFF",
    progressColor: s.progressColor ?? "#006F5C", countdownStyle: s.countdownStyle ?? "dhms", displayCustomized: s.displayCustomized ?? false,
  };
}

/** Defaults the Product configuration and Campaign forms start from. */
export function formDefaults(row) {
  const v = settingsView(row);
  return { buttonText: v.defaultButtonText, maxQuantity: v.defaultMaxQuantity, targetUnits: v.defaultTargetUnits, showCountdown: v.defaultShowCountdown, showProgress: v.defaultShowProgress };
}

/** The look the storefront block should use, or null while the merchant has not customised it. */
export function storefrontDisplay(row) {
  if (!row?.displayCustomized) return null;
  const v = settingsView(row);
  return { buttonStyle: v.buttonStyle, buttonColor: v.buttonColor, buttonTextColor: v.buttonTextColor, progressColor: v.progressColor, countdownStyle: v.countdownStyle };
}

/**
 * Validates the Settings form against the current row. A field missing from the form keeps its
 * current value, so the page can be saved in parts or by older clients.
 * @returns {{ errors: object } | { data: object }}
 */
export function parseSettingsForm(form, current, { isValidEmail, cleanText }) {
  const v = settingsView(current);
  const has = (k) => form.get(k) !== null;
  const errors = {};
  const intField = (key, { min, max, message, optional = false }) => {
    if (!has(key)) return v[key] === "" ? null : v[key];
    if (blank(form.get(key))) { if (optional) return null; errors[key] = message; return v[key]; }
    const n = Number(form.get(key));
    if (!Number.isInteger(n) || n < min || n > max) { errors[key] = message; return v[key]; }
    return n;
  };
  const text = (key, max) => (has(key) ? cleanText(form.get(key), max) : v[key]);
  const color = (key) => {
    if (!has(key)) return v[key];
    const c = String(form.get(key)).trim();
    if (!HEX.test(c)) { errors[key] = "Enter a colour like #006F5C."; return v[key]; }
    return c.toUpperCase();
  };

  const gmailRaw = has("gmailAddress") ? cleanText(form.get("gmailAddress"), 254).toLowerCase() : "";
  if (gmailRaw && !isValidEmail(gmailRaw)) errors.gmailAddress = "Enter the Gmail or Google Workspace address you send from.";
  const replyToEmail = text("replyToEmail", 254);
  if (replyToEmail && !isValidEmail(replyToEmail)) errors.replyToEmail = "Enter a valid email address.";
  const subject = has("subject") ? cleanText(form.get("subject"), 150) || DEFAULT_SUBJECT : v.subject;
  const buttonText = has("defaultButtonText") ? cleanText(form.get("defaultButtonText"), 40) || "Pre-Order Now" : v.defaultButtonText;
  const buttonStyle = has("buttonStyle") ? String(form.get("buttonStyle")) : v.buttonStyle;
  if (!BUTTON_STYLES.includes(buttonStyle)) errors.buttonStyle = "Choose Solid or Outline.";
  const countdownStyle = has("countdownStyle") ? String(form.get("countdownStyle")) : v.countdownStyle;
  if (!COUNTDOWN_STYLES[countdownStyle]) errors.countdownStyle = "Choose a countdown style.";

  const data = {
    fromName: text("fromName", 80) || null, replyToEmail: replyToEmail || null, subject,
    retentionDays: intField("retentionDays", { min: 1, max: 3650, message: "Enter a number of days between 1 and 3650." }),
    // A blank address keeps the stored one (use "Disconnect Gmail" to remove it). The password is handled by the route, never here.
    gmailAddress: gmailRaw || v.gmailAddress || null,
    dailySendCap: intField("dailySendCap", { min: 1, max: MAX_DAILY_CAP, message: `Enter a whole number between 1 and ${MAX_DAILY_CAP}.` }),
    shipReminderDays: intField("shipReminderDays", { min: 1, max: 60, message: "Enter a whole number of days between 1 and 60." }),
    defaultButtonText: buttonText,
    defaultMaxQuantity: intField("defaultMaxQuantity", { min: 1, max: 1000000, optional: true, message: "Enter a whole number of 1 or more, or leave blank." }),
    defaultTargetUnits: intField("defaultTargetUnits", { min: 1, max: 1000000, optional: true, message: "Enter a whole number of 1 or more, or leave blank." }),
    buttonStyle, countdownStyle, buttonColor: color("buttonColor"), buttonTextColor: color("buttonTextColor"), progressColor: color("progressColor"),
  };
  // Checkboxes: only trust them when the form that carries them was submitted (it always sends retentionDays).
  const settingsForm = form.get("_form") === "settings" || has("retentionDays");
  for (const key of ["waitlistEnabled", "requirePreorderLogin", "emailSignupConfirmation", "emailPreorderConfirmation", "emailShipReminder", "emailShipDateChange", "trackClicks", "defaultShowCountdown", "defaultShowProgress"]) data[key] = settingsForm ? flag(form.get(key)) : v[key];
  if (["buttonStyle", "buttonColor", "buttonTextColor", "progressColor", "countdownStyle"].some(has)) data.displayCustomized = true;
  return Object.keys(errors).length ? { errors } : { data };
}
