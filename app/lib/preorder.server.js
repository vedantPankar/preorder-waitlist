import { cleanText, parseDateOnly, parsePositiveInt } from "./validation.server";
import { fetchVariants, setVariantInventoryPolicy } from "./shopify-data.server";
import { convertHolds, effectiveLimit, effectiveShipDate, reconcileConfig, variantPhase } from "./campaign.server";

export const DEFAULT_BUTTON_TEXT = "Pre-Order Now";

/** Units already pre-ordered = stock below zero (Shopify records backorders as negative stock). */
export const backorderedUnits = (inventoryQuantity) => Math.max(0, -(inventoryQuantity ?? 0));

export function remainingQuantity(config, sold) {
  return config.maxQuantity == null ? null : Math.max(0, config.maxQuantity - sold);
}

/** Pure eligibility rule shared by the storefront endpoint and tests. */
export function isPreorderEligible(config, { sold = 0, inventoryQuantity = 0 } = {}) {
  if (!config || !config.enabled) return false;
  if (inventoryQuantity > 0) return false; // in stock: sell normally
  const remaining = remainingQuantity(config, sold);
  return remaining === null || remaining > 0;
}

export function validateConfigInput(input) {
  const errors = {};
  const buttonText = cleanText(input.buttonText, 40) || DEFAULT_BUTTON_TEXT;
  let shipDate = null;
  if (input.shipDate) {
    shipDate = parseDateOnly(input.shipDate);
    if (!shipDate) errors.shipDate = "Enter a valid date.";
  } else {
    errors.shipDate = "Expected shipping date is required.";
  }
  const maxQuantity = parsePositiveInt(input.maxQuantity);
  if (Number.isNaN(maxQuantity)) errors.maxQuantity = "Enter a whole number greater than 0, or leave blank for no limit.";
  return { errors, value: { buttonText, shipDate, maxQuantity: Number.isNaN(maxQuantity) ? null : maxQuantity, enabled: input.enabled !== false } };
}

/**
 * Public storefront view of a product's pre-order configuration.
 * `phase` (active | scheduled | ended | sold_out | paused) tells the storefront what to
 * show; `soldOut` is kept (true whenever pre-ordering is not possible right now) for
 * older storefront scripts. Draft campaigns are never exposed.
 */
export async function storefrontConfig(db, shop, productId, { now = new Date() } = {}) {
  const configs = await db.preorderConfig.findMany({ where: { shop, productId, enabled: true } });
  const ids = [...new Set(configs.map((c) => c.campaignId).filter(Boolean))];
  const campaigns = new Map((ids.length ? await db.campaign.findMany({ where: { shop, id: { in: ids } } }) : []).map((c) => [c.id, c]));
  const day = (d) => (d ? d.toISOString().slice(0, 10) : null);
  return configs.flatMap((c) => {
    const campaign = c.campaignId ? campaigns.get(c.campaignId) : null;
    if (c.campaignId && !campaign) return [];
    const phase = variantPhase(c, campaign, now);
    if (phase === "draft") return [];
    const limit = effectiveLimit(c, campaign);
    const out = {
      variantId: c.variantId,
      buttonText: c.buttonText,
      shipDate: day(effectiveShipDate(c, campaign)),
      remaining: limit == null ? null : Math.max(0, limit - c.soldCount - c.reservedCount),
      soldOut: phase !== "active",
      phase,
    };
    if (campaign) {
      const target = campaign.targetUnits ?? limit;
      out.campaign = {
        name: campaign.name,
        startsAt: campaign.startsAt?.toISOString() ?? null,
        endsAt: campaign.endsAt?.toISOString() ?? null,
        countdown: campaign.showCountdown,
        // Progress uses units actually sold (from inventory), never holds or estimates.
        progress: campaign.showProgress && target ? { sold: c.soldCount, target } : null,
      };
    }
    return [out];
  });
}

/**
 * Enables/updates pre-order for variants chosen in the admin. Variant data is
 * re-fetched from Shopify so ids from the client are verified against this shop.
 */
