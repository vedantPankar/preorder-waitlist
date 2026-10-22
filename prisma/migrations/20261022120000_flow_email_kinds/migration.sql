-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN "emailSignupConfirmation" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopSettings" ADD COLUMN "emailShipReminder" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopSettings" ADD COLUMN "emailShipDateChange" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopSettings" ADD COLUMN "shipReminderDays" INTEGER NOT NULL DEFAULT 3;

-- AlterTable
ALTER TABLE "NotificationDelivery" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'RESTOCK';
ALTER TABLE "NotificationDelivery" ADD COLUMN "payload" TEXT;

-- CreateIndex
CREATE INDEX "NotificationDelivery_shop_kind_status_nextAttemptAt_idx" ON "NotificationDelivery"("shop", "kind", "status", "nextAttemptAt");

-- CreateTable
CREATE TABLE "PreorderOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "orderName" TEXT,
    "customerId" TEXT,
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "lastShipDate" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "PreorderOrder_shop_orderId_lineItemId_key" ON "PreorderOrder"("shop", "orderId", "lineItemId");
CREATE INDEX "PreorderOrder_shop_status_idx" ON "PreorderOrder"("shop", "status");
CREATE INDEX "PreorderOrder_shop_customerId_idx" ON "PreorderOrder"("shop", "customerId");
CREATE INDEX "PreorderOrder_shop_variantId_status_idx" ON "PreorderOrder"("shop", "variantId", "status");
