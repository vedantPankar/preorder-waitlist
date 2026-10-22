// The one place that decides which sender a shop uses.
//
// Precedence: (1) the shop's own Gmail settings; (2) otherwise the environment (EMAIL_PROVIDER: resend, postmark,
// shopify_flow). A shop that configured Gmail but whose Gmail is unusable (sign-in rejected, or the saved password can
// no longer be decrypted) gets NO sender: nothing is sent and nothing is lost, rather than quietly switching to another
// sender the merchant did not choose.
import { createGmailMailer, usageToday, DEFAULT_DAILY_CAP } from "./gmail.server";
import { getMailer, getMailerStatus } from "./mailer.server";
import { decryptSecret, secretsAvailable } from "./secrets.server";

/** none | ok | auth_failed | unreadable (key changed or no key on this server). Never includes the password. */
export function gmailState(settings, { shop, env = process.env } = {}) {
  if (!settings?.gmailAddress || !settings?.gmailPasswordEnc) return { state: "none" };
  const password = decryptSecret(settings.gmailPasswordEnc, { shop, env });
  if (password === null) return { state: "unreadable" };
  if (settings.gmailAuthError) return { state: "auth_failed", password };
  return { state: "ok", password };
}

export async function getShopMailer(db, shop, { admin = null, env = process.env, fetchImpl = fetch, transportFactory, now } = {}) {
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  const g = gmailState(settings, { shop, env });
  if (g.state === "none") return getMailer(env, fetchImpl, { admin });
  if (g.state !== "ok") return null;
  return createGmailMailer({
    db, shop, address: settings.gmailAddress, password: g.password, cap: settings.dailySendCap ?? DEFAULT_DAILY_CAP,
    ...(transportFactory ? { transportFactory } : {}), ...(now ? { now } : {}),
  });
}

/** What the Settings and activity pages show. Secret-free by construction. */
export async function getEmailStatus(db, shop, { env = process.env, now = new Date() } = {}) {
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  const g = gmailState(settings, { shop, env });
  const base = getMailerStatus(env);
  if (g.state === "none") return { ...base, gmail: { state: "none", address: "", used: 0, cap: settings?.dailySendCap ?? DEFAULT_DAILY_CAP, keyAvailable: secretsAvailable(env) } };
  const gmail = {
    state: g.state, address: settings.gmailAddress, cap: settings.dailySendCap ?? DEFAULT_DAILY_CAP, keyAvailable: secretsAvailable(env),
    used: await usageToday(db, { address: settings.gmailAddress, now }),
  };
  if (g.state === "ok") return { configured: true, provider: "gmail", channel: "smtp", problems: [], vars: base.vars, gmail };
  const problems = [g.state === "auth_failed" ? "Gmail rejected the sign-in. Save a new app password in Settings." : "The saved Gmail app password cannot be read (the server's encryption key changed). Enter it again in Settings."];
  return { configured: false, provider: "gmail", channel: "smtp", problems, vars: base.vars, gmail };
}

/** Whether any shop sends through Gmail (decides whether the scheduler has anything to do without env config). */
export async function anyGmailShop(db) {
  return (await db.shopSettings.count({ where: { gmailPasswordEnc: { not: null } } })) > 0;
}
