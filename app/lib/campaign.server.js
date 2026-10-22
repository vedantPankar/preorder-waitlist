// Smart Pre-Order Campaigns, layered on PreorderConfig (one row per variant stays the
// live source of truth; a campaign supplies defaults and a schedule).
//
// What this module can and cannot guarantee (also shown to merchants):
//  * Units already sold are counted from Shopify inventory (negative stock), refreshed by
//    inventory webhooks. That count is verified data.
//  * Reservations (below) are atomic holds taken through the app proxy before an item is
//    added to the cart. Concurrent requests can never hold more than the limit.
//  * Shopify's checkout itself is NOT gated by this app. A customer who bypasses the
//    pre-order button (e.g. a direct /cart/add call) is only stopped once the webhook
//    closes selling (inventory policy DENY). Strict enforcement would need a Shopify
//    Checkout/Cart Validation Function, which is not part of this app.
import { randomUUID } from "node:crypto";
import { cleanText, parseDateOnly, parsePositiveInt } from "./validation.server";
import { backorderedUnits } from "./preorder.server";
import { fetchVariants, setVariantInventoryPolicy } from "./shopify-data.server";

export const HOLD_TTL_MS = 15 * 60 * 1000;
export const MAX_HOLD_UNITS = 10;
const DAY = 86400000;

// ---------- pure rules ----------

export const effectiveLimit = (config, campaign) => config.maxQuantity ?? campaign?.maxQuantity ?? null;
export const effectiveShipDate = (config, campaign) => config.shipDate ?? campaign?.shipDate ?? null;

/** Time/intent phase of a campaign alone (ignores quantities). */
export function campaignPhase(campaign, now = new Date()) {
  if (!campaign) return "active";
  if (campaign.state === "DRAFT") return "draft";
  if (campaign.state === "PAUSED") return "paused";
  if (campaign.startsAt && now < campaign.startsAt) return "scheduled";
  if (campaign.endsAt && now >= campaign.endsAt) return "ended";
  return "active";
}

/** Phase of one variant as customers experience it. `reserved` is included only for display/availability. */
export function variantPhase(config, campaign, now = new Date(), { includeReserved = true } = {}) {
  if (!config.enabled) return "disabled";
  const phase = campaignPhase(campaign, now);
  if (phase !== "active") return phase;
  const limit = effectiveLimit(config, campaign);
  const used = config.soldCount + (includeReserved ? config.reservedCount : 0);
  return limit != null && used >= limit ? "sold_out" : "active";
}

/**
 * Should Shopify sell this variant at zero stock right now? Holds do not count: a
 * customer holding units must still be able to check out, so selling is only closed
 * once units are actually sold.
 */
export const desiredOpen = (config, campaign, now = new Date(), sold = config.soldCount) =>
  variantPhase({ ...config, soldCount: sold }, campaign, now, { includeReserved: false }) === "active";

/** Display status of a campaign: DRAFT | SCHEDULED | ACTIVE | PAUSED | SOLD_OUT | COMPLETED. */
export function campaignStatus(campaign, configs, now = new Date()) {
  const phase = campaignPhase(campaign, now);
  if (phase !== "active") return { draft: "DRAFT", paused: "PAUSED", scheduled: "SCHEDULED", ended: "COMPLETED" }[phase];
  const live = configs.filter((c) => c.enabled);
  const exhausted = live.length > 0 && live.every((c) => {
    const limit = effectiveLimit(c, campaign);
    return limit != null && c.soldCount >= limit;
  });
  return exhausted ? "SOLD_OUT" : "ACTIVE";
}

// ---------- validation ----------

