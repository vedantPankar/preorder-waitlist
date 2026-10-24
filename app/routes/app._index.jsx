import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getEmailStatus } from "../lib/shop-mailer.server";
import { waitlistCounts } from "../lib/waitlist.server";
import { parseDemandParams, signupSeries } from "../lib/demand.server";
import { listCampaigns } from "../lib/campaign.server";
import { themeLinksFor } from "../lib/theme-links.server";
import { Badge, Banner, BarChart, Button, Card, Icon, Shell, PageHead, Stat, Svg, Thumb, entryLabel, entryTone, shortDate } from "../ui/ui.jsx";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const { range } = parseDemandParams({ period: "30" });
  const [counts, preorderConfigs, preorderUnits, settings, campaigns, series, recent] = await Promise.all([
    waitlistCounts(db, shop),
    db.preorderConfig.count({ where: { shop, enabled: true } }),
    db.preorderConfig.aggregate({ where: { shop, enabled: true }, _sum: { soldCount: true } }),
    db.shopSettings.findUnique({ where: { shop } }),
    listCampaigns(db, shop),
    signupSeries(db, shop, range),
    db.waitlistEntry.findMany({ where: { shop }, orderBy: { signedUpAt: "desc" }, take: 5 }),
  ]);
  const emailStatus = await getEmailStatus(db, shop);
  return {
    series,
    recent: recent.map((e) => ({ id: e.id, email: e.email, product: e.productTitle, variant: e.variantTitle, status: e.status, at: e.signedUpAt ?? e.createdAt })),
    campaignTotal: campaigns.length,
    campaigns: campaigns.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {}),
    counts,
    preorderConfigs,
    themeLinks: themeLinksFor(shop),
    preorderUnits: preorderUnits._sum.soldCount ?? 0,
    emailConfigured: emailStatus.configured, emailProblems: emailStatus.problems,
    lastNotifyError: settings?.lastNotifyError ?? null,
  };
};

export default function Dashboard() {
  const { counts, preorderConfigs, preorderUnits, emailConfigured, emailProblems, lastNotifyError, campaigns, series, recent, campaignTotal, themeLinks } = useLoaderData();
  const waiting = counts.ACTIVE + counts.SENDING;
  const steps = [
    { done: emailConfigured, title: "Connect Gmail", sub: "Enable back-in-stock notifications", href: "/app/settings#gmail-setup" },
    { done: campaignTotal > 0, title: "Create your first campaign", sub: "Set schedule, limits and messaging", href: "/app/campaigns/new" },
  ];
  const doneCount = steps.filter((x) => x.done).length;

  return (
    <Shell>
      <PageHead title="Dashboard" subtitle="Overview of your waitlist, pre-orders and campaigns" />
      {!emailConfigured && (
        <Banner tone="critical" title="Back-in-stock emails are not operational" action={<Button href="/app/settings#gmail-setup">Connect Gmail</Button>}>
          <span>Gmail is not connected, so no notifications are being sent. Customers stay on the waitlist until Gmail is connected.</span>
          <ul>{emailProblems.map((p) => <li key={p}>{p}</li>)}</ul>
        </Banner>
      )}
      {emailConfigured && lastNotifyError === "SEND_FAILURES" && (
        <Banner tone="warning" title="Some notifications failed" action={<Button href="/app/waitlist?status=FAILED">Review failed</Button>}>Review failed entries on the Waitlist page and retry them.</Banner>
      )}

      <div className="wp-stats">
        <Stat icon="users" label="Waitlist" value={waiting} note={`Waiting: ${waiting} · Notified: ${counts.NOTIFIED} · Failed: ${counts.FAILED}`} href="/app/waitlist" linkText="View waitlist" />
        <Stat icon="cart" tone="amber" label="Pre-orders" value={preorderConfigs} note={`Variants enabled · ${preorderUnits} units pre-ordered`} href="/app/preorders" linkText="View pre-orders" />
        <Stat icon="megaphone" tone="purple" label="Active campaigns" value={campaigns.ACTIVE ?? 0} note="Running campaigns" href="/app/campaigns/new" linkText="Create campaign" />
      </div>

      <div style={{ marginBottom: 16 }}>
        <Card title="New signups over time" sub="Last 30 days"><BarChart days={series.days} /></Card>
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
          <a className="wp-quick" href="/app/settings#gmail-setup"><Svg name="mail" /> Connect Gmail</a>
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

      <Card title="Show the buttons on your store" sub="The Pre-order and Notify Me buttons are theme blocks. Add them once to your product page; each variant then shows the right one automatically.">
        <ol className="wp-steps">
          <li>Click <strong>Add Pre-order button</strong>. Your theme editor opens on a product page with the block ready to place.</li>
          <li>Click <strong>Save</strong> in the theme editor.</li>
          <li>Repeat with <strong>Add Waitlist button</strong>, so sold-out variants offer “Notify me”. Place it right below the Pre-order button.</li>
          <li>Open a product in your store to check. Pre-order shows for variants in a live campaign; the waitlist shows for sold-out variants.</li>
        </ol>
        <div className="wp-actions" style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12 }}>
          {themeLinks.preorder && <Button primary href={themeLinks.preorder} target="_top">Add Pre-order button</Button>}
          {themeLinks.waitlist && <Button href={themeLinks.waitlist} target="_top">Add Waitlist button</Button>}
          {themeLinks.editor && <Button href={themeLinks.editor} target="_top">Open the theme editor</Button>}
        </div>
        {themeLinks.pause && <p className="wp-muted" style={{ marginTop: 10 }}>Need to switch the buttons off for a while (for example between launches)? Turn on the pause switch: <a href={themeLinks.pause} target="_top">Pause the buttons</a>. Turn the embed off again in Theme settings, App embeds, to bring them back.</p>}
        <p className="wp-muted" style={{ marginTop: 10 }}>Prefer to place them yourself? In the theme editor, open the product template, choose Add block, then Apps, and pick the block.</p>
      </Card>
    </Shell>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers = (h) => boundary.headers(h);
