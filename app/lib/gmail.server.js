// Sending through Gmail / Google Workspace SMTP (smtp.gmail.com:465) with an app password.
//
// - Credentials never leave this module in clear text: errors are built from fixed messages (never the SMTP text, which
//   can contain addresses) and nothing is logged.
// - The daily cap is enforced with an atomic conditional update on EmailQuota, keyed by the *account* (normalised Gmail
//   address), so concurrent workers and several shops sharing one Gmail account share one budget.
// - Failures are classified: sign-in/configuration problems are permanent (and flagged for a Settings warning); network
//   and 4xx SMTP replies are transient (retried by the existing queue); an exhausted daily limit *defers* the delivery to
//   the next UTC day without using up an attempt.
import nodemailer from "nodemailer";
import { scrub } from "./secrets.server";

export const GMAIL_HOST = "smtp.gmail.com";
export const GMAIL_PORT = 465;
export const DEFAULT_DAILY_CAP = 400;
export const MAX_DAILY_CAP = 2000; // Google Workspace's documented per-day limit; personal Gmail is about 500

export const AUTH_MESSAGE = "Gmail rejected the sign-in. Create a new app password for this Gmail account and save it in Settings.";
export const AUTH_FLAG = "AUTH_FAILED";

/** The account a quota belongs to. Gmail ignores dots and +tags in the name part, and googlemail.com is gmail.com. */
export function normalizeAccount(address) {
  const [local = "", domainRaw = ""] = String(address ?? "").trim().toLowerCase().split("@");
  const domain = domainRaw === "googlemail.com" ? "gmail.com" : domainRaw;
  const name = domain === "gmail.com" ? local.split("+")[0].replace(/\./g, "") : local;
  return `${name}@${domain}`;
}

export const dayKey = (d) => d.toISOString().slice(0, 10);
export const nextDayStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));

/**
 * Takes one send from today's budget. Atomic: the increment only applies while count < cap, so any number of
 * concurrent callers together can never take more than `cap`. Returns { ok } or { ok: false, deferUntil }.
 */
export async function reserveSlot(db, { account, cap, now = new Date() }) {
  const day = dayKey(now);
  for (let i = 0; i < 8; i++) {
    const done = await db.emailQuota.updateMany({ where: { account, day, count: { lt: cap } }, data: { count: { increment: 1 } } });
    if (done.count === 1) return { ok: true };
    const row = await db.emailQuota.findUnique({ where: { account_day: { account, day } }, select: { count: true } });
    if (row) {
      // The cap is only reached when the stored count says so. A row that appeared (or moved) between the increment above
      // and this read still has room: take a slot the normal way instead of wrongly deferring.
      if (row.count >= cap) return { ok: false, deferUntil: nextDayStart(now) };
      continue;
    }
    try {
      await db.emailQuota.create({ data: { account, day, count: 1 } }); // first send of the day (cap >= 1)
      return { ok: true };
    } catch (e) {
      if (e?.code !== "P2002") throw e; // someone else created the row: loop and take a slot the normal way
    }
  }
  return { ok: false, deferUntil: nextDayStart(now) };
}

/** Gives a slot back when the message was not sent. */
export function releaseSlot(db, { account, now = new Date() }) {
  return db.emailQuota.updateMany({ where: { account, day: dayKey(now), count: { gt: 0 } }, data: { count: { decrement: 1 } } });
}

/** Gmail itself said the day's limit is reached: make today's budget read as used up. */
async function markExhausted(db, { account, cap, now }) {
  const day = dayKey(now);
  const done = await db.emailQuota.updateMany({ where: { account, day, count: { lt: cap } }, data: { count: cap } });
  if (done.count === 0) {
    try { await db.emailQuota.create({ data: { account, day, count: cap } }); } catch (e) { if (e?.code !== "P2002") throw e; }
  }
}

export async function usageToday(db, { address, now = new Date() }) {
  const row = await db.emailQuota.findUnique({ where: { account_day: { account: normalizeAccount(address), day: dayKey(now) } }, select: { count: true } });
  return row?.count ?? 0;
}

const NETWORK_CODES = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNRESET", "ECONNREFUSED", "EDNS", "ENOTFOUND", "EAI_AGAIN", "ETLS", "EPROTOCOL"]);
const LIMIT_RE = /daily user sending|5\.4\.5|4\.5\.3|sending limit|quota exceeded|too many (messages|recipients)/i;

