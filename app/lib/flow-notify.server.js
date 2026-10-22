// Shopify Flow emails other than back-in-stock: waitlist signup confirmation, pre-order ship-date reminder and
// ship-date change notice. They ride the same NotificationDelivery table, lease/retry rules and Notification
// activity page as restock emails, distinguished by `kind`. See docs/superpowers/specs/2026-10-22-flow-emails-design.md.
import { randomBytes } from "node:crypto";
import { SKIP_NO_CUSTOMER } from "./mailer.server";
import { buildShipEmail, buildSignupConfirmationEmail } from "./email-templates.server";
import { MAX_ATTEMPTS, backoffMs } from "./notify.server";
import { effectiveShipDate } from "./campaign.server";
import { fetchVariants } from "./shopify-data.server";

export const FLOW_KINDS = ["SIGNUP_CONFIRMATION", "SHIP_REMINDER", "SHIP_DATE_CHANGE"];
const LEASE_MS = 5 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const CONCURRENCY = 5;

const newToken = () => randomBytes(18).toString("base64url");
export const dateKey = (d) => d.toISOString().slice(0, 10);
const isUnique = (e) => e?.code === "P2002";
const dueWhere = (shop, now) => ({
  shop, kind: { in: FLOW_KINDS },
  OR: [{ status: "QUEUED", nextAttemptAt: { lte: now } }, { status: "SENDING", lockedUntil: { lt: now } }],
});

/** The new emails go out through Shopify Flow (a trigger) or the shop's own Gmail (a real email). Not Resend/Postmark. */
export const newKindsEnabled = (mailer) => mailer?.channel === "flow" || mailer?.channel === "smtp";
export const flowEnabled = newKindsEnabled; // kept for callers that predate Gmail sending

/** Queues the confirmation for a new (or renewed) waitlist signup. Idempotent per signup. */
export async function enqueueSignupConfirmation(db, { shop, entry, variant, now = new Date() }) {
  try {
    await db.notificationDelivery.create({
      data: {
        shop, kind: "SIGNUP_CONFIRMATION", eventId: `signup:${entry.id}:${entry.signedUpAt.getTime()}`, entryId: entry.id,
        variantId: variant.variantId, trackingToken: newToken(), nextAttemptAt: now, queuedAt: now,
        payload: JSON.stringify({ productTitle: variant.productTitle, variantTitle: variant.variantTitle ?? "", productHandle: variant.productHandle ?? "" }),
      },
    });
    return { queued: true };
  } catch (e) {
    if (!isUnique(e)) throw e;
    return { queued: false };
  }
}

export const SKIP_NO_EMAIL = "skipped: no email address";

/** `direct`: the channel sends a real email (Gmail), which needs the order's address; Flow needs a Shopify customer. */
function shipDelivery({ shop, kind, order, ship, handle, now, direct = false }) {
  const guest = direct ? !order.email : !order.customerId;
  return {
    shop, kind, eventId: `${kind === "SHIP_REMINDER" ? "reminder" : "change"}:${dateKey(ship)}`, entryId: order.id, variantId: order.variantId,
    trackingToken: newToken(), nextAttemptAt: now, queuedAt: now,
    status: guest ? "SKIPPED" : "QUEUED", lastError: guest ? (direct ? SKIP_NO_EMAIL : SKIP_NO_CUSTOMER) : null,
    payload: JSON.stringify({ customerId: order.customerId ?? null, productTitle: order.productTitle, variantTitle: order.variantTitle ?? "", orderName: order.orderName ?? "", shipDate: dateKey(ship), productHandle: handle ?? "" }),
  };
}

/**
 * Looks at every open pre-order line of the shop and queues, once each:
 *  - SHIP_DATE_CHANGE when the variant's current ship date differs from the date the customer was last told
 *    (lastShipDate is always brought up to date, even with the toggle off, so enabling it later never mails old changes);
 *  - SHIP_REMINDER when shipping is at most `shipReminderDays` away (and not yet past).
 * `resolveHandles(variantIds)` -> Map(variantId -> product handle), only called when something is about to be queued.
 */
