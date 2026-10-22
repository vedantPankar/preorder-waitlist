import { cleanText, isValidEmail, normalizeEmail } from "./validation.server";
import { retryFailedDeliveries } from "./notify.server";

export { MAX_ATTEMPTS, STALE_SENDING_MS } from "./notify.server";
const REACTIVATABLE = ["NOTIFIED", "FAILED", "REMOVED"];

export class WaitlistError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Adds a signup. `variant` must come from Shopify (already verified), never
 * straight from the request body. Idempotent per (shop, email, variant).
 */
export async function addSignup(db, { shop, email, variant }) {
  if (!isValidEmail(email)) throw new WaitlistError("invalid_email", "Please enter a valid email address.");
  const normalized = normalizeEmail(email);
  const data = {
    productId: variant.productId,
    productTitle: cleanText(variant.productTitle, 255),
    variantTitle: variant.variantTitle ? cleanText(variant.variantTitle, 255) : null,
    productHandle: variant.productHandle ?? null,
    optionsJson: variant.options?.length ? JSON.stringify(variant.options).slice(0, 1000) : null,
  };

  try {
    const row = await db.waitlistEntry.create({
      data: { shop, email: normalized, variantId: variant.variantId, ...data },
    });
    return { result: "created", entry: { id: row.id, signedUpAt: row.signedUpAt } };
  } catch (error) {
    if (error?.code !== "P2002") throw error;
  }

  const reactivated = await db.waitlistEntry.updateMany({
    where: { shop, email: normalized, variantId: variant.variantId, status: { in: REACTIVATABLE } },
    data: { ...data, status: "ACTIVE", attempts: 0, lastError: null, sendingSince: null, notifiedAt: null, signedUpAt: new Date() },
  });
  if (!reactivated.count) return { result: "duplicate" };
  const row = await db.waitlistEntry.findFirst({ where: { shop, email: normalized, variantId: variant.variantId }, select: { id: true, signedUpAt: true } });
  return { result: "created", entry: row };
}

export async function listEntries(db, shop, { search = "", status = "", product = "", variant = "", from = null, to = null, page = 1, pageSize = 25 } = {}) {
  const where = { shop };
  if (status) where.status = status === "WAITING" ? { in: ["ACTIVE", "SENDING"] } : status;
  const p = cleanText(product, 100);
  if (p) where.productTitle = { contains: p };
  const v = cleanText(variant, 100);
  if (v) where.variantTitle = { contains: v };
  if (from instanceof Date || to instanceof Date) where.signedUpAt = { ...(from instanceof Date ? { gte: from } : {}), ...(to instanceof Date ? { lt: to } : {}) };
  const term = cleanText(search, 100).toLowerCase();
  if (term) {
    where.OR = [{ email: { contains: term } }, { productTitle: { contains: term } }, { variantTitle: { contains: term } }];
  }
  const [entries, total] = await Promise.all([
    db.waitlistEntry.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    db.waitlistEntry.count({ where }),
  ]);
  return { entries, total, pageSize };
}

export async function waitlistCounts(db, shop) {
  const groups = await db.waitlistEntry.groupBy({ by: ["status"], where: { shop }, _count: { _all: true } });
  const counts = { ACTIVE: 0, SENDING: 0, NOTIFIED: 0, FAILED: 0, REMOVED: 0 };
  for (const g of groups) counts[g.status] = g._count._all;
  return counts;
}

/** Soft-removes entries (keeps the dedupe row). Scoped to the shop. */
export async function removeEntries(db, shop, ids) {
  const { count } = await db.waitlistEntry.updateMany({
    where: { shop, id: { in: ids }, status: { not: "SENDING" } },
    data: { status: "REMOVED" },
  });
  return count;
}

/** Permanently deletes entries (GDPR / merchant request). Scoped to the shop. */
export async function deleteEntries(db, shop, ids) {
  const { count } = await db.waitlistEntry.deleteMany({ where: { shop, id: { in: ids } } });
  return count;
}

/**
 * Retries failed entries. Entries with a failed delivery go back into the notification
 * queue (sent on the next run, once the variant is in stock); legacy failed entries
 * without a delivery become waiting again so the next restock reaches them.
 */
export async function retryFailed(db, shop, ids) {
  const requeued = await retryFailedDeliveries(db, shop, { entryIds: ids });
  const { count } = await db.waitlistEntry.updateMany({
    where: { shop, id: { in: ids }, status: "FAILED" },
    data: { status: "ACTIVE", attempts: 0, lastError: null },
  });
  return requeued + count;
}

export async function purgeExpired(db, shop, retentionDays, now = new Date()) {
  if (!retentionDays || retentionDays < 1) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * 86400000);
  const { count } = await db.waitlistEntry.deleteMany({
    where: { shop, status: { in: ["NOTIFIED", "REMOVED"] }, updatedAt: { lt: cutoff } },
  });
  // Operational records follow the same retention: finished deliveries (and their attempts),
  // completed restock events, and settled reservations (kept a week for debugging only).
  const finished = await db.notificationDelivery.findMany({
    where: { shop, status: { in: ["ACCEPTED", "FAILED", "SKIPPED"] }, updatedAt: { lt: cutoff } }, select: { id: true }, take: 1000,
  });
  if (finished.length) {
    const ids = finished.map((d) => d.id);
    await db.notificationAttempt.deleteMany({ where: { shop, deliveryId: { in: ids } } });
    await db.notificationDelivery.deleteMany({ where: { shop, id: { in: ids } } });
  }
  await db.restockEvent.deleteMany({ where: { shop, status: "COMPLETE", completedAt: { lt: cutoff } } });
  await db.preorderReservation.deleteMany({ where: { shop, status: { not: "HELD" }, resolvedAt: { lt: new Date(now.getTime() - 7 * 86400000) } } });
  return count;
}
