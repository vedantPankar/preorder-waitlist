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
    "lastNotifyError" TEXT,
    "lastNotifyErrorAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ShopSettings" ("fromName", "lastNotifyError", "lastNotifyErrorAt", "replyToEmail", "retentionDays", "shop", "subject", "updatedAt") SELECT "fromName", "lastNotifyError", "lastNotifyErrorAt", "replyToEmail", "retentionDays", "shop", "subject", "updatedAt" FROM "ShopSettings";
DROP TABLE "ShopSettings";
ALTER TABLE "new_ShopSettings" RENAME TO "ShopSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
