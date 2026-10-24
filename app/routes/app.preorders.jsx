import { useMemo, useState } from "react";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { Badge, Button, Card, Field, PageHead, Pager, Shell, Stat, Svg, Thumb } from "../ui/ui.jsx";
import { effectiveLimit, effectiveShipDate, variantPhase } from "../lib/campaign.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const configs = await db.preorderConfig.findMany({ where: { shop: session.shop }, orderBy: { updatedAt: "desc" } });
  const ids = [...new Set(configs.map((c) => c.campaignId).filter(Boolean))];
  const campaigns = new Map((ids.length ? await db.campaign.findMany({ where: { shop: session.shop, id: { in: ids } } }) : []).map((c) => [c.id, c]));
  const now = new Date();
  return {
    rows: configs.map((c) => {
      const campaign = c.campaignId ? campaigns.get(c.campaignId) : null;
      return {
        id: c.id,
        product: c.productTitle, variant: c.variantTitle || "Default Title",
        enabled: c.enabled,
        phase: variantPhase(c, campaign, now),
        campaign: campaign ? { id: campaign.id, name: campaign.name } : null,
        shipDate: effectiveShipDate(c, campaign)?.toISOString().slice(0, 10) ?? null,
        maxQuantity: effectiveLimit(c, campaign),
        sold: c.soldCount,
        held: c.reservedCount,
      };
    }),
  };
};

const PHASES = { active: "Open", scheduled: "Scheduled", ended: "Ended", sold_out: "Sold out", paused: "Paused", draft: "Draft", disabled: "Disabled" };

const PAGE = 10;

export default function Preorders() {
  const { rows } = useLoaderData();
  const [f, setF] = useState({ q: "", status: "", campaign: "" });
  const [page, setPage] = useState(1);
  const set = (k) => (e) => { setF((x) => ({ ...x, [k]: e.target.value })); setPage(1); };
  const campaigns = useMemo(() => [...new Map(rows.filter((r) => r.campaign).map((r) => [r.campaign.id, r.campaign.name]))], [rows]);
  const shown = rows.filter((r) =>
    (!f.q || `${r.product} ${r.variant}`.toLowerCase().includes(f.q.toLowerCase())) &&
    (!f.status || r.phase === f.status) && (!f.campaign || r.campaign?.id === f.campaign));
  const pageRows = shown.slice((page - 1) * PAGE, page * PAGE);
  const sum = (key) => rows.reduce((a, r) => a + r[key], 0);

  return (
    <Shell>
      <PageHead title="Pre-orders" subtitle="Manage products and variants available for pre-order">
        <Button primary href="/app/campaigns/new"><Svg name="calendar" /> Create campaign</Button>
      </PageHead>
      <div className="wp-stats">
        <Stat icon="box" label="Total variants" value={rows.filter((r) => r.enabled).length} note="Enabled for pre-order" />
        <Stat icon="cart" tone="blue" label="Total pre-ordered units" value={sum("sold")} note="Across all variants" />
        <Stat icon="megaphone" tone="purple" label="Open campaigns" value={new Set(rows.filter((r) => r.campaign && r.phase === "active").map((r) => r.campaign.id)).size} note="Running now" />
        <Stat icon="clock" tone="amber" label="Units on hold" value={sum("held")} note="Reserved before checkout" />
      </div>
      <Card>
        <div className="wp-filters">
          <Field label="Search" grow><input value={f.q} onChange={set("q")} placeholder="Search product or variant name" /></Field>
          <Field label="Status">
            <select value={f.status} onChange={set("status")}>
              <option value="">All statuses</option>
              {Object.entries(PHASES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Campaign">
            <select value={f.campaign} onChange={set("campaign")}>
              <option value="">All campaigns</option>
              {campaigns.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </Field>
          <Button onClick={() => { setF({ q: "", status: "", campaign: "" }); setPage(1); }}>Reset</Button>
        </div>
      </Card>
      <Card flush>
        <div className="wp-card-head wp-pad" style={{ marginBottom: 0 }}><h2>{shown.length} variant{shown.length === 1 ? "" : "s"}</h2></div>
        {shown.length === 0 ? (
          <div className="wp-empty">{rows.length === 0 ? <>No pre-order products yet. <a href="/app/campaigns/new">Create a campaign</a>.</> : "No variants match these filters."}</div>
        ) : (
          <div className="wp-table-wrap">
            <table className="wp-table">
              <thead><tr><th>Product / Variant</th><th>Status</th><th>Campaign</th><th>Ships on</th><th className="num">Pre-ordered</th><th className="num">On hold</th></tr></thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={r.id}>
                    <td><div className="wp-prod"><Thumb /><div><strong>{r.product}</strong><span className="wp-muted">{r.variant}</span></div></div></td>
                    <td><Badge tone={r.phase === "active" ? "success" : r.phase === "sold_out" ? "critical" : r.phase === "scheduled" ? "info" : ""}>{PHASES[r.phase] ?? r.phase}</Badge></td>
                    <td>{r.campaign ? <a href={`/app/campaigns/${r.campaign.id}`}>{r.campaign.name}</a> : "—"}</td>
                    <td>{r.shipDate ?? "—"}</td>
                    <td className="num">{r.sold}{r.maxQuantity ? ` / ${r.maxQuantity}` : ""}</td>
                    <td className="num">{r.held}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} total={shown.length} size={PAGE} onPage={setPage} noun="variants" />
      </Card>
      <p className="wp-muted">
        “On hold” units are short reservations taken by the pre-order button before checkout. Pre-ordered units are counted from negative stock in Shopify,
        so they update when inventory changes. View the orders themselves in Shopify’s Orders list.
      </p>
    </Shell>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers = (h) => boundary.headers(h);
