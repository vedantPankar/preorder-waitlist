import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { Badge, Banner, Button, Card, Field, PageHead, Pager, Shell, Stat, Svg, Thumb, Toggle } from "../ui/ui.jsx";
import { removeConfig, saveConfigs, setEnabled } from "../lib/preorder.server";
import { formDefaults } from "../lib/settings.server";
import { toNumericId } from "../lib/validation.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [configs, settings] = await Promise.all([
    db.preorderConfig.findMany({ where: { shop: session.shop }, orderBy: { updatedAt: "desc" } }),
    db.shopSettings.findUnique({ where: { shop: session.shop } }),
  ]);
  return {
    defaults: formDefaults(settings),
    configs: configs.map((c) => ({
      id: c.id, productId: c.productId, product: c.productTitle, variant: c.variantTitle || "Default Title", title: `${c.productTitle}${c.variantTitle ? ` — ${c.variantTitle}` : ""}`,
      campaignId: c.campaignId, enabled: c.enabled, buttonText: c.buttonText, shipDate: c.shipDate?.toISOString().slice(0, 10) ?? "", maxQuantity: c.maxQuantity,
    })),
  };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");
  try {
    if (intent === "save") {
      const variantIds = [...new Set(form.getAll("variantId").map(toNumericId).filter(Boolean))].slice(0, 50);
      if (!variantIds.length) return { errors: { variants: "Choose at least one variant." } };
      const result = await saveConfigs(db, admin, shop, variantIds, {
        buttonText: form.get("buttonText"), shipDate: form.get("shipDate"),
        maxQuantity: form.get("maxQuantity"), enabled: form.get("enabled") !== "false",
      });
      return result.errors ? { errors: result.errors } : { ok: true, message: `${result.saved} variant(s) saved` };
    }
    if (intent === "toggleMany" || intent === "removeMany") {
      const ids = [...new Set(form.getAll("id").map(String))].slice(0, 100);
      let done = 0;
      for (const id of ids) {
        const ok = intent === "removeMany" ? await removeConfig(db, admin, shop, id) : await setEnabled(db, admin, shop, id, form.get("enabled") === "true");
        if (ok) done += 1;
      }
      const skipped = ids.length - done;
      return done ? { ok: true, message: `${done} variant(s) updated${skipped ? `, ${skipped} skipped (campaign-managed or not found)` : ""}` } : { errors: { form: "Nothing was changed. Campaign-managed variants are changed on the Campaigns page." } };
    }
    const id = String(form.get("id") || "");
    if (await db.preorderConfig.count({ where: { id, shop, campaignId: { not: null } } })) return { errors: { form: "This variant is managed by a campaign. Change it on the Campaigns page." } };
    if (intent === "toggle") return (await setEnabled(db, admin, shop, id, form.get("enabled") === "true")) ? { ok: true, message: "Updated" } : { errors: { form: "Not found." } };
    if (intent === "remove") return (await removeConfig(db, admin, shop, id)) ? { ok: true, message: "Removed" } : { errors: { form: "Not found." } };
  } catch (error) {
    console.error("Product configuration failed:", error?.message);
    return { errors: { form: "Shopify rejected the change. Please try again." } };
  }
  return { errors: { form: "Unknown action." } };
};

const PAGE = 8;
const day = (v) => v || null;

function groupByProduct(configs) {
  const map = new Map();
  for (const c of configs) {
    const g = map.get(c.productId) ?? { productId: c.productId, title: c.product, items: [] };
    g.items.push(c);
    map.set(c.productId, g);
  }
  return [...map.values()].map((g) => {
    const dates = [...new Set(g.items.map((i) => day(i.shipDate)))];
    const limits = [...new Set(g.items.map((i) => i.maxQuantity))];
    return {
      ...g, ids: g.items.filter((i) => !i.campaignId).map((i) => i.id),
      enabled: g.items.every((i) => i.enabled), someEnabled: g.items.some((i) => i.enabled),
      managed: g.items.every((i) => i.campaignId), buttonText: g.items[0].buttonText,
      shipDate: dates.length === 1 ? dates[0] : "Varies", limit: limits.length === 1 ? limits[0] : "Varies",
    };
  });
}

