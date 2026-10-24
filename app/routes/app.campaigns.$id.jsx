import { useEffect, useState } from "react";
import { redirect, useFetcher, useLoaderData, useNavigate, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { Badge, Banner, Button, Card, PageHead, SectionTitle, SettingRow, Shell, Svg, Thumb } from "../ui/ui.jsx";
import { formDefaults } from "../lib/settings.server";
import { campaignStatus, deleteCampaign, saveCampaign, setCampaignState } from "../lib/campaign.server";
import { toNumericId } from "../lib/validation.server";

const day = (d) => (d ? d.toISOString().slice(0, 10) : "");

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  if (params.id === "new") return { isNew: true, campaign: null, variants: [], status: "DRAFT", defaults: formDefaults(await db.shopSettings.findUnique({ where: { shop: session.shop } })) };
  const campaign = await db.campaign.findFirst({ where: { id: params.id, shop: session.shop } });
  if (!campaign) throw new Response("Campaign not found", { status: 404 });
  const configs = await db.preorderConfig.findMany({ where: { shop: session.shop, campaignId: campaign.id }, orderBy: { productTitle: "asc" } });
  return {
    isNew: false,
    status: campaignStatus(campaign, configs),
    campaign: {
      id: campaign.id, name: campaign.name, state: campaign.state,
      startDate: day(campaign.startsAt), endDate: campaign.endsAt ? day(new Date(campaign.endsAt.getTime() - 1)) : "",
      shipDate: day(campaign.shipDate), maxQuantity: campaign.maxQuantity ?? "", targetUnits: campaign.targetUnits ?? "",
      showCountdown: campaign.showCountdown, showProgress: campaign.showProgress, buttonText: configs[0]?.buttonText ?? "Pre-Order Now",
    },
    variants: configs.map((c) => ({ id: c.variantId, title: `${c.productTitle}${c.variantTitle ? ` — ${c.variantTitle}` : ""}`, sold: c.soldCount, held: c.reservedCount })),
  };
};

export const action = async ({ request, params }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") || "save");
  try {
    if (intent === "delete") {
      await deleteCampaign(db, admin, shop, params.id);
      return redirect("/app/campaigns");
    }
    if (intent !== "save") {
      const r = await setCampaignState(db, admin, shop, params.id, intent);
      return r.errors ? { errors: r.errors } : { ok: true, message: "Campaign updated" };
    }
    const variantIds = [...new Set(form.getAll("variantId").map(toNumericId).filter(Boolean))].slice(0, 50);
    const input = Object.fromEntries(["name", "startDate", "endDate", "shipDate", "maxQuantity", "targetUnits", "buttonText", "showCountdown", "showProgress"].map((k) => [k, form.get(k) ?? ""]));
    const r = await saveCampaign(db, admin, shop, { id: params.id === "new" ? null : params.id, input, variantIds });
    if (r.errors) return { errors: r.errors };
    if (params.id === "new") return redirect(`/app/campaigns/${r.campaign.id}`);
    return { ok: true, message: "Campaign saved" };
  } catch (error) {
    console.error("Campaign save failed:", error?.message);
    return { errors: { form: "Shopify rejected the change. Please try again." } };
  }
};

const LABELS = { DRAFT: "Draft", SCHEDULED: "Scheduled", ACTIVE: "Active", PAUSED: "Paused", SOLD_OUT: "Sold out", COMPLETED: "Completed" };
const TONES = { ACTIVE: "success", SCHEDULED: "info", PAUSED: "warn", SOLD_OUT: "critical" };