export async function saveConfigs(db, admin, shop, variantIds, input) {
  const { errors, value } = validateConfigInput(input);
  if (Object.keys(errors).length) return { errors };
  const variants = await fetchVariants(admin, variantIds);
  if (!variants.length) return { errors: { variants: "Selected variants were not found in this store." } };
  const managed = await db.preorderConfig.count({ where: { shop, variantId: { in: variants.map((v) => v.variantId) }, campaignId: { not: null } } });
  if (managed) return { errors: { variants: "Some selected variants belong to a campaign. Manage them from the Campaigns page." } };

  for (const v of variants) {
    const existing = await db.preorderConfig.findUnique({ where: { shop_variantId: { shop, variantId: v.variantId } } });
    let previousInventoryPolicy = existing?.previousInventoryPolicy ?? null;
    const limitReached = value.maxQuantity != null && backorderedUnits(v.inventoryQuantity) >= value.maxQuantity;
    if (value.enabled && v.inventoryPolicy !== "CONTINUE" && !limitReached) {
      // Shopify only lets a sold-out variant be purchased when it may oversell.
      previousInventoryPolicy = previousInventoryPolicy ?? v.inventoryPolicy;
      await setVariantInventoryPolicy(admin, { productId: v.productId, variantId: v.variantId, policy: "CONTINUE" });
    }
    const data = {
      productId: v.productId, productTitle: v.productTitle, variantTitle: v.variantTitle,
      ...value, previousInventoryPolicy, soldCount: backorderedUnits(v.inventoryQuantity),
    };
    await db.preorderConfig.upsert({
      where: { shop_variantId: { shop, variantId: v.variantId } },
      create: { shop, variantId: v.variantId, ...data },
      update: data,
    });
    if (!value.enabled) await restorePolicy(db, admin, shop, v);
  }
  return { saved: variants.length };
}

async function restorePolicy(db, admin, shop, v) {
  const config = await db.preorderConfig.findUnique({ where: { shop_variantId: { shop, variantId: v.variantId } } });
  if (config?.previousInventoryPolicy) {
    await setVariantInventoryPolicy(admin, { productId: config.productId, variantId: config.variantId, policy: config.previousInventoryPolicy });
    await db.preorderConfig.updateMany({ where: { shop, variantId: v.variantId }, data: { previousInventoryPolicy: null } });
  }
}

export async function setEnabled(db, admin, shop, id, enabled) {
  const config = await db.preorderConfig.findFirst({ where: { id, shop, campaignId: null } });
  if (!config) return false;
  if (enabled) {
    const [v] = await fetchVariants(admin, [config.variantId]);
    const sold = backorderedUnits(v?.inventoryQuantity);
    const limitReached = config.maxQuantity != null && sold >= config.maxQuantity;
    // Re-open selling unless the quota is used up (enforceLimits closed it).
    if (v && v.inventoryPolicy !== "CONTINUE" && !limitReached) {
      await setVariantInventoryPolicy(admin, { productId: v.productId, variantId: v.variantId, policy: "CONTINUE" });
      await db.preorderConfig.updateMany({
        where: { id, shop },
        data: { previousInventoryPolicy: config.previousInventoryPolicy ?? v.inventoryPolicy },
      });
    }
  }
  await db.preorderConfig.updateMany({ where: { id, shop }, data: { enabled } });
  if (!enabled) await restorePolicy(db, admin, shop, { variantId: config.variantId });
  return true;
}

export async function removeConfig(db, admin, shop, id) {
  const config = await db.preorderConfig.findFirst({ where: { id, shop, campaignId: null } });
  if (!config) return false;
  await restorePolicy(db, admin, shop, { variantId: config.variantId });
  await db.preorderReservation.deleteMany({ where: { shop, configId: config.id } });
  await db.preorderConfig.deleteMany({ where: { id, shop } });
  return true;
}

/**
 * Called from inventory webhooks with fresh variant data. Refreshes the sold
 * counter and closes selling (policy DENY) once the limit is reached.
 * Best effort: orders placed before the webhook is processed can exceed it.
 */
export async function syncPreorderStock(db, admin, shop, variants, now = new Date()) {
  const closed = [];
  for (const v of variants) {
    const config = await db.preorderConfig.findUnique({ where: { shop_variantId: { shop, variantId: v.variantId } } });
    if (!config) continue;
    const sold = backorderedUnits(v.inventoryQuantity);
    // Sales seen in inventory settle the oldest reservations so they are not counted twice.
    if (sold > config.soldCount) await convertHolds(db, shop, config.id, sold - config.soldCount, now);
    if (config.campaignId) {
      const campaign = await db.campaign.findFirst({ where: { id: config.campaignId, shop } });
      if (!campaign) continue;
      const wasOpen = v.inventoryPolicy === "CONTINUE";
      const r = await reconcileConfig(db, admin, shop, { ...config, soldCount: config.soldCount }, campaign, v, now);
      if (wasOpen && !r.open) closed.push(v.variantId);
      continue;
    }
    if (sold !== config.soldCount) await db.preorderConfig.updateMany({ where: { id: config.id, shop }, data: { soldCount: sold } });
    if (config.enabled && config.maxQuantity != null && sold >= config.maxQuantity && v.inventoryPolicy === "CONTINUE") {
      await setVariantInventoryPolicy(admin, { productId: v.productId, variantId: v.variantId, policy: "DENY" });
      closed.push(v.variantId);
    }
  }
  return closed;
}