export function validateCampaignInput(input) {
  const errors = {};
  const name = cleanText(input.name, 80);
  if (!name) errors.name = "Enter a campaign name.";
  const startDay = input.startDate ? parseDateOnly(input.startDate) : null;
  const endDay = input.endDate ? parseDateOnly(input.endDate) : null;
  if (input.startDate && !startDay) errors.startDate = "Enter a valid start date.";
  if (input.endDate && !endDay) errors.endDate = "Enter a valid end date.";
  const startsAt = startDay;
  const endsAt = endDay ? new Date(endDay.getTime() + DAY) : null; // end date is inclusive
  if (startsAt && endsAt && endsAt <= startsAt) errors.endDate = "The end date must be on or after the start date.";
  const shipDate = input.shipDate ? parseDateOnly(input.shipDate) : null;
  if (!input.shipDate) errors.shipDate = "Expected shipping date is required.";
  else if (!shipDate) errors.shipDate = "Enter a valid date.";
  else if (endsAt && shipDate < new Date(endsAt.getTime() - DAY)) errors.shipDate = "Shipping should not be before the campaign ends.";
  const maxQuantity = parsePositiveInt(input.maxQuantity);
  if (Number.isNaN(maxQuantity)) errors.maxQuantity = "Enter a whole number greater than 0, or leave blank for no limit.";
  const targetUnits = parsePositiveInt(input.targetUnits);
  if (Number.isNaN(targetUnits)) errors.targetUnits = "Enter a whole number greater than 0, or leave blank.";
  const buttonText = cleanText(input.buttonText, 40) || "Pre-Order Now";
  const flag = (v) => ["on", "true", true].includes(v);
  const showCountdown = flag(input.showCountdown);
  if (showCountdown && !startsAt && !endsAt) errors.showCountdown = "A countdown needs a start or end date.";
  const showProgress = flag(input.showProgress);
  if (showProgress && !Number.isNaN(maxQuantity) && !Number.isNaN(targetUnits) && maxQuantity == null && targetUnits == null) errors.showProgress = "Progress needs a limit or a target.";
  return {
    errors,
    value: {
      name, startsAt, endsAt, shipDate, buttonText,
      maxQuantity: Number.isNaN(maxQuantity) ? null : maxQuantity, targetUnits: Number.isNaN(targetUnits) ? null : targetUnits,
      showCountdown, showProgress,
    },
  };
}

// ---------- reservations ----------

/**
 * Moves a hold from HELD to `status` and gives its units back, exactly once.
 * The status change is conditional, so only one caller can win it; the winner stamps a
 * unique token, and the give-back statement (same batch/transaction) only runs for the
 * row carrying that token. Non-interactive on purpose: interactive transactions on a
 * multi-connection SQLite pool time out under concurrency (measured), batches do not.
 */
async function resolveHold(db, hold, status, now = new Date()) {
  const token = randomUUID();
  const [moved] = await db.$transaction([
    db.preorderReservation.updateMany({ where: { id: hold.id, shop: hold.shop, status: "HELD" }, data: { status, resolvedAt: now, resolveToken: token } }),
    db.$executeRaw`UPDATE "PreorderConfig" SET "reservedCount" = CASE WHEN "reservedCount" >= ${hold.quantity} THEN "reservedCount" - ${hold.quantity} ELSE 0 END WHERE "id" = ${hold.configId} AND "shop" = ${hold.shop} AND EXISTS (SELECT 1 FROM "PreorderReservation" WHERE "id" = ${hold.id} AND "resolveToken" = ${token})`,
  ]);
  return moved.count === 1;
}

export async function expireHolds(db, shop, configId, now = new Date()) {
  const stale = await db.preorderReservation.findMany({ where: { shop, configId, status: "HELD", expiresAt: { lt: now } }, take: 200 });
  let n = 0;
  for (const hold of stale) if (await resolveHold(db, hold, "EXPIRED", now)) n++;
  return n;
}

export async function releaseReservation(db, shop, reservationId, now = new Date()) {
  const hold = await db.preorderReservation.findFirst({ where: { id: String(reservationId), shop } });
  return hold ? resolveHold(db, hold, "RELEASED", now) : false;
}

