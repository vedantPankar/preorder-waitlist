// Optional in-process scheduler for single-instance deployments.
//   NOTIFY_WORKER_INTERVAL_MS = e.g. 60000 enables a loop that drains due notifications.
// Multi-instance / serverless deployments should instead call POST /api/notifications/run
// from an external scheduler (see CRON_SECRET). Both are safe to combine: deliveries are
// claimed with conditional updates, so two runners never send the same email.
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { getMailerStatus } from "./mailer.server";
import { anyGmailShop, getShopMailer } from "./shop-mailer.server";
import { runQueueForShop, shopsWithDueWork } from "./queue-runner.server";
import { reconcileShop } from "./campaign.server";

/**
 * One pass over every shop with due work: restock emails that are queued/ready, and
 * campaign start/end transitions (so selling opens and closes on schedule even with no
 * storefront traffic). Returns a small per-shop summary (no customer data).
 */
export async function runAllShops({ now = new Date(), only = null, budgetMs = 20_000, getAdmin = (shop) => unauthenticated.admin(shop).then((r) => r.admin), mailer = undefined } = {}) {
  const deadline = Date.now() + budgetMs;
  const shops = [];
  const canEmail = Boolean(mailer) || getMailerStatus().configured || (await anyGmailShop(db));
  const emailShops = canEmail ? await shopsWithDueWork(db, now) : [];
  const campaignShops = (await db.preorderConfig.groupBy({ by: ["shop"], where: { campaignId: { not: null } } })).map((g) => g.shop);
  for (const shop of [...new Set([...emailShops, ...campaignShops])].filter((x) => !only || x === only)) {
    if (Date.now() >= deadline) break;
    const entry = { shop };
    try {
      const admin = await getAdmin(shop);
      if (campaignShops.includes(shop)) entry.campaigns = (await reconcileShop(db, admin, shop, now)).changed;
      const shopMailer = mailer ?? (await getShopMailer(db, shop, { admin }));
      if (shopMailer && emailShops.includes(shop)) {
        const r = await runQueueForShop({ db, shop, admin, mailer: shopMailer, now, budgetMs: Math.max(1000, deadline - Date.now()) });
        Object.assign(entry, { sent: r.sent, failed: r.failed, retried: r.retried });
      }
    } catch (error) {
      entry.error = String(error?.message ?? "run_failed").slice(0, 120);
    }
    shops.push(entry);
  }
  return { operational: canEmail, shops };
}

let timer = null;
export function ensureWorker(env = process.env) {
  const every = Number(env.NOTIFY_WORKER_INTERVAL_MS);
  if (timer || !Number.isFinite(every) || every < 5000) return false;
  let running = false;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await runAllShops(); } catch (e) { console.error("Notification worker pass failed:", e?.message); } finally { running = false; }
  }, every);
  timer.unref?.();
  return true;
}
