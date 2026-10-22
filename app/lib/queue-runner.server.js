import { fetchVariants } from "./shopify-data.server";
import { batchSize, countQueued, enqueueRestock, processQueue } from "./notify.server";
import { runFlowKinds } from "./flow-notify.server";

/**
 * Drains everything that is due for one shop: newly waiting customers on in-stock
 * variants are queued, then due deliveries are sent. Safe to call at any time and
 * from several places at once (webhook continuation, the "Process queue" button, the
 * scheduler endpoint, the optional in-process worker): claims are conditional updates.
 */
export async function runQueueForShop({ db, shop, admin, mailer, now = new Date(), budgetMs = 8000, batch = batchSize() }) {
  const total = { sent: 0, failed: 0, retried: 0, skipped: 0, deferred: 0, waitingForStock: 0, queued: 0, remaining: 0, operational: Boolean(mailer) };
  if (!mailer) return total;
  const deadline = Date.now() + budgetMs;
  // Signup confirmations and ship-date emails (Flow only; a no-op for other providers).
  const flow = await runFlowKinds(db, { shop, admin, mailer, now, budgetMs: Math.max(1, budgetMs / 2) });
  for (const k of ["sent", "failed", "retried", "skipped", "deferred"]) total[k] += flow[k];
  const [waiting, queued] = await Promise.all([
    db.waitlistEntry.groupBy({ by: ["variantId"], where: { shop, status: "ACTIVE" } }),
    db.notificationDelivery.groupBy({ by: ["variantId"], where: { shop, status: { in: ["QUEUED", "SENDING"] } } }),
  ]);
  const ids = [...new Set([...waiting, ...queued].map((g) => g.variantId))];
  if (!ids.length) return total;
  const variants = new Map((await fetchVariants(admin, ids)).map((v) => [v.variantId, v]));
  const inStockIds = ids.filter((id) => variants.get(id)?.inventoryQuantity > 0);
  for (const id of ids) {
    const variant = variants.get(id);
    if (!variant || !(variant.inventoryQuantity > 0) || Date.now() >= deadline) continue;
    // chunked: queue some waiting entries, send, repeat
    for (let i = 0; i < 1000 && Date.now() < deadline; i++) {
      const q = await enqueueRestock(db, { shop, variant, limit: batch, now });
      total.queued += q.queued;
      const r = await processQueue(db, { shop, mailer, variantId: id, stockCheck: async () => variant, now, budgetMs: Math.max(1, deadline - Date.now()), batch });
      for (const k of ["sent", "failed", "retried", "skipped", "deferred", "waitingForStock"]) total[k] += r[k];
      if (r.aborted || (q.queued === 0 && r.sent + r.failed + r.retried + r.skipped === 0)) break;
    }
  }
  // Work that is ready to go but not finished: queued sends + waiting customers of in-stock variants.
  total.remaining = (await countQueued(db, shop)) + (inStockIds.length ? await db.waitlistEntry.count({ where: { shop, status: "ACTIVE", variantId: { in: inStockIds } } }) : 0);
  return total;
}

/** Shops that currently have something to send (used by the scheduler endpoint / worker). */
export async function shopsWithDueWork(db, now = new Date()) {
  const [a, b, c] = await Promise.all([
    db.notificationDelivery.groupBy({ by: ["shop"], where: { OR: [{ status: "QUEUED", nextAttemptAt: { lte: now } }, { status: "SENDING", lockedUntil: { lt: now } }] } }),
    db.waitlistEntry.groupBy({ by: ["shop"], where: { status: "ACTIVE" } }),
    db.preorderOrder.groupBy({ by: ["shop"], where: { status: "OPEN" } }), // ship-date reminders / change notices
  ]);
  return [...new Set([...a, ...b, ...c].map((g) => g.shop))];
}

export const queueDepth = (db, shop) => db.notificationDelivery.count({ where: { shop, status: { in: ["QUEUED", "SENDING"] } } });