/** Sales observed in inventory turn the oldest holds into permanent sales (so they stop counting twice). */
export async function convertHolds(db, shop, configId, units, now = new Date()) {
  if (!(units > 0)) return 0;
  const holds = await db.preorderReservation.findMany({ where: { shop, configId, status: "HELD" }, orderBy: { createdAt: "asc" }, take: 200 });
  let left = units, converted = 0;
  for (const hold of holds) {
    if (hold.quantity > left) continue; // never release more than was observed sold
    if (await resolveHold(db, hold, "CONVERTED", now)) { left -= hold.quantity; converted++; }
    if (left <= 0) break;
  }
  return converted;
}

/**
 * Takes a hold of `quantity` units. The limit check and the increment are ONE conditional
 * UPDATE, so any number of simultaneous requests can together hold at most the limit.
 */
export async function reserve(db, { shop, variantId, quantity, now = new Date(), ttlMs = HOLD_TTL_MS }) {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_HOLD_UNITS) return { ok: false, error: "invalid_quantity", maxPerOrder: MAX_HOLD_UNITS };
  const config = await db.preorderConfig.findUnique({ where: { shop_variantId: { shop, variantId: String(variantId) } } });
  if (!config) return { ok: false, error: "not_configured" };
  const campaign = config.campaignId ? await db.campaign.findFirst({ where: { id: config.campaignId, shop } }) : null;
  await expireHolds(db, shop, config.id, now);
  const fresh = await db.preorderConfig.findUnique({ where: { id: config.id } });
  const phase = variantPhase(fresh, campaign, now);
  if (phase !== "active") return { ok: false, error: phase === "sold_out" ? "sold_out" : "closed", phase };
  const limit = effectiveLimit(fresh, campaign);
  if (limit == null) return { ok: true, limited: false, remaining: null }; // nothing to protect
  // One batch (single transaction): the limit check and increment are one conditional UPDATE;
  // the hold row is inserted only if that UPDATE stamped OUR token. Concurrent requests
  // serialize on the config row, so together they can never hold more than the limit.
  const reservationId = randomUUID();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await db.$transaction([
    db.$executeRaw`UPDATE "PreorderConfig" SET "reservedCount" = "reservedCount" + ${qty}, "holdToken" = ${reservationId} WHERE "id" = ${config.id} AND "shop" = ${shop} AND "enabled" = ${true} AND "soldCount" + "reservedCount" + ${qty} <= ${limit}`,
    db.$executeRaw`INSERT INTO "PreorderReservation" ("id", "shop", "configId", "variantId", "quantity", "status", "expiresAt", "createdAt") SELECT ${reservationId}, ${shop}, ${config.id}, ${config.variantId}, ${qty}, 'HELD', ${expiresAt}, ${now} WHERE (SELECT "holdToken" FROM "PreorderConfig" WHERE "id" = ${config.id}) = ${reservationId}`,
  ]);
  const hold = await db.preorderReservation.findFirst({ where: { id: reservationId, shop } });
  const after = await db.preorderConfig.findUnique({ where: { id: config.id } });
  if (!hold) return { ok: false, error: "limit", remaining: Math.max(0, limit - after.soldCount - after.reservedCount) };
  return { ok: true, limited: true, reservationId, expiresAt, remaining: Math.max(0, limit - after.soldCount - after.reservedCount) };
}

// ---------- inventory policy ----------

/**
 * Brings the variant's inventory policy in line with what the campaign/config allows:
 * open (CONTINUE) only while selling is allowed, otherwise DENY. `variant` is fresh
 * Shopify data. Only calls Shopify when the policy actually differs.
 */
export async function reconcileConfig(db, admin, shop, config, campaign, variant, now = new Date()) {
  const sold = backorderedUnits(variant.inventoryQuantity);
  const open = desiredOpen(config, campaign, now, sold);
  const data = {};
  if (sold !== config.soldCount) data.soldCount = sold;
  if (open && variant.inventoryPolicy !== "CONTINUE") {
    await setVariantInventoryPolicy(admin, { productId: variant.productId, variantId: variant.variantId, policy: "CONTINUE" });
    data.previousInventoryPolicy = config.previousInventoryPolicy ?? variant.inventoryPolicy;
  } else if (!open && variant.inventoryPolicy === "CONTINUE") {
    await setVariantInventoryPolicy(admin, { productId: variant.productId, variantId: variant.variantId, policy: "DENY" });
  }
  if (config.policyOpen !== open) data.policyOpen = open;
  if (Object.keys(data).length) await db.preorderConfig.updateMany({ where: { id: config.id, shop }, data });
  return { open, changed: Object.keys(data).length > 0 };
}

