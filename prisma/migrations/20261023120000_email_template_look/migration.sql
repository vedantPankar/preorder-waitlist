-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN "emailTemplate" TEXT NOT NULL DEFAULT 'classic';
ALTER TABLE "ShopSettings" ADD COLUMN "emailAccentColor" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN "emailLogoUrl" TEXT;
