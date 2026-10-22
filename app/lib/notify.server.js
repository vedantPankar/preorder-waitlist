import { randomBytes } from "node:crypto";
import { escapeHtml, SKIP_NO_CUSTOMER } from "./mailer.server";

export const MAX_ATTEMPTS = 3;
export const STALE_SENDING_MS = 10 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000]; // after failed attempt 1, 2, 3
const DEFAULT_CONCURRENCY = 5;
const MAX_CONSECUTIVE_FAILURES = 10;

export const batchSize = (env = process.env) => {
  const n = Number(env.NOTIFY_BATCH_SIZE);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 100;
};
export const backoffMs = (attempts) => BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];

export function buildEmail({ shop, variant, settings, delivery }) {
  const name = variant.variantTitle ? `${variant.productTitle} (${variant.variantTitle})` : variant.productTitle;
  const direct = `/products/${encodeURIComponent(variant.productHandle ?? "")}?variant=${variant.variantId}`;
  // Click tracking is opt-in: only then do links go through the app (/apps/waitlist/r/<token>).
  const path = settings?.trackClicks && delivery?.trackingToken ? `/apps/waitlist/r/${delivery.trackingToken}` : direct;
  const url = `https://${shop}${path}`;
  const subject = (settings?.subject || "{{product}} is back in stock").replace(/\{\{\s*product\s*\}\}/g, name).slice(0, 200);
  const tracking = settings?.trackClicks ? " The link in this email counts clicks so the store can see whether notifications are useful." : "";
  return {
    subject,
    context: { shop, productTitle: variant.productTitle, variantTitle: variant.variantTitle ?? "", productUrl: url },
    text: `Good news! ${name} is back in stock.\n\nGet it here: ${url}\n\nYou received this one-time email because you asked to be notified. We will not email you again about this product unless you sign up again.${tracking}`,
    html: `<p>Good news! <strong>${escapeHtml(name)}</strong> is back in stock.</p><p><a href="${escapeHtml(url)}">View the product</a></p><p style="color:#6d7175;font-size:12px">You received this one-time email because you asked to be notified. We will not email you again about this product unless you sign up again.${escapeHtml(tracking)}</p>`,
  };
}

async function recordProviderState(db, shop, error) {
  await db.shopSettings.upsert({
    where: { shop },
    create: { shop, lastNotifyError: error, lastNotifyErrorAt: error ? new Date() : null },
    update: { lastNotifyError: error, lastNotifyErrorAt: error ? new Date() : null },
  });
}

const newToken = () => randomBytes(18).toString("base64url");
const openKey = (shop, variantId) => `${shop}:${variantId}`;

/** Finds or creates the single OPEN restock event for a variant (race-safe via the unique openKey). */
async function openEvent(db, { shop, variant }) {
  const key = openKey(shop, variant.variantId);
  const existing = await db.restockEvent.findUnique({ where: { openKey: key } });
  if (existing) return existing;
  try {
    return await db.restockEvent.create({
      data: {
        shop, variantId: variant.variantId, productId: variant.productId, productTitle: variant.productTitle,
        variantTitle: variant.variantTitle ?? null, inventoryQuantity: variant.inventoryQuantity, openKey: key,
      },
    });
  } catch (e) {
    if (e?.code !== "P2002") throw e;
    // null: the run that won the race has already drained and closed the event (closing clears the key).
    return db.restockEvent.findUnique({ where: { openKey: key } });
  }
}

/**
 * Moves up to `limit` waiting entries of an in-stock variant into the durable queue.
 * Each entry flips ACTIVE -> SENDING and gets its delivery row in ONE transaction, so a
 * crash can never leave an entry that is neither waiting nor queued. The unique
 * (event, entry) key makes a second enqueue (duplicate webhook, concurrent run) a no-op.
 */
