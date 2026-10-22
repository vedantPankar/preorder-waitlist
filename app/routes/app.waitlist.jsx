import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useNavigate, useRouteError, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getEmailStatus, getShopMailer } from "../lib/shop-mailer.server";
import { resumePending } from "../lib/webhooks.server";
import { demandSummary, parseDemandParams } from "../lib/demand.server";
import { Badge, Banner, Button, Card, Field, Icon, Pager, PageHead, Shell, Stat, Delta, Svg, Thumb, entryLabel, entryTone, shortDate } from "../ui/ui.jsx";
import { deleteEntries, listEntries, purgeExpired, removeEntries, retryFailed } from "../lib/waitlist.server";

const PAGE_SIZE = 25;

// "YYYY-MM-DD" (UTC) → Date; `plusDays` makes an exclusive end bound for an inclusive "to" date.
const dateParam = (v, plusDays = 0) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || "")) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getTime() + plusDays * 86400000);
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const settings = await db.shopSettings.findUnique({ where: { shop: session.shop } });
  await purgeExpired(db, session.shop, settings?.retentionDays ?? 90);
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const result = await listEntries(db, session.shop, {
    search: url.searchParams.get("q") || "",
    status: url.searchParams.get("status") || "",
    product: url.searchParams.get("product") || "",
    variant: url.searchParams.get("variant") || "",
    from: dateParam(url.searchParams.get("from")),
    to: dateParam(url.searchParams.get("to"), 1),
    page,
    pageSize: PAGE_SIZE,
  });
  const { range } = parseDemandParams({ period: "30" });
  const [summary, mailerOk] = [await demandSummary(db, session.shop, range), (await getEmailStatus(db, session.shop)).configured];
  return { ...result, page, shop: session.shop, summary, mailerOk };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") === "send_pending") {
    const mailer = await getShopMailer(db, session.shop, { admin });
    if (!mailer) return { error: "Gmail is not connected, so nothing can be sent." };
    const r = await resumePending({ db, shop: session.shop, admin, mailer });
    return { ok: true, intent: "send_pending", count: r.sent, remaining: r.remaining, failed: r.failed };
  }
  const ids = form.getAll("ids").map(String).slice(0, 200);
  const intent = form.get("intent");
  if (!ids.length) return { error: "Select at least one entry." };
  let count = 0;
  if (intent === "remove") count = await removeEntries(db, session.shop, ids);
  else if (intent === "delete") count = await deleteEntries(db, session.shop, ids);
  else if (intent === "retry") count = await retryFailed(db, session.shop, ids);
  else return { error: "Unknown action." };
  return { ok: true, intent, count };
};

