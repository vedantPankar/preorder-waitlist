-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT,
    "productHandle" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sendingSince" DATETIME,
    "notifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PreorderConfig" (
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
    "previousInventoryPolicy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PreorderLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT,
    "lineItemId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "fromName" TEXT,
    "replyToEmail" TEXT,
    "subject" TEXT NOT NULL DEFAULT '{{product}} is back in stock',
    "retentionDays" INTEGER NOT NULL DEFAULT 90,
    "lastNotifyError" TEXT,
    "lastNotifyErrorAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProcessedWebhook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "WaitlistEntry_shop_status_idx" ON "WaitlistEntry"("shop", "status");

-- CreateIndex
CREATE INDEX "WaitlistEntry_shop_variantId_status_idx" ON "WaitlistEntry"("shop", "variantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistEntry_shop_email_variantId_key" ON "WaitlistEntry"("shop", "email", "variantId");

-- CreateIndex
CREATE INDEX "PreorderConfig_shop_productId_idx" ON "PreorderConfig"("shop", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "PreorderConfig_shop_variantId_key" ON "PreorderConfig"("shop", "variantId");

-- CreateIndex
CREATE INDEX "PreorderLine_shop_variantId_status_idx" ON "PreorderLine"("shop", "variantId", "status");

-- CreateIndex
CREATE INDEX "PreorderLine_shop_orderId_idx" ON "PreorderLine"("shop", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "PreorderLine_shop_lineItemId_key" ON "PreorderLine"("shop", "lineItemId");

-- CreateIndex
CREATE INDEX "ProcessedWebhook_createdAt_idx" ON "ProcessedWebhook"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedWebhook_shop_webhookId_key" ON "ProcessedWebhook"("shop", "webhookId");
