-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN "gmailAddress" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN "gmailPasswordEnc" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN "gmailAuthError" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN "gmailAuthErrorAt" DATETIME;
ALTER TABLE "ShopSettings" ADD COLUMN "dailySendCap" INTEGER NOT NULL DEFAULT 400;

-- AlterTable
ALTER TABLE "PreorderOrder" ADD COLUMN "email" TEXT;

-- CreateTable
CREATE TABLE "EmailQuota" (
    "account" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("account", "day")
);
