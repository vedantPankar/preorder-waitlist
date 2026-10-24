import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getEmailStatus, getShopMailer } from "../lib/shop-mailer.server";
import { DEFAULT_ACCENT, EMAIL_FONTS, EMAIL_HEADERS, EMAIL_TEMPLATES, brandFromSettings, cleanAccent, parseEmailLookForm } from "../lib/email-layout.server";
import { PREVIEW_KINDS, buildPreviewEmail } from "../lib/email-preview.server";
import { cleanText, isValidEmail } from "../lib/validation.server";
import { Banner, Button, Card, PageHead, SectionTitle, SettingRow, Shell, Svg } from "../ui/ui.jsx";

const DESCRIPTIONS = {
  classic: "Plain and simple, like the emails the app has always sent.",
  modern: "A card on a soft background with a bold button.",
  minimal: "Clean and quiet, with a thin line and an outlined button.",
  bold: "A colour band, a big first line and a large button.",
  elegant: "Centred and serif, with a fine divider and an outlined button.",
  dark: "A dark card with light text and a bright button.",
};

/** The look as typed in the form (not saved): invalid values simply fall back to the default look. */
const draftBrand = (form) => {
  const accent = cleanAccent(form.get("emailAccentColor"));
  return brandFromSettings({ emailTemplate: form.get("emailTemplate"), emailAccentColor: accent === DEFAULT_ACCENT ? null : accent, emailLogoUrl: form.get("emailLogoUrl"), emailFont: form.get("emailFont"), emailHeader: form.get("emailHeader") });
};
/** The restock sample in every template with the draft look, for the gallery thumbnails. */
const thumbsOf = (brand, shop, settings) => Object.fromEntries(Object.keys(EMAIL_TEMPLATES).map((id) => [id, buildPreviewEmail("restock", { shop, brand: { ...brand, template: id }, settings }).html]));
const previewOf = (form, shop, settings) => {
  const kind = Object.hasOwn(PREVIEW_KINDS, form.get("kind")) ? form.get("kind") : "restock";
  return buildPreviewEmail(kind, { shop, brand: draftBrand(form), settings });
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  const brand = brandFromSettings(settings);
  const preview = buildPreviewEmail("restock", { shop, brand, settings });
  return {
    look: { emailTemplate: brand.template, emailAccentColor: brand.accent ?? DEFAULT_ACCENT, emailLogoUrl: brand.logoUrl ?? "", emailFont: brand.font ?? "", emailHeader: brand.header ?? "" },
    fonts: EMAIL_FONTS, headers: EMAIL_HEADERS,
    thumbs: thumbsOf(brand, shop, settings),
    templates: Object.entries(EMAIL_TEMPLATES).map(([id, name]) => ({ id, name, description: DESCRIPTIONS[id] })),
    kinds: PREVIEW_KINDS,
    preview: { subject: preview.subject, html: preview.html },
    mailer: await getEmailStatus(db, shop),
    gmailAddress: settings?.gmailAddress ?? "",
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");
  const settings = await db.shopSettings.findUnique({ where: { shop } });

  if (intent === "preview") {
    const { subject, html } = previewOf(form, shop, settings);
    return { preview: { subject, html }, thumbs: thumbsOf(draftBrand(form), shop, settings) };
  }

  if (intent === "testEmail") {
    const to = cleanText(form.get("testTo"), 254);
    if (!to || !isValidEmail(to)) return { errors: { testTo: "Enter the email address to send the test to." } };
    const mailer = await getShopMailer(db, shop);
    if (!mailer) return { errors: { testTo: "Email sending is not configured yet. Connect Gmail in Settings first." } };
    const { subject, text, html } = previewOf(form, shop, settings);
    try {
      await mailer.send({ to, subject: `[Test] ${subject}`.slice(0, 200), text, html, fromName: settings?.fromName || undefined, replyTo: settings?.replyToEmail || undefined });
    } catch (e) {
      return { errors: { testTo: `Gmail did not accept the test (${e?.status ? `HTTP ${e.status}` : "could not be reached"}).` } };
    }
    return { ok: true, message: "Test email accepted by Gmail. Check that inbox." };
  }

  const parsed = parseEmailLookForm(form);
  if (parsed.errors) return { errors: parsed.errors };
  await db.shopSettings.upsert({ where: { shop }, create: { shop, ...parsed.data }, update: parsed.data });
  return { ok: true, message: "Email look saved" };
};

export default function EmailTemplates() {
  const { look, templates, kinds, fonts, headers, thumbs: initialThumbs, preview, mailer, gmailAddress } = useLoaderData();
  const fetcher = useFetcher();
  const previewer = useFetcher();
  const tester = useFetcher();
  const shopify = useAppBridge();
  const formRef = useRef(null);
  const timer = useRef(null);
  const [draft, setDraft] = useState({ ...look, kind: "restock" });
  const [width, setWidth] = useState("desktop");
  const errors = fetcher.data?.errors ?? {};
  const saving = fetcher.state !== "idle";
  const shown = previewer.data?.preview ?? preview;
  const thumbs = previewer.data?.thumbs ?? initialThumbs;

  useEffect(() => { if (fetcher.data?.ok) shopify.toast.show(fetcher.data.message); }, [fetcher.data, shopify]);
  useEffect(() => { if (tester.data?.ok) shopify.toast.show(tester.data.message); }, [tester.data, shopify]);
  useEffect(() => setDraft((d) => ({ ...d, ...look })), [look]);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Refresh the preview a moment after the last change.
  const sync = () => {
    const form = formRef.current;
    if (!form) return;
    setDraft((d) => ({ ...d, ...Object.fromEntries(new FormData(form)) }));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { const f = new FormData(form); f.set("intent", "preview"); previewer.submit(f, { method: "POST" }); }, 250);
  };
  const sendTest = () => {
    const f = new FormData(formRef.current); // the look as shown in the preview, plus the address typed below it
    f.set("intent", "testEmail");
    tester.submit(f, { method: "POST" });
  };

  return (
    <Shell>
      <PageHead title="Email templates" subtitle="Choose how the emails your customers receive look. The wording stays the same." />
      {mailer.channel !== "smtp" && <Banner tone="warning" title="Connect Gmail to send emails" action={<Button href="/app/settings#gmail-setup">Connect Gmail</Button>}>The preview works without it, but nothing is sent until Gmail is connected.</Banner>}
      <form ref={formRef} onInput={sync} onChange={sync} onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); f.set("intent", "save"); fetcher.submit(f, { method: "POST" }); }}>
        <div className="wp-settings">
          <div>
            <Card>
              <SectionTitle icon="mail" title="Template" sub="Applies to all emails: back in stock, signup confirmation, pre-order confirmation and ship-date emails." />
              <div className="wp-tpls" role="radiogroup" aria-label="Email template">
                {templates.map((t) => (
                  <label key={t.id} className="wp-tpl">
                    <input type="radio" name="emailTemplate" value={t.id} defaultChecked={look.emailTemplate === t.id} />
                    <div className="wp-tpl-thumb" aria-hidden="true"><iframe title={`${t.name} preview`} tabIndex={-1} sandbox="" srcDoc={thumbs[t.id]} /></div>
                    <strong>{t.name}</strong>
                    <span className="wp-muted">{t.description}</span>
                  </label>
                ))}
              </div>
              {errors.emailTemplate && <p style={{ color: "#b42318", marginTop: 8 }}>{errors.emailTemplate}</p>}
              <SettingRow title="Accent colour" help="Used for the button and lines. Classic only colours its link."><s-color-field name="emailAccentColor" label="Accent colour" labelAccessibilityVisibility="exclusive" defaultValue={look.emailAccentColor} error={errors.emailAccentColor} /></SettingRow>
              <SettingRow title="Font style" help="Safe system fonts, so it looks the same in every mail app. “Template default” uses the template's own font."><s-select name="emailFont" label="Font style" labelAccessibilityVisibility="exclusive" value={look.emailFont} error={errors.emailFont}><s-option value="">Template default</s-option>{Object.entries(fonts).map(([id, name]) => <s-option key={id} value={id}>{name}</s-option>)}</s-select></SettingRow>
              <SettingRow title="Header" help="The top of the email. “Show logo” falls back to your store name when no logo address is set."><s-select name="emailHeader" label="Header" labelAccessibilityVisibility="exclusive" value={look.emailHeader} error={errors.emailHeader}><s-option value="">Template default</s-option>{Object.entries(headers).map(([id, name]) => <s-option key={id} value={id}>{name}</s-option>)}</s-select></SettingRow>
              <SettingRow title="Logo image address" help="Optional. A link starting with https:// to a picture of your logo (about 200 px wide). Leave blank to show your store name."><s-text-field name="emailLogoUrl" label="Logo image address" labelAccessibilityVisibility="exclusive" placeholder="https://example.com/logo.png" defaultValue={look.emailLogoUrl} error={errors.emailLogoUrl} /></SettingRow>
              <p style={{ marginTop: 12 }}><button type="submit" className="wp-btn primary" disabled={saving}>{saving ? "Saving…" : "Save"}</button></p>
            </Card>
          </div>

          <div>
            <Card>
              <SectionTitle icon="monitor" tone="blue" title="Preview" sub="Sample data. Nothing is sent." />
              <s-select name="kind" label="Email" value={draft.kind}>
                {Object.entries(kinds).map(([id, name]) => <s-option key={id} value={id}>{name}</s-option>)}
              </s-select>
              <div className="wp-seg" role="group" aria-label="Preview width">
                <button type="button" className={width === "desktop" ? "on" : ""} aria-pressed={width === "desktop"} onClick={() => setWidth("desktop")}>Desktop</button>
                <button type="button" className={width === "mobile" ? "on" : ""} aria-pressed={width === "mobile"} onClick={() => setWidth("mobile")}>Mobile</button>
              </div>
              <p className="wp-muted" style={{ margin: "10px 0 6px" }}>Subject: <strong>{shown.subject}</strong></p>
              <div className="wp-email-stage"><iframe className="wp-email-frame" style={{ width: width === "mobile" ? 375 : "100%" }} title="Email preview" sandbox="" srcDoc={shown.html} /></div>
            </Card>
            <Card title="Send a test">
              <div className="wp-stack">
                <s-email-field name="testTo" label="Send this email to" details="Use an inbox you own." defaultValue={gmailAddress} error={tester.data?.errors?.testTo} />
                <button type="button" className="wp-btn block" onClick={sendTest} disabled={tester.state !== "idle"}><Svg name="mail" /> Send test email</button>
              </div>
            </Card>
          </div>
        </div>
      </form>
    </Shell>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers = (h) => boundary.headers(h);
