// The Gmail part of saving Settings: validates the app password, checks it with Gmail, encrypts it for storage.
// The password is read once here and is never returned, logged, or placed in an error message.
import { createGmailMailer, DEFAULT_DAILY_CAP } from "./gmail.server";
import { encryptSecret, secretsAvailable } from "./secrets.server";

// Google shows an app password as 16 letters in four groups ("abcd efgh ijkl mnop"); spaces are not part of it.
export const normalizeAppPassword = (raw) => String(raw ?? "").replace(/\s+/g, "");
const APP_PASSWORD = /^[a-z]{16}$/i;

/**
 * @returns {{ errors: object } | { data: object, warning?: string }} `data` is the Settings data to store (the
 * parsed form plus, when a new password was given, its ciphertext and a cleared sign-in warning).
 */
export async function applyGmailCredentials({ db, shop, current, data, password, env = process.env, transportFactory }) {
  const pw = normalizeAppPassword(password);
  const address = data.gmailAddress ?? null;
  const addressChanged = Boolean(address) && address !== (current?.gmailAddress ?? null);

  if (!pw) {
    if (addressChanged) return { errors: { gmailPassword: "Enter the app password for this Gmail address." } };
    return { data };
  }
  if (!address) return { errors: { gmailAddress: "Enter the Gmail address that the app password belongs to." } };
  if (!APP_PASSWORD.test(pw)) return { errors: { gmailPassword: "That is not an app password. It is 16 letters, created at myaccount.google.com/apppasswords (your normal Gmail password will not work)." } };
  if (!secretsAvailable(env)) return { errors: { gmailPassword: "This server has no encryption key, so the password cannot be stored safely. Set EMAIL_SETTINGS_KEY (or SHOPIFY_API_SECRET) and try again." } };

  const check = await createGmailMailer({ db, shop, address, password: pw, cap: data.dailySendCap ?? DEFAULT_DAILY_CAP, ...(transportFactory ? { transportFactory } : {}) }).verify();
  if (!check.ok && check.kind === "auth") return { errors: { gmailPassword: "Gmail rejected this app password. Check the address, and that 2-Step Verification is on and the password was created for this account." } };
  return {
    data: { ...data, gmailPasswordEnc: encryptSecret(pw, { shop, env }), gmailAuthError: null, gmailAuthErrorAt: null },
    warning: check.ok ? undefined : "Gmail could not be reached to check the password just now; it was saved and will be tried on the next send.",
  };
}
