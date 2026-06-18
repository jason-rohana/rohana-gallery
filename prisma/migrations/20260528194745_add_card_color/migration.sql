-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GalleryCard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tabId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "GalleryCard_tabId_fkey" FOREIGN KEY ("tabId") REFERENCES "GalleryTab" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_GalleryCard" ("description", "id", "position", "subtitle", "tabId", "title") SELECT "description", "id", "position", "subtitle", "tabId", "title" FROM "GalleryCard";
DROP TABLE "GalleryCard";
ALTER TABLE "new_GalleryCard" RENAME TO "GalleryCard";
CREATE INDEX "GalleryCard_tabId_idx" ON "GalleryCard"("tabId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
