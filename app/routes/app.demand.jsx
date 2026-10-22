import { useLoaderData, useNavigate, useRouteError, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { notificationMetrics } from "../lib/notify.server";
import {
  demandSummary, explainRecommendation, optionDemand, parseDemandParams, productDemand, signupSeries, variantDemand,
} from "../lib/demand.server";

import { Badge, BarChart, Button, Card, Delta, Field, PageHead, Pager, Shell, Stat, Thumb, entryLabel, entryTone, shortDate, variantName } from "../ui/ui.jsx";

const PAGE_SIZE = 10;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const params = parseDemandParams(url.searchParams);
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  const rule = { coveragePct: settings?.restockCoveragePct ?? 50, buffer: settings?.restockBuffer ?? 0 };
  const vpage = Math.max(1, parseInt(url.searchParams.get("vpage") || "1", 10) || 1);
  const { range } = params;
  const [summary, products, variants, options, series, notify, recent] = await Promise.all([
    demandSummary(db, shop, range),
    productDemand(db, shop, { ...params, pageSize: PAGE_SIZE }),
    variantDemand(db, shop, { range, rule, search: params.search, variant: params.variant, page: vpage, pageSize: PAGE_SIZE }),
    optionDemand(db, shop),
    signupSeries(db, shop, range),
    notificationMetrics(db, shop, range),
    db.waitlistEntry.findMany({ where: { shop }, orderBy: { signedUpAt: "desc" }, take: 5 }),
  ]);
  const growing = (await productDemand(db, shop, { range, sort: "growth", pageSize: 200 })).rows.filter((r) => r.growing).slice(0, 5);
  return {
    summary, products, variants, options, series, growing, recent: recent.map((e) => ({ id: e.id, email: e.email, productId: e.productId, product: e.productTitle, variant: e.variantTitle, status: e.status, at: e.signedUpAt ?? e.createdAt })), vpage, notify,
    rule, explanation: explainRecommendation(rule),
    range: { from: range.from.toISOString().slice(0, 10), to: new Date(range.to.getTime() - 1).toISOString().slice(0, 10), days: range.days, custom: range.custom },
    sort: params.sort, dir: params.dir,
  };
};