export default function CampaignEditor() {
  const { isNew, campaign, variants, status, defaults } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [picked, setPicked] = useState(null); // null = keep the saved variants
  const busy = fetcher.state !== "idle";
  const errors = fetcher.data?.errors ?? {};
  const shown = picked ?? variants;
  const c = campaign ?? { name: "", startDate: "", endDate: "", shipDate: "", maxQuantity: defaults?.maxQuantity ?? "", targetUnits: defaults?.targetUnits ?? "", showCountdown: defaults?.showCountdown ?? false, showProgress: defaults?.showProgress ?? false, buttonText: defaults?.buttonText ?? "Pre-Order Now", state: "DRAFT" };

  useEffect(() => {
    if (fetcher.data?.ok) { shopify.toast.show(fetcher.data.message); setPicked(null); }
  }, [fetcher.data, shopify]);

  const pick = async () => {
    const selection = await shopify.resourcePicker({ type: "product", multiple: true, filter: { variants: true } });
    if (!selection) return;
    setPicked(selection.flatMap((p) => p.variants.map((v) => ({ id: v.id, title: `${p.title}${v.title && v.title !== "Default Title" ? ` — ${v.title}` : ""}` }))));
  };
  const submit = (event) => {
    event.preventDefault();
    fetcher.submit(new FormData(event.currentTarget), { method: "POST" });
  };
  const post = (intent) => fetcher.submit({ intent }, { method: "POST" });

  return (
    <Shell>
      <PageHead title={isNew ? "Create campaign" : c.name} subtitle={isNew ? "Set the schedule, limits and storefront display for a pre-order launch" : undefined}>
        <Button href="/app/campaigns">Back to campaigns</Button>
      </PageHead>
      {errors.form && <Banner tone="critical">{errors.form}</Banner>}
      <form onSubmit={submit}>
        <div className="wp-settings">
          <div>
            <Card>
              <SectionTitle icon="megaphone" title="Campaign details" sub="Name it so you can find it later. Customers don't see the name." />
              <SettingRow title="Campaign name"><s-text-field name="name" label="Campaign name" labelAccessibilityVisibility="exclusive" defaultValue={c.name} maxLength={80} error={errors.name} placeholder="e.g. Winter board launch" /></SettingRow>
              <SettingRow title="Button text" help="Shown on the pre-order button."><s-text-field name="buttonText" label="Button text" labelAccessibilityVisibility="exclusive" defaultValue={c.buttonText} maxLength={40} /></SettingRow>
            </Card>

            <Card>
              <SectionTitle icon="calendar" tone="blue" title="Schedule" sub="Leave start and end empty to run until you pause or delete it." />
              <SettingRow title="Start date (optional)" help="Starts at 00:00 UTC."><s-date-field name="startDate" label="Start date" labelAccessibilityVisibility="exclusive" defaultValue={c.startDate} error={errors.startDate} /></SettingRow>
              <SettingRow title="End date (optional)" help="Last day is included (UTC)."><s-date-field name="endDate" label="End date" labelAccessibilityVisibility="exclusive" defaultValue={c.endDate} error={errors.endDate} /></SettingRow>
              <SettingRow title="Expected shipping date"><s-date-field name="shipDate" label="Expected shipping date" labelAccessibilityVisibility="exclusive" defaultValue={c.shipDate} error={errors.shipDate} /></SettingRow>
            </Card>

            <Card>
              <SectionTitle icon="cart" tone="amber" title="Limits and goal" sub="Units sold are counted from Shopify inventory." />
              <SettingRow title="Pre-order limit per variant (optional)" help="Leave blank for no limit."><s-number-field name="maxQuantity" label="Limit per variant" labelAccessibilityVisibility="exclusive" defaultValue={String(c.maxQuantity)} min={1} step={1} error={errors.maxQuantity} /></SettingRow>
              <SettingRow title="Sales target (optional)" help="Used for the progress bar."><s-number-field name="targetUnits" label="Sales target" labelAccessibilityVisibility="exclusive" defaultValue={String(c.targetUnits)} min={1} step={1} error={errors.targetUnits} /></SettingRow>
            </Card>

            <Card>
              <SectionTitle icon="monitor" tone="purple" title="Storefront display" sub="What customers see on the product page." />
              <SettingRow title="Show a countdown" help="Counts down to the start before launch and to the end while live."><s-switch name="showCountdown" label="Show a countdown on the product page" labelAccessibilityVisibility="exclusive" defaultChecked={c.showCountdown} error={errors.showCountdown} /></SettingRow>
              <SettingRow title="Show a progress bar" help="Based on units actually pre-ordered; reservations and estimates are never shown."><s-switch name="showProgress" label="Show a progress bar" labelAccessibilityVisibility="exclusive" defaultChecked={c.showProgress} error={errors.showProgress} /></SettingRow>
            </Card>

            <Card title="Variants" sub="Variants stop selling at zero stock while the campaign is not live. Their original inventory setting is restored if you remove them or delete the campaign. Variants already set up in another campaign cannot be added.">
              {errors.variants && <Banner tone="critical">{errors.variants}</Banner>}
              {shown.map((v) => <input key={v.id} type="hidden" name="variantId" value={v.id} />)}
              {shown.length === 0 ? <p className="wp-muted" style={{ marginBottom: 12 }}>No variants selected.</p> : (
                <ul className="wp-list" style={{ marginBottom: 12 }}>
                  {shown.map((v) => <li key={v.id}><Thumb /><span className="grow">{v.title}</span>{v.sold != null && <span className="wp-muted">{v.sold} sold · {v.held} on hold</span>}</li>)}
                </ul>
              )}
              <Button onClick={pick}><Svg name="box" /> {shown.length ? "Change variants" : "Select products or variants"}</Button>
            </Card>
          </div>

          <aside className="wp-aside">
            <Card title="Status" action={<Badge tone={TONES[status]}>{LABELS[status]}</Badge>}>
              <p className="wp-muted" style={{ marginBottom: 12 }}>
                {isNew ? "Saved as a draft. Publish it when you are ready; nothing changes on your storefront until then." : status === "DRAFT" ? "Draft: not visible to customers yet." : "Status follows the schedule and verified sales."}
              </p>
              <div className="wp-stack">
                <button type="submit" className="wp-btn primary block" disabled={busy}>{busy ? "Saving…" : isNew ? "Create campaign" : "Save campaign"}</button>
                {!isNew && c.state === "DRAFT" && <Button block disabled={busy} onClick={() => post("publish")}>Publish</Button>}
                {!isNew && c.state === "PUBLISHED" && <Button block disabled={busy} onClick={() => post("pause")}>Pause</Button>}
                {!isNew && c.state === "PAUSED" && <Button block disabled={busy} onClick={() => post("resume")}>Resume</Button>}
                {!isNew && <Button block danger disabled={busy} onClick={() => { if (window.confirm("Delete this campaign?")) post("delete"); }}>Delete campaign</Button>}
                <Button block onClick={() => navigate("/app/campaigns")}>Cancel</Button>
              </div>
            </Card>
            <Card title="Good to know">
              <ul className="wp-steps">
                <li>Closing a campaign never emails the waitlist; only new stock does.</li>
                <li>Shopify&apos;s checkout is not gated by this app, so limits are best-effort.</li>
              </ul>
            </Card>
          </aside>
        </div>
      </form>
    </Shell>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers = (h) => boundary.headers(h);
