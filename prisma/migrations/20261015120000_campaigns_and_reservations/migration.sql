-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "startsAt" DATETIME,
    "endsAt" DATETIME,
    "shipDate" DATETIME,
    "maxQuantity" INTEGER,
    "targetUnits" INTEGER,
    "showCountdown" BOOLEAN NOT NULL DEFAULT false,
    "showProgress" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PreorderReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PreorderConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "buttonText" TEXT NOT NULL DEFAULT 'Pre-Order Now',
    "shipDate" DATETIME,
    "maxQuantity" INTEGER,
    "soldCount" INTEGER NOT NULL DEFAULT 0,
    "previousInventoryPolicy" TEXT,
    "campaignId" TEXT,
    "reservedCount" INTEGER NOT NULL DEFAULT 0,
    "policyOpen" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_PreorderConfig" ("buttonText", "createdAt", "enabled", "id", "maxQuantity", "previousInventoryPolicy", "productId", "productTitle", "shipDate", "shop", "soldCount", "updatedAt", "variantId", "variantTitle") SELECT "buttonText", "createdAt", "enabled", "id", "maxQuantity", "previousInventoryPolicy", "productId", "productTitle", "shipDate", "shop", "soldCount", "updatedAt", "variantId", "variantTitle" FROM "PreorderConfig";
DROP TABLE "PreorderConfig";
ALTER TABLE "new_PreorderConfig" RENAME TO "PreorderConfig";
-- Existing enabled configs were opened by the app; mark them so the first reconcile does not re-apply
UPDATE "PreorderConfig" SET "policyOpen" = "enabled";
CREATE INDEX "PreorderConfig_shop_productId_idx" ON "PreorderConfig"("shop", "productId");
CREATE INDEX "PreorderConfig_shop_campaignId_idx" ON "PreorderConfig"("shop", "campaignId");
CREATE UNIQUE INDEX "PreorderConfig_shop_variantId_key" ON "PreorderConfig"("shop", "variantId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Campaign_shop_state_idx" ON "Campaign"("shop", "state");

-- CreateIndex
CREATE INDEX "Campaign_shop_startsAt_idx" ON "Campaign"("shop", "startsAt");

-- CreateIndex
CREATE INDEX "PreorderReservation_shop_configId_status_idx" ON "PreorderReservation"("shop", "configId", "status");

-- CreateIndex
CREATE INDEX "PreorderReservation_status_expiresAt_idx" ON "PreorderReservation"("status", "expiresAt");

