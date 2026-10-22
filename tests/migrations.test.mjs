import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

// Applies every migration except the newest ones to a database that already holds
// data, then the rest. Catches SQLite limits (e.g. non-constant ADD COLUMN defaults)
// that an empty test database never hits.
test("newest migrations apply over existing rows and preserve/backfill them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-mig-"));
  const db = new PrismaClient({ datasourceUrl: `file:${join(dir, "m.sqlite")}` });
  const root = new URL("../prisma/migrations/", import.meta.url).pathname;
  const names = readdirSync(root).filter((n) => !n.endsWith(".toml")).sort();
  const apply = async (name) => {
    const sql = readFileSync(join(root, name, "migration.sql"), "utf8");
    for (const stmt of sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(stmt);
  };
  const cut = names.indexOf("20261015100000_demand_and_notification_queue");
  assert.ok(cut > 0, "the demand/queue migration exists");
  for (const n of names.slice(0, cut)) await apply(n);
  await db.$executeRawUnsafe(`INSERT INTO "WaitlistEntry" ("id","shop","email","productId","variantId","productTitle","status","createdAt","updatedAt") VALUES ('w1','s.myshopify.com','a@x.com','1','2','Tee','NOTIFIED','2026-01-02 03:04:05','2026-01-02 03:04:05')`);
  await db.$executeRawUnsafe(`INSERT INTO "ShopSettings" ("shop","updatedAt") VALUES ('s.myshopify.com','2026-01-02 03:04:05')`);
  for (const n of names.slice(cut)) await apply(n);
  const [entry] = await db.$queryRawUnsafe(`SELECT "status","createdAt","signedUpAt","optionsJson" FROM "WaitlistEntry" WHERE id='w1'`);
  assert.equal(entry.status, "NOTIFIED");
  assert.equal(String(entry.signedUpAt), String(entry.createdAt), "signedUpAt backfilled from createdAt");
  assert.equal(entry.optionsJson, null);
  const [settings] = await db.$queryRawUnsafe(`SELECT "restockCoveragePct","restockBuffer","trackClicks","waitlistEnabled" FROM "ShopSettings"`);
  assert.deepEqual([Number(settings.restockCoveragePct), Number(settings.restockBuffer), Number(settings.trackClicks), Number(settings.waitlistEnabled)], [50, 0, 0, 1]);
  await db.$disconnect();
});
