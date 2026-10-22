// Demand Intelligence: read-only analytics over real waitlist data. Nothing here
// invents sales, conversion rates or history; every number is a count of
// WaitlistEntry rows (scoped to the shop) or an arithmetic rule documented below.
//
// "Waiting" = entries with status ACTIVE or SENDING (customers who asked to be
// told and have not been notified or removed).
// "New signups" = entries whose signedUpAt falls in the period, any status except REMOVED.
// Demand score = waiting + new signups in the period. It rewards both the size of the
// queue and recent momentum, and is shown next to the raw numbers it is built from.

export const WAITING = ["ACTIVE", "SENDING"];
export const PERIODS = [7, 30, 90];
export const SORTS = ["score", "waiting", "new", "growth", "title"];
const DAY = 86400000;
const MAX_SERIES_ROWS = 50000;

const startOfUtcDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const parseDay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v ?? "") && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? new Date(`${v}T00:00:00Z`) : null);

/** Normalises query-string input; invalid values fall back to safe defaults. */
export function parseDemandParams(params, now = new Date()) {
  const get = (k) => (typeof params?.get === "function" ? params.get(k) : params?.[k]) ?? "";
  const todayEnd = new Date(startOfUtcDay(now).getTime() + DAY);
  let from = parseDay(get("from"));
  let to = parseDay(get("to"));
  let days = Number(get("period"));
  let custom = false;
  if (from && to && to >= from && (to.getTime() - from.getTime()) / DAY <= 366) {
    custom = true;
    to = new Date(to.getTime() + DAY); // inclusive end date
    days = Math.round((to.getTime() - from.getTime()) / DAY);
  } else {
    days = PERIODS.includes(days) ? days : 30;
    to = todayEnd;
    from = new Date(to.getTime() - days * DAY);
  }
  const prevTo = from;
  const prevFrom = new Date(from.getTime() - days * DAY);
  const sort = SORTS.includes(get("sort")) ? get("sort") : "score";
  const dir = get("dir") === "asc" ? "asc" : "desc";
  const page = Math.max(1, parseInt(get("page"), 10) || 1);
  return {
    range: { from, to, prevFrom, prevTo, days, custom },
    search: String(get("q")).trim().slice(0, 100),
    variant: String(get("variant")).trim().slice(0, 100),
    sort, dir, page,
  };
}

function entryFilter(shop, { search, variant } = {}) {
  const where = { shop };
  if (search) where.productTitle = { contains: search };
  if (variant) where.variantTitle = { contains: variant };
  return where;
}

/** Suggested restock = ceil(waiting x coverage%) + buffer. A merchant rule, not a forecast. */
export function recommendRestock(waiting, { coveragePct = 50, buffer = 0 } = {}) {
  if (!(waiting > 0)) return { waiting: 0, suggested: 0 };
  return { waiting, suggested: Math.ceil((waiting * coveragePct) / 100) + Math.max(0, buffer) };
}

export function explainRecommendation({ coveragePct = 50, buffer = 0 } = {}) {
  return `Suggested units = waiting customers × ${coveragePct}% (rounded up)${buffer ? ` + ${buffer} buffer` : ""}. `
    + "This is a rule you configure in Settings, not a prediction: not every customer on a waitlist will buy.";
}

const growth = (current, previous) => (previous > 0 ? Math.round(((current - previous) / previous) * 100) : null);

export async function demandSummary(db, shop, range) {
  const [waiting, newCount, prevNew, productsWithDemand, variantsWithDemand] = await Promise.all([
    db.waitlistEntry.count({ where: { shop, status: { in: WAITING } } }),
    db.waitlistEntry.count({ where: { shop, status: { not: "REMOVED" }, signedUpAt: { gte: range.from, lt: range.to } } }),
    db.waitlistEntry.count({ where: { shop, status: { not: "REMOVED" }, signedUpAt: { gte: range.prevFrom, lt: range.prevTo } } }),
    db.waitlistEntry.groupBy({ by: ["productId"], where: { shop, status: { in: WAITING } } }),
    db.waitlistEntry.groupBy({ by: ["variantId"], where: { shop, status: { in: WAITING } } }),
  ]);
  return {
    waiting, newCount, prevNew,
    growthPct: growth(newCount, prevNew),
    hasComparison: prevNew > 0,
    productsWithDemand: productsWithDemand.length,
    variantsWithDemand: variantsWithDemand.length,
  };
}

