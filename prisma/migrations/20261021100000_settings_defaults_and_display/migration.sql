-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN "defaultButtonText" TEXT NOT NULL DEFAULT 'Pre-Order Now';
ALTER TABLE "ShopSettings" ADD COLUMN "defaultMaxQuantity" INTEGER;
ALTER TABLE "ShopSettings" ADD COLUMN "defaultTargetUnits" INTEGER;
ALTER TABLE "ShopSettings" ADD COLUMN "defaultShowCountdown" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopSettings" ADD COLUMN "defaultShowProgress" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopSettings" ADD COLUMN "displayCustomized" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopSettings" ADD COLUMN "buttonStyle" TEXT NOT NULL DEFAULT 'solid';
ALTER TABLE "ShopSettings" ADD COLUMN "buttonColor" TEXT NOT NULL DEFAULT '#006F5C';
ALTER TABLE "ShopSettings" ADD COLUMN "buttonTextColor" TEXT NOT NULL DEFAULT '#FFFFFF';
ALTER TABLE "ShopSettings" ADD COLUMN "progressColor" TEXT NOT NULL DEFAULT '#006F5C';
ALTER TABLE "ShopSettings" ADD COLUMN "countdownStyle" TEXT NOT NULL DEFAULT 'dhms';
