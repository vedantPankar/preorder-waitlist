import { notifyVariant } from "./notify.server";
import { syncPreorderStock } from "./preorder.server";
import { fetchVariantsForInventoryItem } from "./shopify-data.server";
import { runQueueForShop } from "./queue-runner.server";
import { normalizeEmail } from "./validation.server";
import { redactCustomerPreorders } from "./preorder-orders.server";

async function alreadyProcessed(db, shop, webhookId) {
  if (!webhookId) return false;
  return Boolean(await db.processedWebhook.findUnique({ where: { shop_webhookId: { shop, webhookId } } }));
}

async function markProcessed(db, shop, webhookId, topic) {
  if (!webhookId) return;
  try {
    await db.processedWebhook.create({ data: { shop, webhookId, topic } });
  } catch (e) {
    if (e?.code !== "P2002") throw e;
  }
}

/** Runs `work` once per webhook id. Throws propagate so Shopify retries. */
async function once(db, { shop, webhookId, topic }, work) {
  if (await alreadyProcessed(db, shop, webhookId)) return { duplicate: true };
  const result = await work();
  await markProcessed(db, shop, webhookId, topic);
  return result;
}

const running = new Set();

/** Default scheduler: fire-and-forget. Replace with a real queue on serverless hosts. */
function backgroundJob(fn) {
  setImmediate(() => fn().catch((e) => console.error("Background notification failed:", e?.message)));
}

export function handleInventoryLevelUpdate({ db, shop, webhookId, payload, admin, mailer, budgetMs = 4000, schedule = backgroundJob }) {
  return once(db, { shop, webhookId, topic: "inventory_levels/update" }, async () => {
    if (!admin || !payload?.inventory_item_id) return { skipped: true };
    const inStock = Number(payload.available) > 0;
    // Out-of-stock updates only matter for pre-order limits.
    if (!inStock && !(await db.preorderConfig.count({ where: { shop, enabled: true } }))) return { skipped: true };
    const variants = await fetchVariantsForInventoryItem(admin, payload.inventory_item_id);
    const closed = await syncPreorderStock(db, admin, shop, variants);
    const results = [];
    for (const variant of inStock ? variants : []) {
      // Cheap guard: only variants somebody is waiting for.
      const waiting = await db.waitlistEntry.count({
        where: { shop, variantId: variant.variantId, status: { in: ["ACTIVE", "FAILED", "SENDING"] } },
      });
      if (!waiting) continue;
      const result = await notifyVariant(db, { shop, variant, mailer, budgetMs });
      results.push(result);
      // Webhooks must answer quickly. Anything left over is drained in the
      // background; if the process dies, the Waitlist page's "Send pending
      // notifications" button (resumePending) picks it up. Nothing is dropped.
      const key = `${shop}:${variant.variantId}`;
      if (result.remaining > 0 && mailer && !result.aborted && !running.has(key)) {
        running.add(key);
        schedule(async () => {
          try {
            await notifyVariant(db, { shop, variant, mailer, budgetMs: 10 * 60 * 1000 });
          } finally {
            running.delete(key);
          }
        });
      }
    }
    return { results, closed };
  });
}

/** customers/redact: delete the customer's waitlist signups. */
export async function handleCustomerRedact({ db, shop, payload }) {
  // Pre-order lines are keyed by Shopify customer id (they hold no email).
  const orders = await redactCustomerPreorders(db, { shop, customerId: payload?.customer?.id, email: payload?.customer?.email });
  const email = normalizeEmail(payload?.customer?.email);
  if (!email) return { deleted: orders.deleted };
  const entries = await db.waitlistEntry.findMany({ where: { shop, email }, select: { id: true } });
  const entryIds = entries.map((e) => e.id);
  if (entryIds.length) {
    // Delivery rows hold no address but are linked to the entry; remove them (and their attempts) too.
    const deliveries = await db.notificationDelivery.findMany({ where: { shop, entryId: { in: entryIds } }, select: { id: true } });
    const deliveryIds = deliveries.map((d) => d.id);
    await db.notificationAttempt.deleteMany({ where: { shop, deliveryId: { in: deliveryIds } } });
    await db.notificationDelivery.deleteMany({ where: { shop, entryId: { in: entryIds } } });
  }
  const { count } = await db.waitlistEntry.deleteMany({ where: { shop, email } });
  return { deleted: count + orders.deleted };
}

/** shop/redact: delete everything stored for the shop. */
export async function handleShopRedact({ db, shop }) {
  const where = { shop };
  const results = await Promise.all([
    db.waitlistEntry.deleteMany({ where }),
    db.preorderConfig.deleteMany({ where }),
    db.shopSettings.deleteMany({ where }),
    db.processedWebhook.deleteMany({ where }),
    db.notificationDelivery.deleteMany({ where }),
    db.notificationAttempt.deleteMany({ where }),
    db.restockEvent.deleteMany({ where }),
    db.preorderOrder.deleteMany({ where }),
  ]);
  await db.session.deleteMany({ where });
  return { deleted: results.reduce((a, r) => a + r.count, 0) };
}

/** Merchant-triggered: queues and sends to anyone waiting on variants that are in stock now. */
export async function resumePending({ db, shop, admin, mailer, budgetMs = 8000 }) {
  const r = await runQueueForShop({ db, shop, admin, mailer, budgetMs });
  return { sent: r.sent, failed: r.failed + r.retried, remaining: r.remaining, operational: r.operational };
}