/** Reconciles every campaign variant whose stored state disagrees with what it should be now. */
export async function reconcileShop(db, admin, shop, now = new Date(), { productId } = {}) {
  const configs = await db.preorderConfig.findMany({ where: { shop, campaignId: { not: null }, ...(productId ? { productId } : {}) } });
  if (!configs.length) return { checked: 0, changed: 0 };
  const campaigns = new Map((await db.campaign.findMany({ where: { shop, id: { in: [...new Set(configs.map((c) => c.campaignId))] } } })).map((c) => [c.id, c]));
  const stale = configs.filter((c) => desiredOpen(c, campaigns.get(c.campaignId), now) !== c.policyOpen);
  if (!stale.length) return { checked: configs.length, changed: 0 };
  const variants = new Map((await fetchVariants(admin, stale.map((c) => c.variantId))).map((v) => [v.variantId, v]));
  let changed = 0;
  for (const c of stale) {
    const v = variants.get(c.variantId);
    if (v && (await reconcileConfig(db, admin, shop, c, campaigns.get(c.campaignId), v, now)).changed) changed++;
  }
  return { checked: configs.length, changed };
}

// ---------- campaign CRUD ----------

async function restoreOriginalPolicy(db, admin, shop, config) {
  if (!config.previousInventoryPolicy) return;
  await setVariantInventoryPolicy(admin, { productId: config.productId, variantId: config.variantId, policy: config.previousInventoryPolicy });
}

async function dropConfig(db, admin, shop, config) {
  await restoreOriginalPolicy(db, admin, shop, config);
  await db.preorderReservation.deleteMany({ where: { shop, configId: config.id } });
  await db.preorderConfig.deleteMany({ where: { id: config.id, shop } });
}

/**
 * Creates or updates a campaign and its variants. Variant ids are re-fetched from
 * Shopify (so foreign ids are rejected). A variant already configured on its own
 * (Product configuration) or in another campaign is refused rather than silently adopted.
 */
export async function saveCampaign(db, admin, shop, { id = null, input, variantIds = [], now = new Date() }) {
  const { errors, value } = validateCampaignInput(input);
  const existing = id ? await db.campaign.findFirst({ where: { id, shop } }) : null;
  if (id && !existing) return { errors: { form: "Campaign not found." } };
  const variants = variantIds.length ? await fetchVariants(admin, variantIds) : [];
  if (variantIds.length && variants.length !== new Set(variantIds).size) errors.variants = "Some selected variants were not found in this store.";
  if (!variants.length && !errors.variants && !existing) errors.variants = "Choose at least one variant.";
  const current = existing ? await db.preorderConfig.findMany({ where: { shop, campaignId: existing.id } }) : [];
  const conflicts = [];
  for (const v of variants) {
    const cfg = await db.preorderConfig.findUnique({ where: { shop_variantId: { shop, variantId: v.variantId } } });
    if (cfg && cfg.campaignId !== existing?.id) conflicts.push(v);
  }
  if (conflicts.length) errors.variants = `${conflicts.length} selected variant(s) are already set up for pre-order elsewhere (another campaign or Product configuration). Remove them there first.`;
  if (Object.keys(errors).length) return { errors };

  // The button text lives on each variant's config (editable per variant); the campaign form sets it for all.
  const { buttonText, ...campaignData } = value;
  const campaign = existing
    ? await db.campaign.update({ where: { id: existing.id }, data: campaignData })
    : await db.campaign.create({ data: { shop, ...campaignData } });

  const keep = new Set(variants.map((v) => v.variantId));
  if (existing && variantIds.length) for (const c of current) if (!keep.has(c.variantId)) await dropConfig(db, admin, shop, c);
  for (const v of variants) {
    const cfg = current.find((c) => c.variantId === v.variantId);
    const base = { productId: v.productId, productTitle: v.productTitle, variantTitle: v.variantTitle, buttonText, soldCount: backorderedUnits(v.inventoryQuantity) };
    if (cfg) await db.preorderConfig.update({ where: { id: cfg.id }, data: base });
    else await db.preorderConfig.create({ data: { shop, variantId: v.variantId, campaignId: campaign.id, enabled: true, shipDate: null, maxQuantity: null, previousInventoryPolicy: v.inventoryPolicy, policyOpen: v.inventoryPolicy === "CONTINUE", ...base } });
  }
  await reconcileCampaign(db, admin, shop, campaign.id, now);
  return { campaign };
}

