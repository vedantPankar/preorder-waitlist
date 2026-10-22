// Waitlist counts for the Dashboard, the Waitlist page and the date-range filter of Notification activity.
// Read-only: every number is a count of WaitlistEntry rows (scoped to the shop); nothing is invented.
//
// "Waiting" = entries with status ACTIVE or SENDING (customers who asked to be
// told and have not been notified or removed).
// "New signups" = entries whose signedUpAt falls in the period, any status except REMOVED.

export const WAITING = ["ACTIVE", "SENDING"];
export const PERIODS = [7, 30, 90];
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
  return { range: { from, to, prevFrom, prevTo, days, custom } };
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
