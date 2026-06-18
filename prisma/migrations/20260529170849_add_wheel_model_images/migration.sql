-- CreateTable
CREATE TABLE "WheelModelImage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "modelCode" TEXT NOT NULL,
    "shopifyFileId" TEXT,
    "imageUrl" TEXT NOT NULL,
    "alt" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "WheelModelImage_shop_idx" ON "WheelModelImage"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "WheelModelImage_shop_modelCode_key" ON "WheelModelImage"("shop", "modelCode");