export async function enqueueRestock(db, { shop, variant, limit = 100, now = new Date() }) {
  if (!(variant.inventoryQuantity > 0)) return { queued: 0, eventId: null };
  // Entries claimed by the previous (pre-queue) implementation and abandoned: make them waiting again.
  await db.waitlistEntry.updateMany({
    where: { shop, variantId: variant.variantId, status: "SENDING", sendingSince: { lt: new Date(now.getTime() - STALE_SENDING_MS) } },
    data: { status: "ACTIVE", sendingSince: null },
  });
  const waiting = await db.waitlistEntry.findMany({
    where: { shop, variantId: variant.variantId, status: "ACTIVE" },
    select: { id: true, productHandle: true }, orderBy: { signedUpAt: "asc" }, take: limit,
  });
  if (!waiting.length) return { queued: 0, eventId: null };
  const event = await openEvent(db, { shop, variant });
  // Closed by a concurrent run between our failed create and re-read: every entry we saw was already taken by it.
  if (!event) return { queued: 0, eventId: null };
  let queued = 0;
  for (const entry of waiting) {
    // One batch: the delivery row (unique per event+entry, so a duplicate rolls the whole batch
    // back) and the ACTIVE -> SENDING flip. If the entry stopped being ACTIVE meanwhile (removed),
    // the delivery is skipped at send time. Batches avoid interactive-transaction lock timeouts.
    try {
      await db.$transaction([
        db.notificationDelivery.create({
          data: {
            shop, eventId: event.id, entryId: entry.id, variantId: variant.variantId, trackingToken: newToken(),
            targetPath: `/products/${encodeURIComponent(variant.productHandle ?? entry.productHandle ?? "")}?variant=${variant.variantId}`,
            nextAttemptAt: now, queuedAt: now,
          },
        }),
        db.waitlistEntry.updateMany({ where: { id: entry.id, shop, status: "ACTIVE" }, data: { status: "SENDING", sendingSince: null } }),
      ]);
      queued++;
    } catch (e) {
      if (e?.code !== "P2002") throw e; // already queued for this event: fine
    }
  }
  return { queued, eventId: event.id };
}

/** Closes events whose deliveries are all finished. */
export async function closeDrainedEvents(db, shop, now = new Date()) {
  const open = await db.restockEvent.findMany({ where: { shop, status: "OPEN" }, select: { id: true, variantId: true } });
  for (const ev of open) {
    const [active, waiting] = await Promise.all([
      db.notificationDelivery.count({ where: { shop, eventId: ev.id, status: { in: ["QUEUED", "SENDING"] } } }),
      db.waitlistEntry.count({ where: { shop, variantId: ev.variantId, status: "ACTIVE" } }),
    ]);
    if (!active && !waiting) await db.restockEvent.updateMany({ where: { id: ev.id, shop, status: "OPEN" }, data: { status: "COMPLETE", openKey: null, completedAt: now } });
  }
}

const due = (shop, now, variantId) => ({
  shop, kind: "RESTOCK", ...(variantId ? { variantId } : {}),
  OR: [{ status: "QUEUED", nextAttemptAt: { lte: now } }, { status: "SENDING", lockedUntil: { lt: now } }],
});

export function countQueued(db, shop, variantId) {
  return db.notificationDelivery.count({ where: { shop, kind: "RESTOCK", ...(variantId ? { variantId } : {}), status: { in: ["QUEUED", "SENDING"] } } });
}

/**
 * Sends due deliveries in batches of `batch` until the time budget is spent.
 *
 * - A delivery is claimed with a conditional update (lease), so concurrent workers
 *   and restarts can never send it twice at the same time. A crashed worker's lease
 *   expires and the delivery is picked up again (at-least-once; Resend also gets an
 *   idempotency key).
 * - A delivery is ACCEPTED only after the provider confirmed the send.
 * - Transient failures (network, 429, 5xx) are re-queued with exponential backoff;
 *   permanent ones (other 4xx) and exhausted retries end FAILED for a manual retry.
 * - `stockCheck(variantId)` re-verifies stock right before sending; a variant that
 *   went out of stock again simply waits (nothing is dropped).
 */