export default function Products() {
  const { configs } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [picked, setPicked] = useState([]);
  const [tab, setTab] = useState("products");
  const [f, setF] = useState({ q: "", status: "", sort: "az" });
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState([]);
  const busy = fetcher.state !== "idle";
  const errors = fetcher.data?.errors ?? {};

  useEffect(() => {
    if (fetcher.data?.ok) {
      shopify.toast.show(fetcher.data.message);
      setPicked([]);
      setSel([]);
    }
  }, [fetcher.data, shopify]);

  const products = useMemo(() => groupByProduct(configs), [configs]);
  const rows = useMemo(() => {
    const list = tab === "products"
      ? products.map((g) => ({ key: g.productId, ids: g.ids, name: g.title, sub: `${g.items.length} variant${g.items.length === 1 ? "" : "s"}`, enabled: g.enabled, partial: g.someEnabled && !g.enabled, managed: g.managed, buttonText: g.buttonText, shipDate: g.shipDate, limit: g.limit, campaignId: g.managed ? g.items[0].campaignId : null }))
      : configs.map((c) => ({ key: c.id, ids: c.campaignId ? [] : [c.id], name: c.product, sub: c.variant, enabled: c.enabled, managed: !!c.campaignId, buttonText: c.buttonText, shipDate: c.shipDate, limit: c.maxQuantity, campaignId: c.campaignId }));
    const q = f.q.toLowerCase();
    const out = list.filter((r) => (!q || `${r.name} ${r.sub}`.toLowerCase().includes(q)) && (!f.status || (f.status === "enabled" ? r.enabled : !r.enabled)));
    out.sort((a, b) => (f.sort === "za" ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)));
    return out;
  }, [tab, products, configs, f]);
  const pageRows = rows.slice((page - 1) * PAGE, page * PAGE);
  const enabledCount = configs.filter((c) => c.enabled).length;

  const pick = async () => {
    const selection = await shopify.resourcePicker({ type: "product", multiple: true, filter: { variants: true } });
    if (!selection) return;
    setPicked(selection.flatMap((p) => p.variants.map((v) => ({ id: v.id, title: `${p.title}${v.title && v.title !== "Default Title" ? ` — ${v.title}` : ""}` }))));
  };
  const submit = (event) => {
    event.preventDefault();
    fetcher.submit(new FormData(event.currentTarget), { method: "POST" });
  };
  const many = (intent, ids, enabled) => {
    if (!ids.length) return;
    if (intent === "removeMany" && !window.confirm(`Remove pre-order from ${ids.length} variant(s)? Inventory settings are restored.`)) return;
    const data = new FormData();
    data.set("intent", intent);
    if (enabled !== undefined) data.set("enabled", String(enabled));
    ids.forEach((id) => data.append("id", id));
    fetcher.submit(data, { method: "POST" });
  };
  const set = (k) => (e) => { setF((x) => ({ ...x, [k]: e.target.value })); setPage(1); };
  const selIds = sel.flatMap((k) => rows.find((r) => r.key === k)?.ids ?? []);
  const allShown = pageRows.length > 0 && pageRows.every((r) => sel.includes(r.key));

  return (
    <Shell>
      <PageHead title="Product configuration" subtitle="Enable or disable pre-order for your products and variants">
        <Button primary onClick={pick}><Svg name="box" /> Select products or variants</Button>
      </PageHead>
      {errors.form && <Banner tone="critical">{errors.form}</Banner>}
      <Banner tone="info">
        Pre-orders use Shopify’s normal cart and checkout with full payment at checkout. Enabling a variant lets Shopify sell it while out of stock
        (“continue selling”); this is restored if you disable it.
      </Banner>

      {picked.length > 0 && (
        <Card title="Enable pre-order for the selected variants">
          <form onSubmit={submit} className="wp-stack">
            <input type="hidden" name="intent" value="save" />
            {picked.map((v) => <input key={v.id} type="hidden" name="variantId" value={v.id} />)}
            {errors.variants && <Banner tone="critical">{errors.variants}</Banner>}
            <ul className="wp-list">{picked.map((v) => <li key={v.id}><Thumb /><span className="grow">{v.title}</span></li>)}</ul>
            <s-text-field name="buttonText" label="Button text" defaultValue="Pre-Order Now" maxLength={40} />
            <s-date-field name="shipDate" label="Expected shipping date" error={errors.shipDate} />
            <s-number-field name="maxQuantity" label="Maximum pre-order quantity (optional)" min={1} step={1} error={errors.maxQuantity} details="Leave blank for no limit." />
            <div className="wp-head-actions">
              <button type="submit" className="wp-btn primary" disabled={busy}>Save</button>
              <Button onClick={() => setPicked([])}>Cancel</Button>
            </div>
          </form>
        </Card>
      )}

      <div className="wp-stats">
        <Stat icon="box" label="Total products" value={products.length} note="Products configured" />
        <Stat icon="circleCheck" label="Pre-order enabled" value={enabledCount} note="Variants" />
        <Stat icon="pause" tone="amber" label="Pre-order disabled" value={configs.length - enabledCount} note="Variants" />
        <Stat icon="megaphone" tone="blue" label="Managed by campaigns" value={configs.filter((c) => c.campaignId).length} note="Variants" />
      </div>

      <Card flush>
        <div className="wp-pad">
          <div className="wp-filters">
            <Field label="Search" grow><input value={f.q} onChange={set("q")} placeholder="Search product or variant name" /></Field>
            <Field label="Status">
              <select value={f.status} onChange={set("status")}><option value="">All statuses</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select>
            </Field>
            <Field label="Sort by">
              <select value={f.sort} onChange={set("sort")}><option value="az">Product name (A–Z)</option><option value="za">Product name (Z–A)</option></select>
            </Field>
            <details className="wp-menu">
              <summary className="wp-btn" aria-label="Bulk actions">Bulk actions ▾</summary>
              <div>
                <Button disabled={!selIds.length || busy} onClick={() => many("toggleMany", selIds, true)}>Enable selected</Button>
                <Button disabled={!selIds.length || busy} onClick={() => many("toggleMany", selIds, false)}>Disable selected</Button>
                <Button danger disabled={!selIds.length || busy} onClick={() => many("removeMany", selIds)}>Remove selected</Button>
              </div>
            </details>
          </div>
        </div>
        <div className="wp-tabs" role="tablist">
          {["products", "variants"].map((t) => (
            <button key={t} type="button" role="tab" className="wp-tab" aria-selected={tab === t} onClick={() => { setTab(t); setPage(1); setSel([]); }}>{t === "products" ? "Products" : "Variants"}</button>
          ))}
        </div>
        {rows.length === 0 ? (
          <div className="wp-empty">{configs.length === 0 ? "Nothing configured yet. Select products above to offer pre-orders." : "Nothing matches these filters."}</div>
        ) : (
          <div className="wp-table-wrap">
            <table className="wp-table">
              <thead>
                <tr>
                  <th><input type="checkbox" aria-label="Select all on this page" checked={allShown} onChange={() => setSel(allShown ? [] : pageRows.map((r) => r.key))} /></th>
                  <th>{tab === "products" ? "Product" : "Variant"}</th><th>Pre-order status</th><th>Button text</th><th>Shipping date</th><th>Pre-order limit</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={r.key}>
                    <td><input type="checkbox" aria-label={`Select ${r.name}`} checked={sel.includes(r.key)} onChange={() => setSel((s) => (s.includes(r.key) ? s.filter((x) => x !== r.key) : [...s, r.key]))} /></td>
                    <td><div className="wp-prod"><Thumb /><div><strong>{r.name}</strong><span className="wp-muted">{r.sub}</span></div></div></td>
                    <td>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <Toggle checked={r.enabled} label={`Pre-order for ${r.name}`} disabled={busy || r.managed} onChange={() => many("toggleMany", r.ids, !r.enabled)} />
                        {r.managed ? <Badge tone="info">Campaign</Badge> : r.partial ? "Partly" : r.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </td>
                    <td>{r.buttonText}</td>
                    <td>{r.managed ? "From campaign" : r.shipDate || "—"}</td>
                    <td>{r.managed ? "From campaign" : r.limit == null ? "No limit" : typeof r.limit === "number" ? `${r.limit} units` : r.limit}</td>
                    <td>
                      {r.campaignId ? <a href={`/app/campaigns/${r.campaignId}`}>Open campaign</a> : (
                        <details className="wp-menu">
                          <summary aria-label={`Actions for ${r.name}`}>⋯</summary>
                          <div>
                            <Button disabled={busy} onClick={() => many("toggleMany", r.ids, !r.enabled)}>{r.enabled ? "Disable" : "Enable"}</Button>
                            <Button danger disabled={busy} onClick={() => many("removeMany", r.ids)}>Remove</Button>
                          </div>
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} total={rows.length} size={PAGE} onPage={setPage} noun={tab} />
      </Card>
    </Shell>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers = (h) => boundary.headers(h);
