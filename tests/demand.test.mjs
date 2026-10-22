import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.mjs";
import { addSignup } from "../app/lib/waitlist.server.js";
import { demandSummary, parseDemandParams, signupSeries } from "../app/lib/demand.server.js";

let db;
before(async () => { db = await createTestDb(); });

const NOW = new Date("2026-10-15T12:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);
let seq = 0;
async function entry(shop, productId, variantId, { title = `Product ${productId}`, vTitle = null, status = "ACTIVE", signedUpAt = daysAgo(1), options = null } = {}) {
  await db.waitlistEntry.create({ data: {
    shop, email: `u${++seq}@x.com`, productId, variantId, productTitle: title, variantTitle: vTitle, status, signedUpAt,
    optionsJson: options ? JSON.stringify(options) : null,
  } });
}
const range = (days = 30) => parseDemandParams({ period: String(days) }, NOW).range;

test("empty shop: all metrics are zero (no invented data)", async () => {
  const shop = "d-empty.myshopify.com";
  const s = await demandSummary(db, shop, range());
  assert.deepEqual([s.waiting, s.newCount, s.prevNew, s.productsWithDemand], [0, 0, 0, 0]);
  assert.equal(s.hasComparison, false); assert.equal(s.growthPct, null);
  const series = await signupSeries(db, shop, range(7));
  assert.equal(series.days.length, 7); assert.ok(series.days.every((d) => d.count === 0));
});

test("counts are correct; notified/removed are not 'waiting'", async () => {
  const shop = "d-rank.myshopify.com";
  for (let i = 0; i < 5; i++) await entry(shop, "P1", "V1", { title: "Boot", vTitle: "M" });
  for (let i = 0; i < 2; i++) await entry(shop, "P1", "V2", { title: "Boot", vTitle: "L" });
  for (let i = 0; i < 3; i++) await entry(shop, "P2", "V3", { title: "Hat" });
  await entry(shop, "P2", "V3", { title: "Hat", status: "NOTIFIED" });
  await entry(shop, "P2", "V3", { title: "Hat", status: "REMOVED" });
  await entry(shop, "P3", "V4", { title: "Sock", status: "SENDING" });

  const s = await demandSummary(db, shop, range());
  assert.equal(s.waiting, 11); // 5+2+3+1 (SENDING counts as waiting)
  assert.equal(s.productsWithDemand, 3); assert.equal(s.variantsWithDemand, 4);
  assert.equal(s.newCount, 12); // all but REMOVED signed up in range
});

test("date range filtering and previous-period comparison", async () => {
  const shop = "d-range.myshopify.com";
  for (let i = 0; i < 4; i++) await entry(shop, "P1", "V1", { title: "Boot", signedUpAt: daysAgo(3) });  // current 30d period
  for (let i = 0; i < 2; i++) await entry(shop, "P1", "V1", { title: "Boot", signedUpAt: daysAgo(40) }); // previous period
  for (let i = 0; i < 5; i++) await entry(shop, "P2", "V2", { title: "Cap", signedUpAt: daysAgo(100) }); // outside both

  const month = await demandSummary(db, shop, range(30));
  assert.deepEqual([month.newCount, month.prevNew, month.growthPct, month.hasComparison], [4, 2, 100, true]);
  assert.equal(month.waiting, 11);
  const narrow = await demandSummary(db, shop, range(7));
  assert.equal(narrow.newCount, 4);
  const series = await signupSeries(db, shop, range(7));
  assert.equal(series.days.reduce((a, d) => a + d.count, 0), 4);
  assert.equal(series.days.find((d) => d.date === daysAgo(3).toISOString().slice(0, 10)).count, 4);

  const custom = parseDemandParams({ from: "2026-10-01", to: "2026-10-15" }, NOW).range;
  assert.equal(custom.custom, true); assert.equal(custom.days, 15);
  assert.equal((await demandSummary(db, shop, custom)).newCount, 4);
});

test("shop isolation: other shops' signups never appear", async () => {
  await entry("d-a.myshopify.com", "P1", "V1", { title: "Mine" });
  await entry("d-b.myshopify.com", "P9", "V9", { title: "Theirs" });
  await entry("d-b.myshopify.com", "P9", "V9", { title: "Theirs" });
  assert.equal((await demandSummary(db, "d-a.myshopify.com", range())).waiting, 1);
});

test("signups store options and re-signup refreshes signedUpAt (so it counts as new interest)", async () => {
  const shop = "d-resign.myshopify.com";
  const v = { variantId: "7", variantTitle: "M", productId: "1", productTitle: "Tee", productHandle: "tee", options: [{ name: "Size", value: "M" }] };
  await addSignup(db, { shop, email: "a@x.com", variant: v });
  const first = await db.waitlistEntry.findFirst({ where: { shop } });
  assert.deepEqual(JSON.parse(first.optionsJson), [{ name: "Size", value: "M" }]);
  await db.waitlistEntry.update({ where: { id: first.id }, data: { status: "NOTIFIED", signedUpAt: daysAgo(60) } });
  await addSignup(db, { shop, email: "a@x.com", variant: v });
  const again = await db.waitlistEntry.findFirst({ where: { shop } });
  assert.equal(again.status, "ACTIVE");
  assert.ok(Date.now() - again.signedUpAt.getTime() < 60000, "signedUpAt reset to now");
  assert.equal(again.createdAt.getTime(), first.createdAt.getTime());
});

test("query params: invalid input falls back safely", () => {
  const p = parseDemandParams({ period: "9999", from: "garbage", to: "2026-10-01" }, NOW);
  assert.equal(p.range.days, 30); assert.equal(p.range.custom, false);
  assert.equal(parseDemandParams({ period: "7" }, NOW).range.days, 7);
  assert.equal(parseDemandParams({ from: "2026-10-10", to: "2026-10-01" }, NOW).range.custom, false);
});
