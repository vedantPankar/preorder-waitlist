import { useEffect } from "react";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { Badge, Banner, Button, Card, PageHead, Shell, Stat, Svg } from "../ui/ui.jsx";
import { deleteCampaign, listCampaigns, reconcileShop, setCampaignState } from "../lib/campaign.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  // Apply any start/end that passed since the last visit before showing statuses.
  try { await reconcileShop(db, admin, session.shop); } catch (e) { console.error("Campaign reconcile failed:", e?.message); }
  const rows = await listCampaigns(db, session.shop);
  return {
    rows: rows.map((r) => ({
      id: r.campaign.id, name: r.campaign.name, status: r.status, variants: r.variants, sold: r.sold, held: r.held, limit: r.limit, waiting: r.waiting,
      target: r.campaign.targetUnits,
      starts: r.campaign.startsAt?.toISOString().slice(0, 10) ?? null,
      ends: r.campaign.endsAt ? new Date(r.campaign.endsAt.getTime() - 1).toISOString().slice(0, 10) : null,
      shipDate: r.campaign.shipDate?.toISOString().slice(0, 10) ?? null,
      state: r.campaign.state,
    })),
  };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const id = String(form.get("id") || "");
  const intent = String(form.get("intent") || "");
  try {
    if (intent === "delete") return (await deleteCampaign(db, admin, session.shop, id)) ? { ok: true, message: "Campaign deleted" } : { error: "Campaign not found." };
    const r = await setCampaignState(db, admin, session.shop, id, intent);
    return r.errors ? { error: r.errors.form } : { ok: true, message: "Campaign updated" };
  } catch (error) {
    console.error("Campaign action failed:", error?.message);
    return { error: "Shopify rejected the change. Please try again." };
  }
};

const TONES = { DRAFT: "", SCHEDULED: "info", ACTIVE: "success", PAUSED: "warn", SOLD_OUT: "critical", COMPLETED: "" };
const LABELS = { DRAFT: "Draft", SCHEDULED: "Scheduled", ACTIVE: "Active", PAUSED: "Paused", SOLD_OUT: "Sold out", COMPLETED: "Completed" };

export default function Campaigns() {
  const { rows } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  useEffect(() => { if (fetcher.data?.ok) shopify.toast.show(fetcher.data.message); }, [fetcher.data, shopify]);
  const post = (data) => fetcher.submit(data, { method: "POST" });
  const count = (st) => rows.filter((r) => r.status === st).length;

  return (
    <Shell>
      <PageHead title="Campaigns" subtitle="Schedule pre-order launches with limits, a countdown and a progress bar">
        <Button primary href="/app/campaigns/new"><Svg name="calendar" /> Create campaign</Button>
      </PageHead>
      {fetcher.data?.error && <Banner tone="critical">{fetcher.data.error}</Banner>}
      <div className="wp-stats">
        <Stat icon="megaphone" label="Total campaigns" value={rows.length} />
        <Stat icon="circleCheck" label="Active" value={count("ACTIVE")} note="Running now" />
        <Stat icon="calendar" tone="blue" label="Scheduled" value={count("SCHEDULED")} note="Not started yet" />
        <Stat icon="cart" tone="amber" label="Units pre-ordered" value={rows.reduce((a, r) => a + r.sold, 0)} note={`${rows.reduce((a, r) => a + r.held, 0)} on hold`} />
      </div>
      <Banner tone="info" title="How limits are enforced">
        Units sold are counted from Shopify inventory (verified). Customers using the pre-order button take a short, atomic hold on units before checkout, so simultaneous shoppers cannot over-reserve.
        Shopify’s own checkout is not gated by this app, so a customer who bypasses the pre-order button can still exceed a limit until selling is switched off automatically after the next inventory update.
      </Banner>
      <Card flush>
        {rows.length === 0 ? (
          <div className="wp-empty">
            <p>No campaigns yet. A campaign groups variants with a schedule, shipping date, limit and optional countdown and progress bar.</p>
            <p style={{ marginTop: 12 }}><Button primary href="/app/campaigns/new">Create your first campaign</Button></p>
          </div>
        ) : (
          <div className="wp-table-wrap">
            <table className="wp-table">
              <thead><tr><th>Campaign</th><th>Status</th><th>Dates</th><th>Sold / limit</th><th className="num">On hold</th><th className="num">Waiting list</th><th>Actions</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const cap = r.target || r.limit;
                  return (
                    <tr key={r.id}>
                      <td><a href={`/app/campaigns/${r.id}`}><strong>{r.name}</strong></a><span className="wp-muted" style={{ display: "block" }}>{r.variants} variant(s) · ships {r.shipDate ?? "—"}</span></td>
                      <td><Badge tone={TONES[r.status]}>{LABELS[r.status]}</Badge></td>
                      <td>{r.starts ?? "Now"} → {r.ends ?? "No end"}</td>
                      <td style={{ minWidth: 150 }}>
                        {r.sold}{r.limit != null ? ` / ${r.limit}` : ""}{r.target ? ` (goal ${r.target})` : ""}
                        {cap ? <div className="wp-progress"><progress max={cap} value={Math.min(r.sold, cap)} aria-label={`${r.sold} of ${cap} pre-ordered`} /></div> : null}
                      </td>
                      <td className="num">{r.held}</td><td className="num">{r.waiting}</td>
                      <td>
                        <div className="wp-head-actions">
                          <Button href={`/app/campaigns/${r.id}`}>Edit</Button>
                          {r.state === "DRAFT" && <Button primary disabled={busy} onClick={() => post({ intent: "publish", id: r.id })}>Publish</Button>}
                          {r.state === "PUBLISHED" && <Button disabled={busy} onClick={() => post({ intent: "pause", id: r.id })}>Pause</Button>}
                          {r.state === "PAUSED" && <Button disabled={busy} onClick={() => post({ intent: "resume", id: r.id })}>Resume</Button>}
                          <Button danger disabled={busy} onClick={() => { if (window.confirm("Delete this campaign? Variants return to their original inventory setting.")) post({ intent: "delete", id: r.id }); }}>Delete</Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
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