export default function Waitlist() {
  const { entries, total, page, pageSize, summary, mailerOk } = useLoaderData();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [selected, setSelected] = useState([]);
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.ok) {
      shopify.toast.show(
        fetcher.data.intent === "send_pending"
          ? `${fetcher.data.count} sent, ${fetcher.data.remaining} still pending${fetcher.data.failed ? `, ${fetcher.data.failed} failed` : ""}`
          : `${fetcher.data.count} entr${fetcher.data.count === 1 ? "y" : "ies"} updated`,
      );
      setSelected([]);
    }
  }, [fetcher.data, shopify]);

  const apply = (event) => {
    event.preventDefault();
    const next = new URLSearchParams();
    for (const [k, v] of new FormData(event.currentTarget)) if (v) next.set(k, String(v));
    navigate(`?${next}`);
  };
  const act = (intent, ids = selected) => {
    if (intent === "delete" && !window.confirm("Permanently delete the selected entries?")) return;
    const data = new FormData();
    data.set("intent", intent);
    ids.forEach((id) => data.append("ids", id));
    fetcher.submit(data, { method: "POST" });
  };
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const goPage = (n) => {
    const next = new URLSearchParams(params);
    next.set("page", String(n));
    navigate(`?${next}`);
  };
  const filtered = ["q", "status", "product", "variant", "from", "to"].some((k) => params.get(k));
  const allOnPage = entries.length > 0 && entries.every((e) => selected.includes(e.id));
  const sendButton = (
    <Button primary disabled={busy || !mailerOk} onClick={() => fetcher.submit({ intent: "send_pending" }, { method: "POST" })}>
      <Svg name="send" /> Send pending notifications
    </Button>
  );

  return (
    <Shell>
      <PageHead title="Waitlist" subtitle="Manage customers waiting for products to be back in stock">{sendButton}</PageHead>
      {!mailerOk && <Banner tone="warning" title="Gmail is not connected" action={<Button href="/app/settings#gmail-setup">Connect Gmail</Button>}>Pending notifications cannot be sent until Gmail is connected.</Banner>}
      {fetcher.data?.error && <Banner tone="critical">{fetcher.data.error}</Banner>}

      <div className="wp-stats">
        <Stat icon="users" label="Total waiting customers" value={summary.waiting} delta={<Delta summary={summary} label="vs previous 30 days" />} />
        <Stat icon="box" tone="blue" label="Products in waitlist" value={summary.productsWithDemand} />
        <Stat icon="tag" tone="purple" label="Variants in waitlist" value={summary.variantsWithDemand} />
        <Stat icon="users" tone="amber" label="New signups (30d)" value={summary.newCount} />
      </div>

      <Card>
        <form key={params.toString()} className="wp-filters" onSubmit={apply}>
          <Field label="Search" grow><input name="q" defaultValue={params.get("q") || ""} placeholder="Search by email or product name" /></Field>
          <Field label="Status">
            <select name="status" defaultValue={params.get("status") || ""}>
              <option value="">All statuses</option>
              <option value="WAITING">Waiting</option>
              <option value="NOTIFIED">Notified</option>
              <option value="FAILED">Failed</option>
              <option value="REMOVED">Removed</option>
            </select>
          </Field>
          <Field label="Product"><input name="product" defaultValue={params.get("product") || ""} placeholder="Search product name" /></Field>
          <Field label="Variant"><input name="variant" defaultValue={params.get("variant") || ""} placeholder="e.g. Large / Red" /></Field>
          <Field label="From"><input type="date" name="from" defaultValue={params.get("from") || ""} /></Field>
          <Field label="To"><input type="date" name="to" defaultValue={params.get("to") || ""} /></Field>
          <Button onClick={() => navigate("?")}>Reset</Button>
          <button type="submit" className="wp-btn primary">Apply filters</button>
        </form>
      </Card>

      <Card flush>
        <div className="wp-card-head wp-pad" style={{ marginBottom: 0 }}>
          <h2>{total} customer{total === 1 ? "" : "s"}</h2>
          <div className="wp-head-actions">
            <span className="wp-muted" style={{ alignSelf: "center" }}>{selected.length} selected</span>
            <Button disabled={!selected.length || busy} onClick={() => act("retry")}>Retry failed</Button>
            <Button disabled={!selected.length || busy} onClick={() => act("remove")}>Remove</Button>
            <Button danger disabled={!selected.length || busy} onClick={() => act("delete")}>Delete</Button>
          </div>
        </div>
        {entries.length === 0 ? (
          <div className="wp-empty">
            {filtered ? "No entries match these filters." : "No signups yet. They will appear here once customers use the waitlist button on a sold-out product."}
          </div>
        ) : (
          <div className="wp-table-wrap">
            <table className="wp-table">
              <thead>
                <tr>
                  <th><input type="checkbox" aria-label="Select all on this page" checked={allOnPage} onChange={() => setSelected(allOnPage ? [] : entries.map((e) => e.id))} /></th>
                  <th>Email</th><th>Product</th><th>Variant</th><th>Status</th><th>Signed up</th><th><span className="wp-visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td><input type="checkbox" aria-label={`Select ${e.email}`} checked={selected.includes(e.id)} onChange={() => toggle(e.id)} /></td>
                    <td>{e.email}</td>
                    <td>
                      <div className="wp-prod"><Thumb /><div><strong>{e.productTitle}</strong><span className="wp-muted">ID {e.productId}</span></div></div>
                    </td>
                    <td>{e.variantTitle || "—"}</td>
                    <td><Badge tone={entryTone[e.status]}>{entryLabel(e.status)}</Badge>{e.lastError ? <span className="wp-muted"> {e.lastError}</span> : null}</td>
                    <td>{shortDate(e.signedUpAt ?? e.createdAt)}</td>
                    <td>
                      <details className="wp-menu">
                        <summary aria-label={`Actions for ${e.email}`}>⋯</summary>
                        <div>
                          {e.status === "FAILED" && <Button disabled={busy} onClick={() => act("retry", [e.id])}>Retry</Button>}
                          <Button disabled={busy || e.status === "SENDING"} onClick={() => act("remove", [e.id])}>Remove</Button>
                          <Button danger disabled={busy} onClick={() => act("delete", [e.id])}>Delete</Button>
                        </div>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} total={total} size={pageSize} onPage={goPage} noun="customers" />
      </Card>

      <div className="wp-banner success">
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Icon name="mail" size="sm" />
          <div><strong>Send pending notifications</strong>Notify customers when the product is back in stock. Sending also happens automatically when inventory rises.</div>
        </div>
        {sendButton}
      </div>
    </Shell>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers = (h) => boundary.headers(h);
