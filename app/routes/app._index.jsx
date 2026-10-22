import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getEmailStatus } from "../lib/shop-mailer.server";
import { waitlistCounts } from "../lib/waitlist.server";
import { demandSummary, parseDemandParams, productDemand, signupSeries } from "../lib/demand.server";
import { listCampaigns } from "../lib/campaign.server";
import { Badge, Banner, BarChart, Button, Card, Icon, Shell, PageHead, Stat, Svg, Thumb, entryLabel, entryTone, shortDate } from "../ui/ui.jsx";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const { range } = parseDemandParams({ period: "30" });
  const [counts, preorderConfigs, preorderUnits, settings, demand, topProducts, campaigns, series, recent] = await Promise.all([
    waitlistCounts(db, shop),
    db.preorderConfig.count({ where: { shop, enabled: true } }),
    db.preorderConfig.aggregate({ where: { shop, enabled: true }, _sum: { soldCount: true } }),
    db.shopSettings.findUnique({ where: { shop } }),
    demandSummary(db, shop, range),
    productDemand(db, shop, { range, pageSize: 5 }),
    listCampaigns(db, shop),
    signupSeries(db, shop, range),
    db.waitlistEntry.findMany({ where: { shop }, orderBy: { signedUpAt: "desc" }, take: 5 }),
  ]);
  const emailStatus = await getEmailStatus(db, shop);
  return {
    demand, topProducts: topProducts.rows, series,
    recent: recent.map((e) => ({ id: e.id, email: e.email, product: e.productTitle, variant: e.variantTitle, status: e.status, at: e.signedUpAt ?? e.createdAt })),
    campaignTotal: campaigns.length,
    campaigns: campaigns.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {}),
    counts,
    preorderConfigs,
    preorderUnits: preorderUnits._sum.soldCount ?? 0,
    emailConfigured: emailStatus.configured, emailProblems: emailStatus.problems,
    lastNotifyError: settings?.lastNotifyError ?? null,
  };
};

export default function Dashboard() {
  const { counts, preorderConfigs, preorderUnits, emailConfigured, emailProblems, lastNotifyError, demand, topProducts, campaigns, series, recent, campaignTotal } = useLoaderData();
  const waiting = counts.ACTIVE + counts.SENDING;
  const steps = [
    { done: emailConfigured, title: "Configure email provider", sub: "Enable back-in-stock notifications", href: "/app/settings#email-setup" },
    { done: preorderConfigs > 0, title: "Enable pre-order on products", sub: "Select products or variants", href: "/app/products" },
    { done: campaignTotal > 0, title: "Create your first campaign", sub: "Set schedule, limits and messaging", href: "/app/campaigns/new" },
  ];
  const doneCount = steps.filter((x) => x.done).length;

  return (
    <Shell>
      <PageHead title="Dashboard" subtitle="Overview of your waitlist, pre-orders and customer demand" />
      {!emailConfigured && (
        <Banner tone="critical" title="Back-in-stock emails are not operational" action={<Button href="/app/settings#email-setup">Configure email provider</Button>}>
          <span>No email provider is configured, so no notifications are being sent. Customers stay on the waitlist until the email settings are fixed.</span>
          <ul>{emailProblems.map((p) => <li key={p}>{p}</li>)}</ul>
        </Banner>
      )}
      {emailConfigured && lastNotifyError === "SEND_FAILURES" && (
        <Banner tone="warning" title="Some notifications failed" action={<Button href="/app/waitlist?status=FAILED">Review failed</Button>}>Review failed entries on the Waitlist page and retry them.</Banner>
      )}

      <div className="wp-stats">
        <Stat icon="users" label="Waitlist" value={waiting} note={`Waiting: ${waiting} · Notified: ${counts.NOTIFIED} · Failed: ${counts.FAILED}`} href="/app/waitlist" linkText="View waitlist" />
        <Stat icon="chart" tone="blue" label="Demand intelligence" value={demand.waiting} note={`Customers waiting · ${demand.newCount} new signups (30d)`} href="/app/demand" linkText="View details" />
        <Stat icon="cart" tone="amber" label="Pre-orders" value={preorderConfigs} note={`Variants enabled · ${preorderUnits} units pre-ordered`} href="/app/preorders" linkText="View pre-orders" />
        <Stat icon="megaphone" tone="purple" label="Active campaigns" value={campaigns.ACTIVE ?? 0} note="Running campaigns" href="/app/campaigns/new" linkText="Create campaign" />
      </div>

      <div className="wp-grid-2" style={{ marginBottom: 16 }}>
        <Card title="New signups over time" sub="Last 30 days"><BarChart days={series.days} /></Card>
        <Card title="Top products by demand" action={<a href="/app/demand">View all</a>}>
          {topProducts.length === 0 ? <p className="wp-muted">No waitlist demand yet. Add the “Waitlist button” app block to your product template; it appears on sold-out products.</p> : (
            <ul className="wp-list">
              {topProducts.map((p) => (
                <li key={p.productId}>
                  <Thumb />
                  <div className="grow"><strong>{p.title}</strong><div className="wp-muted">ID {p.productId}</div></div>
                  <div style={{ textAlign: "right" }}><div className="wp-muted">Demand score</div><strong>{p.score}</strong>{p.growing && <div className="wp-delta">↑ Growing</div>}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Recent activity" action={<a href="/app/waitlist">View all</a>} flush>
        {recent.length === 0 ? <div className="wp-empty">No signups yet.</div> : (
          <div className="wp-table-wrap">
            <table className="wp-table">
              <thead><tr><th>Customer / Product</th><th>Type</th><th>Status</th><th>Date</th></tr></thead>
              <tbody>
                {recent.map((e) => (
                  <tr key={e.id}>
                    <td><div className="wp-prod"><Thumb /><div><strong>{e.email}</strong><span className="wp-muted">{e.product}{e.variant && e.variant !== "Default Title" ? ` — ${e.variant}` : ""}</span></div></div></td>
                    <td>Waitlist signup</td><td><Badge tone={entryTone[e.status]}>{entryLabel(e.status)}</Badge></td><td>{shortDate(e.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="wp-grid-2 even">
        <Card title="Quick actions">
          <a className="wp-quick" href="/app/waitlist"><Svg name="send" /> Send pending notifications</a>
          <a className="wp-quick" href="/app/campaigns/new"><Svg name="calendar" /> Create pre-order campaign</a>
          <a className="wp-quick" href="/app/settings#email-setup"><Svg name="mail" /> Configure email provider</a>
        </Card>
        <Card title="App setup guide" action={<span className="wp-muted">{doneCount} / {steps.length} completed</span>}>
          <ul className="wp-list">
            {steps.map((x) => (
              <li key={x.title}>
                <span className={`wp-check ${x.done ? "done" : ""}`} aria-label={x.done ? "Done" : "Not done"}>{x.done && <Svg name="check" />}</span>
                <div className="grow"><strong>{x.title}</strong><div className="wp-muted">{x.sub}</div></div>
                <a href={x.href} aria-label={x.title}><Icon name="chevron" size="sm" /></a>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </Shell>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers = (h) => boundary.headers(h);