export async function enqueueShipEmails(db, { shop, settings, resolveHandles = async () => new Map(), now = new Date(), direct = false }) {
  const out = { reminders: 0, changes: 0, skipped: 0 };
  const wantChange = settings?.emailShipDateChange === true, wantReminder = settings?.emailShipReminder === true;
  const days = Number.isInteger(settings?.shipReminderDays) ? settings.shipReminderDays : 3;
  const orders = await db.preorderOrder.findMany({ where: { shop, status: "OPEN" }, orderBy: { createdAt: "asc" }, take: 5000 });
  if (!orders.length) return out;
  const configs = await db.preorderConfig.findMany({ where: { shop, variantId: { in: [...new Set(orders.map((o) => o.variantId))] } } });
  const campaignIds = [...new Set(configs.map((c) => c.campaignId).filter(Boolean))];
  const campaigns = new Map((campaignIds.length ? await db.campaign.findMany({ where: { shop, id: { in: campaignIds } } }) : []).map((c) => [c.id, c]));
  const shipByVariant = new Map(configs.map((c) => [c.variantId, effectiveShipDate(c, c.campaignId ? campaigns.get(c.campaignId) : null)]));
  let handles = null;
  const handleFor = async (variantId) => {
    if (!handles) handles = await resolveHandles([...new Set(orders.map((o) => o.variantId))]);
    return handles.get(variantId) ?? "";
  };

  for (const order of orders) {
    const ship = shipByVariant.get(order.variantId);
    if (!ship) continue;
    let told = ship;
    if (!order.lastShipDate) await db.preorderOrder.updateMany({ where: { id: order.id, shop }, data: { lastShipDate: ship } });
    else if (order.lastShipDate.getTime() !== ship.getTime()) {
      if (wantChange) {
        try {
          await db.$transaction([
            db.notificationDelivery.create({ data: shipDelivery({ shop, kind: "SHIP_DATE_CHANGE", order, ship, handle: await handleFor(order.variantId), now, direct }) }),
            db.preorderOrder.updateMany({ where: { id: order.id, shop }, data: { lastShipDate: ship } }),
          ]);
          out[(direct ? order.email : order.customerId) ? "changes" : "skipped"]++;
        } catch (e) {
          if (!isUnique(e)) throw e;
          await db.preorderOrder.updateMany({ where: { id: order.id, shop }, data: { lastShipDate: ship } });
        }
      } else await db.preorderOrder.updateMany({ where: { id: order.id, shop }, data: { lastShipDate: ship } });
    }
    if (!wantReminder || !(ship.getTime() > now.getTime()) || ship.getTime() - days * DAY > now.getTime()) continue;
    // A change notice for this very date already told them; do not follow it with a reminder in the same breath.
    if (await db.notificationDelivery.findFirst({ where: { shop, entryId: order.id, eventId: `change:${dateKey(told)}` }, select: { id: true } })) continue;
    try {
      await db.notificationDelivery.create({ data: shipDelivery({ shop, kind: "SHIP_REMINDER", order, ship, handle: await handleFor(order.variantId), now, direct }) });
      out[(direct ? order.email : order.customerId) ? "reminders" : "skipped"]++;
    } catch (e) {
      if (!isUnique(e)) throw e;
    }
  }
  return out;
}

const productUrl = (shop, handle) => `https://${shop}${handle ? `/products/${encodeURIComponent(handle)}` : ""}`;

