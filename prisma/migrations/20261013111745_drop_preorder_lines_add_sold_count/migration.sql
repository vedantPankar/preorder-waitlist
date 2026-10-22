/*
  Warnings:

  - You are about to drop the `PreorderLine` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropIndex
DROP INDEX "PreorderLine_shop_lineItemId_key";

-- DropIndex
DROP INDEX "PreorderLine_shop_orderId_idx";

-- DropIndex
DROP INDEX "PreorderLine_shop_variantId_status_idx";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "PreorderLine";
PRAGMA foreign_keys=on;

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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_PreorderConfig" ("buttonText", "createdAt", "enabled", "id", "maxQuantity", "previousInventoryPolicy", "productId", "productTitle", "shipDate", "shop", "updatedAt", "variantId", "variantTitle") SELECT "buttonText", "createdAt", "enabled", "id", "maxQuantity", "previousInventoryPolicy", "productId", "productTitle", "shipDate", "shop", "updatedAt", "variantId", "variantTitle" FROM "PreorderConfig";
DROP TABLE "PreorderConfig";
ALTER TABLE "new_PreorderConfig" RENAME TO "PreorderConfig";
CREATE INDEX "PreorderConfig_shop_productId_idx" ON "PreorderConfig"("shop", "productId");
CREATE UNIQUE INDEX "PreorderConfig_shop_variantId_key" ON "PreorderConfig"("shop", "variantId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