/** Ranked products. Four grouped queries regardless of data size; sorting/paging in memory over the (bounded) product list. */
export async function productDemand(db, shop, { range, search = "", variant = "", sort = "score", dir = "desc", page = 1, pageSize = 10 }) {
  const base = entryFilter(shop, { search, variant });
  const [active, variants, recent, previous] = await Promise.all([
    db.waitlistEntry.groupBy({ by: ["productId", "productTitle"], where: { ...base, status: { in: WAITING } }, _count: { _all: true } }),
    db.waitlistEntry.groupBy({ by: ["productId", "variantId"], where: { ...base, status: { in: WAITING } } }),
    db.waitlistEntry.groupBy({ by: ["productId", "productTitle"], where: { ...base, status: { not: "REMOVED" }, signedUpAt: { gte: range.from, lt: range.to } }, _count: { _all: true } }),
    db.waitlistEntry.groupBy({ by: ["productId"], where: { ...base, status: { not: "REMOVED" }, signedUpAt: { gte: range.prevFrom, lt: range.prevTo } }, _count: { _all: true } }),
  ]);
  const rows = new Map();
  const row = (productId, title) => {
    if (!rows.has(productId)) rows.set(productId, { productId, title, waiting: 0, variantsWaiting: 0, newCount: 0, prevNew: 0 });
    const r = rows.get(productId);
    if (title && !r.title) r.title = title;
    return r;
  };
  for (const g of active) row(g.productId, g.productTitle).waiting += g._count._all;
  for (const g of variants) row(g.productId).variantsWaiting += 1;
  for (const g of recent) row(g.productId, g.productTitle).newCount += g._count._all;
  for (const g of previous) row(g.productId).prevNew += g._count._all;

  let list = [...rows.values()].filter((r) => r.waiting > 0 || r.newCount > 0).map((r) => ({
    ...r,
    score: r.waiting + r.newCount,
    growthPct: growth(r.newCount, r.prevNew),
    hasComparison: r.prevNew > 0,
    growing: r.newCount >= 2 && r.newCount > r.prevNew,
  }));
  const keyOf = { score: (r) => r.score, waiting: (r) => r.waiting, new: (r) => r.newCount, growth: (r) => r.growthPct ?? -Infinity, title: (r) => (r.title ?? "").toLowerCase() }[sort];
  const sign = dir === "asc" ? 1 : -1;
  list.sort((a, b) => (keyOf(a) > keyOf(b) ? 1 : keyOf(a) < keyOf(b) ? -1 : 0) * sign || a.productId.localeCompare(b.productId));
  const total = list.length;
  list = list.slice((page - 1) * pageSize, page * pageSize);
  return { rows: list, total, pageSize, page };
}

/** Per-variant waiting counts with a restock suggestion. */
export async function variantDemand(db, shop, { range, rule, search = "", variant = "", page = 1, pageSize = 10, productId = null }) {
  const where = { ...entryFilter(shop, { search, variant }), status: { in: WAITING }, ...(productId ? { productId } : {}) };
  const [groups, recent] = await Promise.all([
    db.waitlistEntry.groupBy({ by: ["variantId", "productId", "productTitle", "variantTitle"], where, _count: { _all: true } }),
    db.waitlistEntry.groupBy({
      by: ["variantId"], _count: { _all: true },
      where: { ...entryFilter(shop, { search, variant }), status: { not: "REMOVED" }, signedUpAt: { gte: range.from, lt: range.to }, ...(productId ? { productId } : {}) },
    }),
  ]);
  const newBy = new Map(recent.map((g) => [g.variantId, g._count._all]));
  const all = groups
    .map((g) => ({
      variantId: g.variantId, productId: g.productId, productTitle: g.productTitle, variantTitle: g.variantTitle,
      waiting: g._count._all, newCount: newBy.get(g.variantId) ?? 0,
      recommendation: recommendRestock(g._count._all, rule),
    }))
    .sort((a, b) => b.waiting - a.waiting || a.variantId.localeCompare(b.variantId));
  return { rows: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, pageSize, page };
}

/** Option demand (size, colour...) from options captured at signup; older entries are reported as unrecorded. */
export async function optionDemand(db, shop) {
  const groups = await db.waitlistEntry.groupBy({
    by: ["variantId", "optionsJson"], where: { shop, status: { in: WAITING } }, _count: { _all: true },
  });
  const byOption = new Map();
  let unrecorded = 0;
  for (const g of groups) {
    let options = [];
    try { options = g.optionsJson ? JSON.parse(g.optionsJson) : []; } catch { options = []; }
    if (!options.length) { unrecorded += g._count._all; continue; }
    for (const o of options) {
      const key = `${o.name}\u0000${o.value}`;
      const cur = byOption.get(key) ?? { name: o.name, value: o.value, waiting: 0 };
      cur.waiting += g._count._all;
      byOption.set(key, cur);
    }
  }
  const grouped = {};
  for (const o of byOption.values()) (grouped[o.name] ??= []).push({ value: o.value, waiting: o.waiting });
  for (const name of Object.keys(grouped)) grouped[name].sort((a, b) => b.waiting - a.waiting || a.value.localeCompare(b.value));
  return { options: grouped, unrecorded };
}

/** New signups per UTC day, zero-filled. Rows beyond MAX_SERIES_ROWS are ignored (flagged as truncated). */
export async function signupSeries(db, shop, range) {
  const rows = await db.waitlistEntry.findMany({
    where: { shop, status: { not: "REMOVED" }, signedUpAt: { gte: range.from, lt: range.to } },
    select: { signedUpAt: true }, take: MAX_SERIES_ROWS + 1,
  });
  const truncated = rows.length > MAX_SERIES_ROWS;
  const counts = new Map();
  for (const r of rows.slice(0, MAX_SERIES_ROWS)) {
    const key = r.signedUpAt.toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const days = [];
  for (let t = range.from.getTime(); t < range.to.getTime(); t += DAY) {
    const key = new Date(t).toISOString().slice(0, 10);
    days.push({ date: key, count: counts.get(key) ?? 0 });
  }
  return { days, truncated };
}
