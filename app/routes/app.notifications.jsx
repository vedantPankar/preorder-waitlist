/* eslint-disable react/prop-types -- small local presentational components */
import { useEffect } from "react";
import { useFetcher, useLoaderData, useNavigate, useRouteError, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getEmailStatus, getShopMailer } from "../lib/shop-mailer.server";
import { notificationMetrics, retryFailedDeliveries } from "../lib/notify.server";
import { runQueueForShop } from "../lib/queue-runner.server";
import { parseDemandParams } from "../lib/demand.server";

const PAGE_SIZE = 25;
const STATUSES = ["QUEUED", "SENDING", "ACCEPTED", "FAILED", "SKIPPED"];

const mask = (email = "") => {
  const [local, domain] = email.split("@");
  return domain ? `${local.slice(0, 1)}***@${domain}` : "***";
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const { range } = parseDemandParams(url.searchParams);
  const status = STATUSES.includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const where = { shop, ...(status ? { status } : {}) };
  const [metrics, total, deliveries, settings] = await Promise.all([
    notificationMetrics(db, shop, range),
    db.notificationDelivery.count({ where }),
    db.notificationDelivery.findMany({ where, orderBy: { queuedAt: "desc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    db.shopSettings.findUnique({ where: { shop } }),
  ]);
  const entries = deliveries.length
    ? await db.waitlistEntry.findMany({ where: { shop, id: { in: deliveries.map((d) => d.entryId) } }, select: { id: true, email: true, productTitle: true, variantTitle: true } })
    : [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    metrics, total, page, pageSize: PAGE_SIZE, days: range.days, mailer: await getEmailStatus(db, shop), lastError: settings?.lastNotifyError ?? null,
    rows: deliveries.map((d) => {
      const e = byId.get(d.entryId);
      let p = {};
      try { p = d.payload ? JSON.parse(d.payload) : {}; } catch { /* no details */ }
      const fromPayload = d.kind !== "RESTOCK" && p.productTitle;
      return {
        id: d.id, status: d.status, attempts: d.attempts, error: d.lastError, kind: d.kind,
        product: fromPayload ? `${p.productTitle}${p.variantTitle ? ` — ${p.variantTitle}` : ""}` : e ? `${e.productTitle}${e.variantTitle ? ` — ${e.variantTitle}` : ""}` : "(removed)",
        recipient: d.kind === "SHIP_REMINDER" || d.kind === "SHIP_DATE_CHANGE" ? (p.orderName ? `Order ${p.orderName}` : "Pre-order customer") : e ? mask(e.email) : "—",
        queuedAt: d.queuedAt.toISOString(), acceptedAt: d.acceptedAt?.toISOString() ?? null,
        nextAttemptAt: d.status === "QUEUED" ? d.nextAttemptAt.toISOString() : null, clicks: d.clickCount,
      };
    }),
  };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");
  const mailer = await getShopMailer(db, shop, { admin });
  if (!mailer) return { error: "Gmail is not connected or needs attention, so nothing can be sent." };
  if (intent === "retry_failed") await retryFailedDeliveries(db, shop);
  else if (intent !== "process") return { error: "Unknown action." };
  const r = await runQueueForShop({ db, shop, admin, mailer });
  return { ok: true, intent, sent: r.sent, failed: r.failed, retrying: r.retried, remaining: r.remaining };
};

const KINDS = { RESTOCK: "Back in stock", SIGNUP_CONFIRMATION: "Signup confirmation", SHIP_REMINDER: "Ship-date reminder", SHIP_DATE_CHANGE: "Ship-date change" };
const TONES = { QUEUED: "info", SENDING: "info", ACCEPTED: "success", FAILED: "critical", SKIPPED: "neutral" };
const LABELS = { QUEUED: "Queued", SENDING: "Sending", ACCEPTED: "Accepted by Gmail", FAILED: "Failed", SKIPPED: "Skipped" };

export default function Notifications() {
  const d = useLoaderData();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    const r = fetcher.data;
    if (r?.ok) shopify.toast.show(`${r.sent} accepted, ${r.retrying} will retry, ${r.failed} failed, ${r.remaining} still pending`);
  }, [fetcher.data, shopify]);
  const setParam = (k, v) => { const n = new URLSearchParams(params); v ? n.set(k, v) : n.delete(k); n.delete("page"); navigate(`?${n}`); };
  const go = (p) => { const n = new URLSearchParams(params); n.set("page", String(p)); navigate(`?${n}`); };
  const submit = (intent) => fetcher.submit({ intent }, { method: "POST" });

  return (
    <s-page heading="Notification activity">
      <s-button slot="secondary-actions" disabled={busy || !d.mailer.configured} onClick={() => submit("process")}>Process queue now</s-button>
      <s-button slot="secondary-actions" disabled={busy || !d.mailer.configured || d.metrics.failed === 0} onClick={() => submit("retry_failed")}>Retry failed</s-button>

      {!d.mailer.configured && (
        <s-banner tone="critical" heading="Gmail is not ready">
          <s-unordered-list>{d.mailer.problems.map((p) => <s-list-item key={p}>{p}</s-list-item>)}</s-unordered-list>
          <s-paragraph>Fix this in Settings → Send with Gmail. Customers stay on the waitlist until then.</s-paragraph>
        </s-banner>
      )}
      {d.mailer.configured && d.lastError === "SEND_FAILURES" && (
        <s-banner tone="warning" heading="Some sends failed">
          <s-paragraph>Transient failures are retried automatically with increasing delays. Permanent failures can be retried with “Retry failed” once the cause is fixed.</s-paragraph>
        </s-banner>
      )}
      {fetcher.data?.error && <s-banner tone="critical">{fetcher.data.error}</s-banner>}

      <s-section heading={`Last ${d.days} days`}>
        <s-stack direction="inline" gap="large">
          <Metric label="Queued" value={d.metrics.queued} />
          <Metric label="Accepted by Gmail" value={d.metrics.accepted} />
          <Metric label="Failed" value={d.metrics.failed} />
          <Metric label="Waiting / retrying" value={d.metrics.pending} />
          <Metric label="Link clicks" value={d.metrics.clickTrackingEnabled ? d.metrics.clicked : "Tracking off"} />
          <Metric label="Click rate" value={d.metrics.clickRate == null ? "—" : `${d.metrics.clickRate}%`} />
        </s-stack>
        <s-paragraph>
          “Accepted” means Gmail took the message; it is not a guarantee of inbox delivery. Delivery confirmations and purchases
          are not measured: Gmail does not report delivery or opens, and order attribution needs order access this app does not request.
          Click tracking is opt-in under Settings.
        </s-paragraph>
      </s-section>

      <s-section padding="none">
        <s-box padding="base">
          <s-select label="Status" value={params.get("status") || ""} onChange={(e) => setParam("status", e.currentTarget.value)}>
            <s-option value="">All statuses</s-option>
            {STATUSES.map((s) => <s-option key={s} value={s}>{LABELS[s]}</s-option>)}
          </s-select>
        </s-box>
        {d.rows.length === 0 ? (
          <s-box padding="large"><s-paragraph>No notifications yet. They are queued automatically when a sold-out variant with waiting customers is restocked.</s-paragraph></s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Email</s-table-header><s-table-header>Product</s-table-header><s-table-header>Recipient</s-table-header><s-table-header>Status</s-table-header>
              <s-table-header>Attempts</s-table-header><s-table-header>Queued</s-table-header><s-table-header>Accepted</s-table-header><s-table-header>Clicks</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.rows.map((r) => (
                <s-table-row key={r.id}>
                  <s-table-cell>{KINDS[r.kind] ?? r.kind}</s-table-cell>
                  <s-table-cell>{r.product}</s-table-cell>
                  <s-table-cell>{r.recipient}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={TONES[r.status]}>{LABELS[r.status]}</s-badge>
                    {r.error ? <><br /><s-text color="subdued">{r.error}</s-text></> : null}
                    {r.nextAttemptAt ? <><br /><s-text color="subdued">Next try {new Date(r.nextAttemptAt).toLocaleString()}</s-text></> : null}
                  </s-table-cell>
                  <s-table-cell>{r.attempts}</s-table-cell>
                  <s-table-cell>{new Date(r.queuedAt).toLocaleString()}</s-table-cell>
                  <s-table-cell>{r.acceptedAt ? new Date(r.acceptedAt).toLocaleString() : "—"}</s-table-cell>
                  <s-table-cell>{r.clicks}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
      {d.total > d.pageSize && (
        <s-stack direction="inline" gap="base" justifyContent="center">
          <s-button disabled={d.page <= 1} onClick={() => go(d.page - 1)}>Previous</s-button>
          <s-text>Page {d.page} of {Math.ceil(d.total / d.pageSize)}</s-text>
          <s-button disabled={d.page * d.pageSize >= d.total} onClick={() => go(d.page + 1)}>Next</s-button>
        </s-stack>
      )}
    </s-page>
  );
}

function Metric({ label, value }) {
  return (
    <s-stack direction="block" gap="small-300">
      <s-text color="subdued">{label}</s-text>
      <s-heading>{String(value)}</s-heading>
    </s-stack>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers = (h) => boundary.headers(h);