/** Maps an SMTP/network error to { kind, message } with a fixed message (never the server text). */
export function classifySmtpError(error) {
  const code = Number(error?.responseCode) || null;
  const response = String(error?.response ?? "");
  if (error?.code === "EAUTH" || code === 535 || code === 534 || (code === 530 && /5\.7\.0|authentication/i.test(response))) return { kind: "auth", message: AUTH_MESSAGE };
  if (LIMIT_RE.test(response)) return { kind: "limit", message: "Gmail's daily sending limit was reached. The email stays queued and is sent after the limit resets." };
  if (code && code >= 500) return { kind: "permanent", message: `Gmail rejected the message (SMTP ${code}).` };
  if (code && code >= 400) return { kind: "transient", message: `Gmail temporarily refused the message (SMTP ${code}). It will be retried.` };
  if (NETWORK_CODES.has(error?.code)) return { kind: "transient", message: "Gmail could not be reached. It will be retried." };
  return { kind: "transient", message: "The email could not be sent. It will be retried." };
}

const fail = (message, extra) => Object.assign(new Error(message), extra);

/**
 * The Gmail sender for one shop. Same contract as the other senders: send() resolves { id } once Gmail ACCEPTED the
 * message and throws an Error with `.retryable` otherwise; `.deferUntil` marks "try again after this time, do not
 * count an attempt" (daily limit).
 */
export function createGmailMailer({ db, shop, address, password, cap = DEFAULT_DAILY_CAP, now = () => new Date(), transportFactory = nodemailer.createTransport }) {
  const account = normalizeAccount(address);
  const secrets = [password];
  let transporter = null;
  let authFailed = false;
  const transport = () => (transporter ??= transportFactory({
    host: GMAIL_HOST, port: GMAIL_PORT, secure: true, auth: { user: address, pass: password },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000, logger: false, debug: false,
  }));
  const authError = () => fail(AUTH_MESSAGE, { retryable: false, authFailure: true });
  // Until one send has succeeded, sends go one at a time: if the sign-in is bad, only ONE login attempt is made
  // (the queue sends in parallel, and repeated bad logins can lock a Gmail account).
  let proven = false;
  let chain = Promise.resolve();

  const sendNow = async ({ to, subject, html, text, fromName, replyTo }) => {
    if (authFailed) throw authError();
    const at = now();
    const slot = await reserveSlot(db, { account, cap, now: at });
    if (!slot.ok) throw fail("Daily send limit reached. The email stays queued and is sent after the limit resets.", { retryable: true, deferUntil: slot.deferUntil, quota: true });
    let info;
    try {
      const name = fromName ? String(fromName).replace(/[\r\n"<>]/g, "") : "";
      info = await transport().sendMail({ from: name ? `"${name}" <${address}>` : address, to, subject, text, html, ...(replyTo ? { replyTo } : {}) });
    } catch (error) {
      await releaseSlot(db, { account, now: at }); // not sent: the slot is not used
      const c = classifySmtpError(error);
      if (c.kind === "auth") {
        authFailed = true;
        await db.shopSettings.updateMany({ where: { shop }, data: { gmailAuthError: AUTH_FLAG, gmailAuthErrorAt: at } });
        throw authError();
      }
      if (c.kind === "limit") {
        await markExhausted(db, { account, cap, now: at });
        throw fail(c.message, { retryable: true, deferUntil: nextDayStart(at), quota: true });
      }
      throw fail(scrub(c.message, secrets), { retryable: c.kind === "transient" });
    }
    if (!info?.accepted?.length) {
      await releaseSlot(db, { account, now: at });
      throw fail("Gmail did not accept the recipient address.", { retryable: false });
    }
    proven = true;
    return { id: String(info.messageId ?? "").slice(0, 100) || null };
  };

  return {
    provider: "gmail", channel: "smtp", account,
    send(message) {
      if (proven) return sendNow(message);
      const run = chain.then(() => sendNow(message));
      chain = run.catch(() => {});
      return run;
    },
    /** Checks the credentials without sending: { ok } | { ok: false, kind: "auth" | "unreachable" }. */
    async verify() {
      try {
        await transport().verify();
        return { ok: true };
      } catch (error) {
        return { ok: false, kind: classifySmtpError(error).kind === "auth" ? "auth" : "unreachable" };
      }
    },
  };
}