export default function Demand() {
  const d = useLoaderData();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const setParams = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    if (!("page" in patch)) next.delete("page");
    if (!("vpage" in patch)) next.delete("vpage");
    navigate(`?${next}`);
  };
  const apply = (event) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const custom = f.get("from") || f.get("to");
    const next = new URLSearchParams();
    if (custom) { next.set("from", f.get("from")); next.set("to", f.get("to")); } else if (f.get("period")) next.set("period", f.get("period"));
    for (const k of ["q", "variant", "sort", "dir"]) if (f.get(k)) next.set(k, f.get(k));
    navigate(`?${next}`);
  };
  const empty = d.summary.waiting === 0 && d.summary.newCount === 0;
  const days = d.range.days;

  return (
    <Shell>
      <PageHead title="Demand Intelligence" subtitle="Understand customer demand and plan your inventory" />
      <Card title="Filters">
        <form key={params.toString()} className="wp-filters" onSubmit={apply}>
          <Field label="Period">
            <select name="period" defaultValue={d.range.custom ? "" : String(days)}>
              <option value="">Custom range</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option>
            </select>
          </Field>
          <Field label="From"><input type="date" name="from" defaultValue={d.range.custom ? d.range.from : ""} /></Field>
          <Field label="To"><input type="date" name="to" defaultValue={d.range.custom ? d.range.to : ""} /></Field>
          <Field label="Product"><input name="q" defaultValue={params.get("q") || ""} placeholder="Search product name" /></Field>
          <Field label="Variant"><input name="variant" defaultValue={params.get("variant") || ""} placeholder="e.g. Large / Red" /></Field>
          <Field label="Sort products by">
            <select name="sort" defaultValue={d.sort}>
              <option value="score">Demand score</option><option value="waiting">Waiting customers</option><option value="new">New signups</option><option value="growth">Growth</option><option value="title">Product name</option>
            </select>
          </Field>
          <Field label="Order">
            <select name="dir" defaultValue={d.dir}><option value="desc">High to low</option><option value="asc">Low to high</option></select>
          </Field>
          <Button onClick={() => navigate("?")}>Reset</Button>
          <button type="submit" className="wp-btn primary">Apply filters</button>
        </form>
        <p className="wp-muted" style={{ marginTop: 8 }}>Showing {d.range.from} to {d.range.to} ({days} days). Dates are in UTC.</p>
      </Card>

      <div className="wp-stats">
        <Stat icon="users" label="Customers waiting" value={d.summary.waiting} delta={<Delta summary={d.summary} label={`vs previous ${days} days`} />} />
        <Stat icon="cart" tone="blue" label="Products with waiting customers" value={d.summary.productsWithDemand} />
        <Stat icon="box" tone="purple" label="Variants with waiting customers" value={d.summary.variantsWithDemand} />
        <Stat icon="send" tone="amber" label={`New signups (${days}d)`} value={d.summary.newCount} />
      </div>

      {empty && (
        <Card title="No demand data yet">
          <p>Demand appears here once customers join a waitlist. Add the “Waitlist button” block to your product template and open a sold-out product. Nothing on this page is estimated or sample data.</p>
        </Card>
      )}

      <div className="wp-grid-2" style={{ marginBottom: 16 }}>
        <Card title="New signups over time" sub={`Last ${days} days`}>
          <BarChart days={d.series.days} />
          {d.series.truncated && <p className="wp-muted">Very large period: only the first 50,000 signups are charted.</p>}
        </Card>
        <Card title="Product demand" action={<a href="/app/waitlist">View all</a>} flush>
          {d.products.rows.length === 0 ? <div className="wp-empty">No products match these filters.</div> : (
            <div className="wp-table-wrap">
              <table className="wp-table">
                <thead><tr><th>Product</th><th className="num">Waiting</th><th className="num">Variants waiting</th><th className="num">New ({days}d)</th><th className="num">Demand score</th></tr></thead>
                <tbody>
                  {d.products.rows.map((r) => (
                    <tr key={r.productId}>
                      <td><div className="wp-prod"><Thumb /><div><strong>{r.title}</strong><span className="wp-muted">ID {r.productId}</span></div></div></td>
                      <td className="num">{r.waiting}</td><td className="num">{r.variantsWaiting}</td><td className="num">{r.newCount}</td>
                      <td className="num"><strong>{r.score}</strong>{r.growing ? <> <Badge tone="success">Growing</Badge></> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager page={d.products.page} total={d.products.total} size={d.products.pageSize} onPage={(n) => setParams({ page: String(n) })} noun="products" />
          <p className="wp-muted wp-pad" style={{ paddingTop: 0 }}>Demand score = customers waiting + new signups in the selected period (counts of real signups only).</p>
        </Card>
      </div>

      <div className="wp-grid-2" style={{ marginBottom: 16 }}>
        <Card title="Restock recommendations" flush>
          <div className="wp-pad" style={{ paddingBottom: 0 }}>
            <div className="wp-banner info" style={{ marginBottom: 0 }}>
              <div>{d.explanation} Waiting customers are actual demand; the suggested quantity is an estimate from that rule. Check your current inventory before ordering. <a href="/app/settings">Change the rule</a></div>
            </div>
          </div>
          {d.variants.rows.length === 0 ? <div className="wp-empty">No variants have waiting customers.</div> : (
            <div className="wp-table-wrap" style={{ marginTop: 12 }}>
              <table className="wp-table">
                <thead><tr><th>Variant</th><th className="num">Waiting (actual)</th><th className="num">New ({days}d)</th><th className="num">Suggested restock (estimate)</th></tr></thead>
                <tbody>
                  {d.variants.rows.map((r) => (
                    <tr key={r.variantId}><td>{variantName(r.productTitle, r.variantTitle)}</td><td className="num">{r.waiting}</td><td className="num">{r.newCount}</td><td className="num"><strong>{r.recommendation.suggested} units</strong></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager page={d.vpage} total={d.variants.total} size={d.variants.pageSize} onPage={(n) => setParams({ vpage: String(n) })} noun="variants" />
        </Card>
        <div className="wp-stack">
          <Card title="Restock notification results">
            {d.notify.queued === 0 ? <p className="wp-muted">No restock emails were queued in this period, so there are no results to show.</p> : (
              <>
                <div className="wp-pills">
                  <Badge>Queued {d.notify.queued}</Badge><Badge tone="success">Accepted by Gmail {d.notify.accepted}</Badge>
                  <Badge tone={d.notify.failed ? "critical" : ""}>Failed {d.notify.failed}</Badge>
                  <Badge>{d.notify.clickTrackingEnabled ? `Link clicks ${d.notify.clicked}` : "Click tracking off"}</Badge>
                </div>
                <p className="wp-muted" style={{ marginTop: 8 }}>
                  Accepted is not the same as delivered or opened. Purchases cannot be attributed to a notification with the data this app has, so no conversion rate is shown. <a href="/app/notifications">Notification activity</a>
                </p>
              </>
            )}
          </Card>
          <Card title="Requested sizes, colours and options">
            {Object.keys(d.options.options).length === 0 ? (
              <p className="wp-muted">No option data yet. Options are recorded for signups made after this feature was added{d.options.unrecorded ? ` (${d.options.unrecorded} earlier signups have none)` : ""}.</p>
            ) : (
              <div className="wp-stack">
                {Object.entries(d.options.options).map(([name, values]) => (
                  <div key={name}><strong>{name}</strong>
                    <div className="wp-pills" style={{ marginTop: 6 }}>{values.slice(0, 12).map((v) => <Badge key={v.value}>{v.value}: {v.waiting}</Badge>)}</div>
                  </div>
                ))}
                {d.options.unrecorded > 0 && <p className="wp-muted">{d.options.unrecorded} earlier signups have no recorded options.</p>}
              </div>
            )}
          </Card>
          {d.growing.length > 0 && (
            <Card title="Growing interest" sub="At least 2 new signups, more than the previous period">
              <ul className="wp-list">{d.growing.map((g) => <li key={g.productId}><span className="grow">{g.title}</span><Badge tone="success">{g.newCount} new (was {g.prevNew})</Badge></li>)}</ul>
            </Card>
          )}
        </div>
      </div>

      <Card title="Recent signups" action={<a href="/app/waitlist">View all</a>} flush>
        {d.recent.length === 0 ? <div className="wp-empty">No signups yet.</div> : (
          <div className="wp-table-wrap">
            <table className="wp-table">
              <thead><tr><th>Customer</th><th>Product</th><th>Variant</th><th>Type</th><th>Status</th><th>Date</th></tr></thead>
              <tbody>
                {d.recent.map((e) => (
                  <tr key={e.id}>
                    <td>{e.email}</td>
                    <td><div className="wp-prod"><Thumb /><div><strong>{e.product}</strong><span className="wp-muted">ID {e.productId}</span></div></div></td>
                    <td>{e.variant || "—"}</td><td>Waitlist signup</td>
                    <td><Badge tone={entryTone[e.status]}>{entryLabel(e.status)}</Badge></td><td>{shortDate(e.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Shell>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers = (h) => boundary.headers(h);