export async function processQueue(db, { shop, mailer, stockCheck, variantId, now = new Date(), budgetMs = 4000, concurrency = DEFAULT_CONCURRENCY, batch = batchSize() }) {
  const summary = { sent: 0, failed: 0, retried: 0, skipped: 0, deferred: 0, waitingForStock: 0, aborted: false };
  if (!mailer) return summary;
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  const deadline = Date.now() + budgetMs;
  const stock = new Map();
  const variantInStock = async (id) => {
    if (!stock.has(id)) stock.set(id, await stockCheck(id));
    return stock.get(id);
  };
  let consecutiveFailures = 0;
  let quotaBlocked = false; // the sending account's daily limit is used up: leave the rest queued

  const sendOne = async (d) => {
    if (quotaBlocked) return;
    const v = await variantInStock(d.variantId);
    if (!v || !(v.inventoryQuantity > 0)) return void summary.waitingForStock++;
    const claimed = await db.notificationDelivery.updateMany({
      where: { id: d.id, shop, OR: [{ status: "QUEUED", nextAttemptAt: { lte: now } }, { status: "SENDING", lockedUntil: { lt: now } }] },
      data: { status: "SENDING", lockedUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return void summary.skipped++;
    const delivery = await db.notificationDelivery.findFirst({ where: { id: d.id, shop } });
    const entry = await db.waitlistEntry.findFirst({ where: { id: delivery.entryId, shop } });
    if (!entry || entry.status !== "SENDING") {
      await db.notificationDelivery.updateMany({ where: { id: d.id, shop }, data: { status: "SKIPPED", lockedUntil: null, lastError: "entry_no_longer_waiting" } });
      return void summary.skipped++;
    }
    try {
      const result = await mailer.send({
        to: entry.email,
        ...buildEmail({ shop, variant: v, settings, delivery }),
        fromName: settings?.fromName || undefined,
        replyTo: settings?.replyToEmail || undefined,
        idempotencyKey: delivery.id,
      });
      await db.$transaction([
        db.notificationDelivery.updateMany({ where: { id: d.id, shop }, data: { status: "ACCEPTED", acceptedAt: new Date(), lockedUntil: null, lastError: null, providerMessageId: result?.id ?? null } }),
        db.notificationAttempt.create({ data: { shop, deliveryId: d.id, attemptNo: delivery.attempts, outcome: "ACCEPTED" } }),
        db.waitlistEntry.updateMany({ where: { id: entry.id, shop }, data: { status: "NOTIFIED", notifiedAt: new Date(), sendingSince: null, lastError: null, attempts: delivery.attempts } }),
      ]);
      summary.sent++;
      consecutiveFailures = 0;
    } catch (error) {
      if (error?.deferUntil) {
        // Daily send limit: not a failure and not an attempt. The delivery (and its waiting entry) just waits for the next window.
        quotaBlocked = true;
        await db.notificationDelivery.updateMany({ where: { id: d.id, shop }, data: { status: "QUEUED", lockedUntil: null, attempts: { decrement: 1 }, nextAttemptAt: error.deferUntil, lastError: String(error.message).slice(0, 200) } });
        return void summary.deferred++;
      }
      if (error?.skip) {
        // Not a Shopify customer: Flow cannot email them. Recorded as skipped (not retryable by the failed-retry button).
        await db.$transaction([
          db.notificationAttempt.create({ data: { shop, deliveryId: d.id, attemptNo: delivery.attempts, outcome: "SKIPPED", error: SKIP_NO_CUSTOMER } }),
          db.notificationDelivery.updateMany({ where: { id: d.id, shop }, data: { status: "SKIPPED", lockedUntil: null, lastError: SKIP_NO_CUSTOMER } }),
          db.waitlistEntry.updateMany({ where: { id: entry.id, shop }, data: { status: "FAILED", lastError: SKIP_NO_CUSTOMER, attempts: delivery.attempts } }),
        ]);
        return void summary.skipped++;
      }
      const retryable = error?.retryable !== false && !(error?.status >= 400 && error.status < 500 && error.status !== 429 && error.status !== 408);
      const exhausted = delivery.attempts >= MAX_ATTEMPTS;
      const message = String(error?.message ?? "send_failed").slice(0, 200);
      const final = !retryable || exhausted;
      await db.$transaction([
        db.notificationAttempt.create({ data: { shop, deliveryId: d.id, attemptNo: delivery.attempts, outcome: "FAILED", httpStatus: error?.status ?? null, retryable, error: message } }),
        db.notificationDelivery.updateMany({
          where: { id: d.id, shop },
          data: final
            ? { status: "FAILED", lockedUntil: null, lastError: message }
            : { status: "QUEUED", lockedUntil: null, lastError: message, nextAttemptAt: new Date(now.getTime() + backoffMs(delivery.attempts)) },
        }),
        ...(final ? [db.waitlistEntry.updateMany({ where: { id: entry.id, shop }, data: { status: "FAILED", lastError: message, attempts: delivery.attempts } })] : []),
      ]);
      if (final) summary.failed++; else summary.retried++;
      consecutiveFailures++;
    }
  };

  while (Date.now() < deadline && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
    const rows = await db.notificationDelivery.findMany({ where: due(shop, now, variantId), orderBy: { queuedAt: "asc" }, take: batch });
    if (!rows.length) break;
    const before = summary.sent + summary.failed + summary.retried + summary.skipped;
    for (let i = 0; i < rows.length && Date.now() < deadline && consecutiveFailures < MAX_CONSECUTIVE_FAILURES; i += concurrency) {
      await Promise.all(rows.slice(i, i + concurrency).map(sendOne));
    }
    // Only rows waiting for stock (no progress) -> stop instead of spinning.
    if (summary.sent + summary.failed + summary.retried + summary.skipped === before) break;
  }
  summary.aborted = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
  await closeDrainedEvents(db, shop, now);
  return summary;
}

/**
 * Sends back-in-stock emails for a variant that now has stock: queue the waiting
 * entries, then process the queue, repeating until nobody is left or the budget is
 * spent. The result reports `remaining` so callers can continue; nothing is dropped.
 * Entries stay ACTIVE (waiting) when no mailer is configured, because nothing was sent.
 */
export async function notifyVariant(db, { shop, variant, mailer, now = new Date(), budgetMs = 4000, concurrency = DEFAULT_CONCURRENCY, batch = batchSize() }) {
  const summary = { operational: Boolean(mailer), sent: 0, failed: 0, skipped: 0, remaining: 0, aborted: false };
  if (!(variant.inventoryQuantity > 0)) return { ...summary, reason: "not_in_stock" };

  if (!mailer) {
    const pending = (await db.waitlistEntry.count({ where: { shop, variantId: variant.variantId, status: "ACTIVE" } })) + (await countQueued(db, shop, variant.variantId));
    if (pending) await recordProviderState(db, shop, "EMAIL_NOT_CONFIGURED");
    return { ...summary, remaining: pending, reason: pending ? "email_not_configured" : undefined };
  }

  const deadline = Date.now() + budgetMs;
  let retried = 0;
  while (Date.now() < deadline) {
    // Small chunks: a tight time budget (webhook) still makes progress instead of only enqueueing.
    const { queued } = await enqueueRestock(db, { shop, variant, limit: Math.min(batch, Math.max(concurrency * 2, 10)), now });
    const r = await processQueue(db, { shop, mailer, variantId: variant.variantId, stockCheck: async () => variant, now, budgetMs: Math.max(1, deadline - Date.now()), concurrency, batch });
    summary.sent += r.sent; summary.failed += r.failed; summary.skipped += r.skipped; retried += r.retried;
    summary.aborted = summary.aborted || r.aborted;
    if (r.aborted || (queued === 0 && r.sent + r.failed + r.skipped + r.retried === 0)) break;
  }
  summary.remaining = (await db.waitlistEntry.count({ where: { shop, variantId: variant.variantId, status: "ACTIVE" } })) + (await countQueued(db, shop, variant.variantId));
  summary.retrying = retried;
  await recordProviderState(db, shop, summary.failed || retried ? "SEND_FAILURES" : null);
  return summary;
}

/** Merchant action: failed deliveries go back to the queue (they are sent on the next run). */
export async function retryFailedDeliveries(db, shop, { entryIds, now = new Date() } = {}) {
  const where = { shop, status: "FAILED", ...(entryIds ? { entryId: { in: entryIds } } : {}) };
  const failed = await db.notificationDelivery.findMany({ where, select: { id: true, entryId: true, eventId: true }, take: 1000 });
  let count = 0;
  for (const d of failed) {
    const [moved] = await db.$transaction([
      db.notificationDelivery.updateMany({ where: { id: d.id, shop, status: "FAILED" }, data: { status: "QUEUED", attempts: 0, lastError: null, nextAttemptAt: now, lockedUntil: null } }),
      db.waitlistEntry.updateMany({ where: { id: d.entryId, shop, status: "FAILED" }, data: { status: "SENDING", lastError: null, attempts: 0 } }),
    ]);
    if (moved.count === 1) count++;
  }
  return count;
}

/** Counts a click on a tracked email link and returns where to send the customer (null if unknown). */
export async function recordClick(db, shop, token) {
  if (typeof token !== "string" || token.length < 10 || token.length > 64) return null;
  const delivery = await db.notificationDelivery.findFirst({ where: { shop, trackingToken: token } });
  if (!delivery) return null;
  await db.notificationDelivery.updateMany({ where: { id: delivery.id, shop }, data: { clickCount: { increment: 1 }, clickedAt: delivery.clickedAt ?? new Date() } });
  return delivery.targetPath;
}

export async function notificationMetrics(db, shop, { from, to }) {
  const where = { shop, queuedAt: { gte: from, lt: to } };
  const [byStatus, clicked, settings] = await Promise.all([
    db.notificationDelivery.groupBy({ by: ["status"], where, _count: { _all: true } }),
    db.notificationDelivery.count({ where: { ...where, clickedAt: { not: null } } }),
    db.shopSettings.findUnique({ where: { shop } }),
  ]);
  const c = Object.fromEntries(byStatus.map((g) => [g.status, g._count._all]));
  const queued = Object.values(c).reduce((a, b) => a + b, 0);
  const accepted = c.ACCEPTED ?? 0;
  return {
    queued, accepted, failed: c.FAILED ?? 0, pending: (c.QUEUED ?? 0) + (c.SENDING ?? 0), skipped: c.SKIPPED ?? 0,
    clicked, clickTrackingEnabled: Boolean(settings?.trackClicks),
    clickRate: accepted > 0 && settings?.trackClicks ? Math.round((clicked / accepted) * 1000) / 10 : null,
    // Not measurable with the data this app has: say so instead of showing a made-up number.
    delivered: null, purchased: null,
  };
}
