-- CreateTable
CREATE TABLE "RestockEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT,
    "inventoryQuantity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "targetPath" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" DATETIME,
    "providerMessageId" TEXT,
    "lastError" TEXT,
    "trackingToken" TEXT NOT NULL,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" DATETIME,
    "clickedAt" DATETIME,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "NotificationAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "retryable" BOOLEAN,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShopSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "fromName" TEXT,
    "replyToEmail" TEXT,
    "subject" TEXT NOT NULL DEFAULT '{{product}} is back in stock',
    "retentionDays" INTEGER NOT NULL DEFAULT 90,
    "waitlistEnabled" BOOLEAN NOT NULL DEFAULT true,
    "restockCoveragePct" INTEGER NOT NULL DEFAULT 50,
    "restockBuffer" INTEGER NOT NULL DEFAULT 0,
    "trackClicks" BOOLEAN NOT NULL DEFAULT false,
    "lastNotifyError" TEXT,
    "lastNotifyErrorAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ShopSettings" ("fromName", "lastNotifyError", "lastNotifyErrorAt", "replyToEmail", "retentionDays", "shop", "subject", "updatedAt", "waitlistEnabled") SELECT "fromName", "lastNotifyError", "lastNotifyErrorAt", "replyToEmail", "retentionDays", "shop", "subject", "updatedAt", "waitlistEnabled" FROM "ShopSettings";
DROP TABLE "ShopSettings";
ALTER TABLE "new_ShopSettings" RENAME TO "ShopSettings";
CREATE TABLE "new_WaitlistEntry" (
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
    "signedUpAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "optionsJson" TEXT,
    "updatedAt" DATETIME NOT NULL
);
-- signedUpAt starts equal to createdAt for existing signups
INSERT INTO "new_WaitlistEntry" ("attempts", "createdAt", "signedUpAt", "email", "id", "lastError", "notifiedAt", "productHandle", "productId", "productTitle", "sendingSince", "shop", "status", "updatedAt", "variantId", "variantTitle") SELECT "attempts", "createdAt", "createdAt", "email", "id", "lastError", "notifiedAt", "productHandle", "productId", "productTitle", "sendingSince", "shop", "status", "updatedAt", "variantId", "variantTitle" FROM "WaitlistEntry";
DROP TABLE "WaitlistEntry";
ALTER TABLE "new_WaitlistEntry" RENAME TO "WaitlistEntry";
CREATE INDEX "WaitlistEntry_shop_status_idx" ON "WaitlistEntry"("shop", "status");
CREATE INDEX "WaitlistEntry_shop_variantId_status_idx" ON "WaitlistEntry"("shop", "variantId", "status");
CREATE INDEX "WaitlistEntry_shop_status_signedUpAt_idx" ON "WaitlistEntry"("shop", "status", "signedUpAt");
CREATE INDEX "WaitlistEntry_shop_productId_status_idx" ON "WaitlistEntry"("shop", "productId", "status");
CREATE UNIQUE INDEX "WaitlistEntry_shop_email_variantId_key" ON "WaitlistEntry"("shop", "email", "variantId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "RestockEvent_openKey_key" ON "RestockEvent"("openKey");

-- CreateIndex
CREATE INDEX "RestockEvent_shop_variantId_status_idx" ON "RestockEvent"("shop", "variantId", "status");

-- CreateIndex
CREATE INDEX "RestockEvent_shop_createdAt_idx" ON "RestockEvent"("shop", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_trackingToken_key" ON "NotificationDelivery"("trackingToken");

-- CreateIndex
CREATE INDEX "NotificationDelivery_shop_status_nextAttemptAt_idx" ON "NotificationDelivery"("shop", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_shop_variantId_status_idx" ON "NotificationDelivery"("shop", "variantId", "status");

-- CreateIndex
CREATE INDEX "NotificationDelivery_shop_queuedAt_idx" ON "NotificationDelivery"("shop", "queuedAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_entryId_idx" ON "NotificationDelivery"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_eventId_entryId_key" ON "NotificationDelivery"("eventId", "entryId");

-- CreateIndex
CREATE INDEX "NotificationAttempt_shop_deliveryId_idx" ON "NotificationAttempt"("shop", "deliveryId");

-- CreateIndex
CREATE INDEX "NotificationAttempt_shop_createdAt_idx" ON "NotificationAttempt"("shop", "createdAt");