/** Sends due deliveries of the new kinds. Same claim/lease/retry rules as restock emails. Never touches waitlist entries. */
export async function processFlowDeliveries(db, { shop, mailer, now = new Date(), budgetMs = 4000, batch = 100 }) {
  const summary = { sent: 0, failed: 0, retried: 0, skipped: 0, deferred: 0 };
  if (!newKindsEnabled(mailer)) return summary;
  const deadline = Date.now() + budgetMs;
  const direct = mailer.channel === "smtp";
  const settings = direct ? await db.shopSettings.findUnique({ where: { shop } }) : null;
  let quotaBlocked = false; // the sending account's daily limit is used up: leave the rest queued

  const finish = (d, delivery, data, outcome, extra = {}) => db.$transaction([
    db.notificationDelivery.updateMany({ where: { id: d.id, shop }, data: { lockedUntil: null, ...data } }),
    db.notificationAttempt.create({ data: { shop, deliveryId: d.id, attemptNo: delivery.attempts, outcome, ...extra } }),
  ]);

  const sendOne = async (d) => {
    if (quotaBlocked) return;
    const claimed = await db.notificationDelivery.updateMany({
      where: { id: d.id, shop, OR: [{ status: "QUEUED", nextAttemptAt: { lte: now } }, { status: "SENDING", lockedUntil: { lt: now } }] },
      data: { status: "SENDING", lockedUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return void summary.skipped++;
    const delivery = await db.notificationDelivery.findFirst({ where: { id: d.id, shop } });
    let p = {};
    try { p = JSON.parse(delivery.payload || "{}"); } catch { /* treated as empty */ }
    let to = null;
    if (direct && delivery.kind !== "SIGNUP_CONFIRMATION") {
      const order = await db.preorderOrder.findFirst({ where: { id: delivery.entryId, shop }, select: { email: true, status: true } });
      if (!order?.email || order.status !== "OPEN") {
        await finish(d, delivery, { status: "SKIPPED", lastError: order?.email ? "order_no_longer_open" : SKIP_NO_EMAIL }, "SKIPPED");
        return void summary.skipped++;
      }
      to = order.email;
    }
    if (delivery.kind === "SIGNUP_CONFIRMATION") {
      const entry = await db.waitlistEntry.findFirst({ where: { id: delivery.entryId, shop } });
      if (!entry || entry.status === "REMOVED") {
        await finish(d, delivery, { status: "SKIPPED", lastError: "entry_no_longer_waiting" }, "SKIPPED");
        return void summary.skipped++;
      }
      to = entry.email;
    }
    const context = { shop, productTitle: p.productTitle, variantTitle: p.variantTitle, productUrl: productUrl(shop, p.productHandle), orderName: p.orderName, shipDate: p.shipDate };
    try {
      if (direct) {
        const body = delivery.kind === "SIGNUP_CONFIRMATION" ? buildSignupConfirmationEmail({ shop, ...p }) : buildShipEmail(delivery.kind, { shop, ...p });
        await mailer.send({ to, ...body, fromName: settings?.fromName || undefined, replyTo: settings?.replyToEmail || undefined, idempotencyKey: delivery.id });
      } else await mailer.send({ to, customerId: p.customerId, kind: delivery.kind, context });
      await finish(d, delivery, { status: "ACCEPTED", acceptedAt: new Date(), lastError: null }, "ACCEPTED");
      summary.sent++;
    } catch (error) {
      if (error?.deferUntil) {
        // Daily send limit: not a failure and not an attempt; wait for the next window.
        quotaBlocked = true;
        await db.notificationDelivery.updateMany({ where: { id: d.id, shop }, data: { status: "QUEUED", lockedUntil: null, attempts: { decrement: 1 }, nextAttemptAt: error.deferUntil, lastError: String(error.message).slice(0, 200) } });
        return void summary.deferred++;
      }
      if (error?.skip) {
        await finish(d, delivery, { status: "SKIPPED", lastError: SKIP_NO_CUSTOMER }, "SKIPPED", { error: SKIP_NO_CUSTOMER });
        return void summary.skipped++;
      }
      const retryable = error?.retryable !== false;
      const message = String(error?.message ?? "send_failed").slice(0, 200);
      const final = !retryable || delivery.attempts >= MAX_ATTEMPTS;
      await finish(d, delivery, final
        ? { status: "FAILED", lastError: message }
        : { status: "QUEUED", lastError: message, nextAttemptAt: new Date(now.getTime() + backoffMs(delivery.attempts)) },
      "FAILED", { retryable, error: message, httpStatus: error?.status ?? null });
      if (final) summary.failed++; else summary.retried++;
    }
  };

  while (Date.now() < deadline) {
    const rows = await db.notificationDelivery.findMany({ where: dueWhere(shop, now), orderBy: { queuedAt: "asc" }, take: batch });
    if (!rows.length) break;
    for (let i = 0; i < rows.length && Date.now() < deadline; i += CONCURRENCY) await Promise.all(rows.slice(i, i + CONCURRENCY).map(sendOne));
    if (rows.length < batch) break;
  }
  return summary;
}

/** One pass for a shop: queue what is due (honouring the Settings toggles), then send. */
export async function runFlowKinds(db, { shop, admin, mailer, now = new Date(), budgetMs = 4000 }) {
  const empty = { sent: 0, failed: 0, retried: 0, skipped: 0, deferred: 0 };
  if (!newKindsEnabled(mailer)) return empty;
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  const resolveHandles = async (ids) => new Map((await fetchVariants(admin, ids)).map((v) => [v.variantId, v.productHandle]));
  await enqueueShipEmails(db, { shop, settings, resolveHandles, now, direct: mailer.channel === "smtp" });
  return processFlowDeliveries(db, { shop, mailer, now, budgetMs });
}
