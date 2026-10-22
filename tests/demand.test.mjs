import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.mjs";
import { addSignup } from "../app/lib/waitlist.server.js";
import { demandSummary, explainRecommendation, optionDemand, parseDemandParams, productDemand, recommendRestock, signupSeries, variantDemand } from "../app/lib/demand.server.js";

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

test("empty shop: all metrics are zero and lists are empty (no invented data)", async () => {
  const shop = "d-empty.myshopify.com";
  const s = await demandSummary(db, shop, range());
  assert.deepEqual([s.waiting, s.newCount, s.prevNew, s.productsWithDemand], [0, 0, 0, 0]);
  assert.equal(s.hasComparison, false); assert.equal(s.growthPct, null);
  assert.equal((await productDemand(db, shop, { range: range() })).total, 0);
  assert.equal((await variantDemand(db, shop, { range: range(), rule: {} })).total, 0);
  const series = await signupSeries(db, shop, range(7));
  assert.equal(series.days.length, 7); assert.ok(series.days.every((d) => d.count === 0));
  assert.deepEqual(await optionDemand(db, shop), { options: {}, unrecorded: 0 });
});

test("counts, ranking and variant demand are correct; notified/removed are not 'waiting'", async () => {
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

  const p = await productDemand(db, shop, { range: range() });
  assert.deepEqual(p.rows.map((r) => [r.title, r.waiting, r.variantsWaiting]), [["Boot", 7, 2], ["Hat", 3, 1], ["Sock", 1, 1]]);
  assert.equal(p.rows[0].score, 7 + 7); // waiting + new signups in period (documented rule)

  const v = await variantDemand(db, shop, { range: range(), rule: { coveragePct: 50, buffer: 0 } });
  assert.deepEqual(v.rows.map((r) => [r.productTitle, r.variantTitle, r.waiting]), [["Boot", "M", 5], ["Hat", null, 3], ["Boot", "L", 2], ["Sock", null, 1]]);
  assert.equal(v.rows[0].recommendation.suggested, 3); // ceil(5 x 50%)
});

test("date range filtering and previous-period comparison", async () => {
  const shop = "d-range.myshopify.com";
  for (let i = 0; i < 4; i++) await entry(shop, "P1", "V1", { title: "Boot", signedUpAt: daysAgo(3) });  // current 30d period
  for (let i = 0; i < 2; i++) await entry(shop, "P1", "V1", { title: "Boot", signedUpAt: daysAgo(40) }); // previous period
  for (let i = 0; i < 5; i++) await entry(shop, "P2", "V2", { title: "Cap", signedUpAt: daysAgo(100) }); // outside both

  const p = await productDemand(db, shop, { range: range(30) });
  const boot = p.rows.find((r) => r.title === "Boot");
  assert.equal(boot.newCount, 4); assert.equal(boot.prevNew, 2);
  assert.equal(boot.growthPct, 100); assert.equal(boot.hasComparison, true); assert.equal(boot.growing, true);
  const cap = p.rows.find((r) => r.title === "Cap");
  assert.equal(cap.newCount, 0); assert.equal(cap.hasComparison, false); assert.equal(cap.growthPct, null); // not enough data: no % shown
  assert.equal(cap.waiting, 5);

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
  const p = await productDemand(db, "d-a.myshopify.com", { range: range() });
  assert.deepEqual(p.rows.map((r) => r.title), ["Mine"]);
  assert.equal((await demandSummary(db, "d-a.myshopify.com", range())).waiting, 1);
  assert.equal((await variantDemand(db, "d-a.myshopify.com", { range: range(), rule: {} })).total, 1);
});

test("sorting, filtering by product/variant text, pagination", async () => {
  const shop = "d-sort.myshopify.com";
  for (let i = 1; i <= 12; i++) for (let j = 0; j < i; j++) await entry(shop, `P${i}`, `V${i}`, { title: `Item ${String(i).padStart(2, "0")}`, vTitle: i % 2 ? "Red" : "Blue" });
  const top = await productDemand(db, shop, { range: range(), pageSize: 5 });
  assert.equal(top.total, 12); assert.equal(top.rows.length, 5); assert.equal(top.rows[0].title, "Item 12");
  const p3 = await productDemand(db, shop, { range: range(), pageSize: 5, page: 3 });
  assert.equal(p3.rows.length, 2);
  const asc = await productDemand(db, shop, { range: range(), sort: "title", dir: "asc", pageSize: 3 });
  assert.deepEqual(asc.rows.map((r) => r.title), ["Item 01", "Item 02", "Item 03"]);
  const red = await productDemand(db, shop, { range: range(), variant: "Red" });
  assert.equal(red.total, 6);
  const search = await productDemand(db, shop, { range: range(), search: "Item 1" });
  assert.deepEqual(search.rows.map((r) => r.title).sort(), ["Item 10", "Item 11", "Item 12"]);
});

test("size/colour demand comes only from recorded options; older rows are 'unrecorded'", async () => {
  const shop = "d-opt.myshopify.com";
  const med = [{ name: "Size", value: "M" }, { name: "Color", value: "Red" }];
  const lg = [{ name: "Size", value: "L" }, { name: "Color", value: "Red" }];
  for (let i = 0; i < 3; i++) await entry(shop, "P1", "V1", { options: med });
  await entry(shop, "P1", "V2", { options: lg });
  await entry(shop, "P1", "V3"); // signed up before options were recorded
  const r = await optionDemand(db, shop);
  assert.deepEqual(r.options.Size, [{ value: "M", waiting: 3 }, { value: "L", waiting: 1 }]);
  assert.deepEqual(r.options.Color, [{ value: "Red", waiting: 4 }]);
  assert.equal(r.unrecorded, 1);
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

test("restock recommendation: 35 waiting -> rule-based suggestion, clearly a rule not a forecast", () => {
  assert.deepEqual(recommendRestock(35, { coveragePct: 50, buffer: 0 }), { waiting: 35, suggested: 18 });
  assert.deepEqual(recommendRestock(35, { coveragePct: 100, buffer: 5 }), { waiting: 35, suggested: 40 });
  assert.deepEqual(recommendRestock(0, { coveragePct: 50, buffer: 9 }), { waiting: 0, suggested: 0 });
  const text = explainRecommendation({ coveragePct: 50, buffer: 0 });
  assert.match(text, /not a prediction/); assert.match(text, /50%/);
});

test("query params: invalid input falls back safely", () => {
  const p = parseDemandParams({ period: "9999", sort: "DROP TABLE", dir: "x", page: "-4", from: "garbage", to: "2026-10-01" }, NOW);
  assert.equal(p.range.days, 30); assert.equal(p.sort, "score"); assert.equal(p.dir, "desc"); assert.equal(p.page, 1); assert.equal(p.range.custom, false);
  assert.equal(parseDemandParams({ period: "7" }, NOW).range.days, 7);
  assert.equal(parseDemandParams({ from: "2026-10-10", to: "2026-10-01" }, NOW).range.custom, false);
});