export async function reconcileCampaign(db, admin, shop, campaignId, now = new Date()) {
  const campaign = await db.campaign.findFirst({ where: { id: campaignId, shop } });
  if (!campaign) return { changed: 0 };
  const configs = await db.preorderConfig.findMany({ where: { shop, campaignId } });
  if (!configs.length) return { changed: 0 };
  const variants = new Map((await fetchVariants(admin, configs.map((c) => c.variantId))).map((v) => [v.variantId, v]));
  let changed = 0;
  for (const c of configs) {
    const v = variants.get(c.variantId);
    if (v && (await reconcileConfig(db, admin, shop, c, campaign, v, now)).changed) changed++;
  }
  return { changed };
}

const STATES = { publish: "PUBLISHED", pause: "PAUSED", resume: "PUBLISHED", unpublish: "DRAFT" };

export async function setCampaignState(db, admin, shop, id, action, now = new Date()) {
  const state = STATES[action];
  const campaign = await db.campaign.findFirst({ where: { id, shop } });
  if (!state || !campaign) return { errors: { form: "Campaign not found." } };
  if (state === "PUBLISHED") {
    const count = await db.preorderConfig.count({ where: { shop, campaignId: id } });
    if (!count) return { errors: { form: "Add at least one variant before publishing." } };
    if (!campaign.shipDate) return { errors: { form: "Set an expected shipping date before publishing." } };
  }
  await db.campaign.updateMany({ where: { id, shop }, data: { state } });
  await reconcileCampaign(db, admin, shop, id, now);
  return { ok: true, state };
}

export async function deleteCampaign(db, admin, shop, id) {
  const campaign = await db.campaign.findFirst({ where: { id, shop } });
  if (!campaign) return false;
  const configs = await db.preorderConfig.findMany({ where: { shop, campaignId: id } });
  for (const c of configs) await dropConfig(db, admin, shop, c);
  await db.campaign.deleteMany({ where: { id, shop } });
  return true;
}

/** List view: each campaign with computed status and verified totals. */
export async function listCampaigns(db, shop, now = new Date()) {
  const [campaigns, configs] = await Promise.all([
    db.campaign.findMany({ where: { shop }, orderBy: { createdAt: "desc" } }),
    db.preorderConfig.findMany({ where: { shop, campaignId: { not: null } } }),
  ]);
  const waiting = configs.length
    ? await db.waitlistEntry.groupBy({ by: ["variantId"], where: { shop, variantId: { in: configs.map((c) => c.variantId) }, status: { in: ["ACTIVE", "SENDING"] } }, _count: { _all: true } })
    : [];
  const waitBy = new Map(waiting.map((g) => [g.variantId, g._count._all]));
  return campaigns.map((c) => {
    const mine = configs.filter((x) => x.campaignId === c.id);
    return {
      campaign: c, status: campaignStatus(c, mine, now), variants: mine.length,
      sold: mine.reduce((a, x) => a + x.soldCount, 0),
      held: mine.reduce((a, x) => a + x.reservedCount, 0),
      limit: mine.every((x) => effectiveLimit(x, c) != null) && mine.length ? mine.reduce((a, x) => a + effectiveLimit(x, c), 0) : null,
      waiting: mine.reduce((a, x) => a + (waitBy.get(x.variantId) ?? 0), 0),
    };
  });
}
