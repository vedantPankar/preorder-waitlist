import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getEmailStatus, getShopMailer } from "../lib/shop-mailer.server";
import { applyGmailCredentials } from "../lib/gmail-settings.server";
import { COUNTDOWN_STYLES, parseSettingsForm, settingsView } from "../lib/settings.server";
import pkg from "../../package.json";
import { Badge, Banner, Button, Card, SectionTitle, SettingRow, Shell, PageHead, Svg } from "../ui/ui.jsx";
import { cleanText, isValidEmail } from "../lib/validation.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const settings = await db.shopSettings.findUnique({ where: { shop: session.shop } });
  return { version: pkg.version, mailer: await getEmailStatus(db, session.shop), settings: settingsView(settings), lastError: settings?.lastNotifyError ?? null, countdownStyles: COUNTDOWN_STYLES };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "reset") {
    await db.shopSettings.deleteMany({ where: { shop } });
    return { ok: true, message: "Settings restored to defaults" };
  }
  if (intent === "testEmail") {
    const to = cleanText(form.get("testTo"), 254);
    if (!to || !isValidEmail(to)) return { errors: { testTo: "Enter the email address to send the test to." } };
    const mailer = await getShopMailer(db, shop, { admin });
    if (!mailer) return { errors: { testTo: "Email sending is not configured yet (or Gmail needs attention, see above)." } };
    const current = await db.shopSettings.findUnique({ where: { shop } });
    try {
      await mailer.send({
        to, subject: "Test email from PreOrder & Notify",
        text: "This is a test email. If you can read it, back-in-stock emails can be sent from your store.",
        html: "<p>This is a test email. If you can read it, back-in-stock emails can be sent from your store.</p>",
        fromName: current?.fromName || undefined, replyTo: current?.replyToEmail || undefined,
      });
    } catch (e) {
      return { errors: { testTo: `Gmail did not accept the test (${e?.status ? `HTTP ${e.status}` : "could not be reached"}).` } };
    }
    return { ok: true, message: "Test email accepted by the provider. Check that inbox." };
  }

  if (intent === "disconnectGmail") {
    await db.shopSettings.updateMany({ where: { shop }, data: { gmailAddress: null, gmailPasswordEnc: null, gmailAuthError: null, gmailAuthErrorAt: null } });
    return { ok: true, message: "Gmail disconnected. Nothing is sent until you connect Gmail again." };
  }

  const current = await db.shopSettings.findUnique({ where: { shop } });
  const parsed = parseSettingsForm(form, current, { isValidEmail, cleanText });
  if (parsed.errors) return { errors: parsed.errors };
  // The app password is only ever read here: verified, encrypted, stored. It is never echoed back or logged.
  const gmail = await applyGmailCredentials({ db, shop, current, data: parsed.data, password: form.get("gmailPassword") });
  if (gmail.errors) return { errors: gmail.errors };
  await db.shopSettings.upsert({ where: { shop }, create: { shop, ...gmail.data }, update: gmail.data });
  return { ok: true, message: gmail.warning ? `Settings saved. ${gmail.warning}` : "Settings saved" };
};

const PARTS = { dhms: [["12", "Days"], ["08", "Hrs"], ["24", "Mins"], ["16", "Secs"]], hms: [["296", "Hrs"], ["24", "Mins"], ["16", "Secs"]] };

function renderPreview(d) {
  const outline = d.buttonStyle === "outline";
  const parts = PARTS[d.countdownStyle];
  return (
    <div className="wp-preview" aria-label="Preview of the storefront pre-order widget">
      <div style={{ background: "#fff", borderRadius: 10, padding: 14, fontSize: 13 }}>
        <div style={{ fontWeight: 700 }}>The Out of Stock Snowboard</div>
        <div style={{ marginBottom: 10 }}>$749.00</div>
        <div style={{ padding: "10px 16px", textAlign: "center", fontWeight: 600, borderRadius: 6, border: `1px solid ${d.buttonColor}`, background: outline ? "transparent" : d.buttonColor, color: outline ? d.buttonColor : d.buttonTextColor }}>
          {d.defaultButtonText || "Pre-Order Now"}
        </div>
        <div style={{ marginTop: 12, fontSize: 12, color: "#5c6166" }}>Pre-order ends in</div>
        {parts ? (
          <div style={{ display: "flex", gap: 6, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
            {parts.map(([n, l]) => <div key={l} style={{ textAlign: "center", flex: 1, border: "1px solid #e3e5e7", borderRadius: 6, padding: "4px 2px" }}><strong>{n}</strong><div style={{ fontSize: 10, color: "#5c6166" }}>{l}</div></div>)}
          </div>
        ) : <div style={{ fontWeight: 700, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>12d 08:24:16</div>}
        <div style={{ marginTop: 10, fontSize: 12 }}>24 of 100 pre-ordered</div>
        <progress max="100" value="24" style={{ width: "100%", height: 8, accentColor: d.progressColor }} aria-label="Example progress" />
      </div>
    </div>
  );
}

export default function Settings() {
  const { version, mailer, settings, lastError, countdownStyles } = useLoaderData();
  const fetcher = useFetcher();
  const side = useFetcher();
  const shopify = useAppBridge();
  const formRef = useRef(null);
  const [draft, setDraft] = useState(settings);
  const errors = fetcher.data?.errors ?? {};
  const saving = fetcher.state !== "idle";

  useEffect(() => { if (fetcher.data?.ok) shopify.toast.show(fetcher.data.message); }, [fetcher.data, shopify]);
  useEffect(() => {
    if (side.data?.ok) shopify.toast.show(side.data.message);
    if (side.data?.ok && side.data.message.startsWith("Settings restored")) setDraft(settings);
  }, [side.data, shopify, settings]);
  useEffect(() => setDraft(settings), [settings]);

  // The app password is never copied into page state (the preview only needs the look fields).
  const sync = () => { if (formRef.current) { const f = Object.fromEntries(new FormData(formRef.current)); delete f.gmailPassword; setDraft((d) => ({ ...d, ...f })); } };
  const color = (name, label) => <s-color-field name={name} label={label} defaultValue={settings[name]} error={errors[name]} />;
  return (
    <Shell>
      <PageHead title="Settings" subtitle="Configure how the app works on your store" />
      <div className="wp-settings">
        <form ref={formRef} onInput={sync} onChange={sync} onSubmit={(e) => { e.preventDefault(); fetcher.submit(new FormData(e.currentTarget), { method: "POST" }); }}>
          <input type="hidden" name="_form" value="settings" />

          <Card>
            <SectionTitle icon="mail" title="Email notifications" sub="Send automatic emails to customers when products are back in stock." />
            {mailer.configured ? (
              <Banner tone="success" title="Gmail is connected">Back-in-stock notifications are sent through your Gmail. Use “Test email notification” on the right to confirm.</Banner>
            ) : (
              <Banner tone="critical" title={mailer.gmail.state === "auth_failed" || mailer.gmail.state === "unreadable" ? "Gmail needs attention" : "Email sending is not configured"} action={<Button href="#gmail-setup">{mailer.gmail.state === "none" ? "Set it up" : "Fix it"}</Button>}>
                {mailer.gmail.state === "none" ? "No notifications are sent until Gmail is connected. Connect Gmail below." : mailer.problems[0]}
              </Banner>
            )}
            {lastError && <Banner tone="warning" title="The last send failed">{lastError}</Banner>}
            <SettingRow title="Show the “Notify Me” waitlist" help="On sold-out products."><s-switch name="waitlistEnabled" label="Show the Notify Me waitlist on sold-out products" labelAccessibilityVisibility="exclusive" defaultChecked={settings.waitlistEnabled} /></SettingRow>
            <SettingRow title="Require customer login for pre-orders" help="Off by default. When on, visitors who are not logged in are sent to your store's login page and cannot place a pre-order hold until they log in."><s-switch name="requirePreorderLogin" label="Require customers to log in before they can pre-order" labelAccessibilityVisibility="exclusive" defaultChecked={settings.requirePreorderLogin} /></SettingRow>
            <SettingRow title="Count clicks on restock emails" help="Off by default. When on, the link goes through your store's /apps/waitlist/r/ address, the email says that clicks are counted, and only the click count is stored (no IP address or device)."><s-switch name="trackClicks" label="Count clicks on the product link in restock emails" labelAccessibilityVisibility="exclusive" defaultChecked={settings.trackClicks} /></SettingRow>
            <SettingRow title="Keep notified/removed entries (days)" help="Older entries are deleted automatically."><s-number-field name="retentionDays" label="Retention in days" labelAccessibilityVisibility="exclusive" defaultValue={String(settings.retentionDays)} min={1} error={errors.retentionDays} /></SettingRow>
          </Card>

          <Card>
            <div id="gmail-setup" />
            <SectionTitle icon="mail" tone="blue" title="Send with Gmail" sub="Send the emails yourself from your own Gmail or Google Workspace address, with an app password. Works for guests too." />
            {mailer.gmail.state === "ok" && <Banner tone="success" title={`Sending through ${mailer.gmail.address}`}>Used today: {mailer.gmail.used} of {mailer.gmail.cap}. Anything over the daily limit stays queued and is sent after the limit resets (midnight UTC).</Banner>}
            {mailer.gmail.state === "auth_failed" && <Banner tone="critical" title="Gmail rejected the sign-in">Nothing is being sent. Create a new app password for {mailer.gmail.address} and save it below. Queued emails are kept; use “Retry failed” in Notification activity for any that failed.</Banner>}
            {mailer.gmail.state === "unreadable" && <Banner tone="warning" title="The saved app password cannot be read">The server&apos;s encryption key changed, so the saved password is unusable. Enter the app password again below. Nothing is sent until you do.</Banner>}
            {!mailer.gmail.keyAvailable && <Banner tone="warning" title="No encryption key on the server">Set EMAIL_SETTINGS_KEY (or SHOPIFY_API_SECRET) on the server before saving a Gmail password.</Banner>}
            <SettingRow title="Gmail address" help="The account that sends the emails, e.g. store@gmail.com or you@yourdomain.com on Google Workspace."><s-email-field name="gmailAddress" label="Gmail address" labelAccessibilityVisibility="exclusive" defaultValue={settings.gmailAddress} error={errors.gmailAddress} /></SettingRow>
            <SettingRow title="App password" help={settings.gmailConfigured ? "A password is saved and is never shown again. Enter a new one only to replace it." : "16 letters from myaccount.google.com/apppasswords. Needs 2-Step Verification on the Google account. Your normal Gmail password will not work."}><s-password-field name="gmailPassword" label="App password" labelAccessibilityVisibility="exclusive" autocomplete="off" placeholder={settings.gmailConfigured ? "Saved (hidden)" : "abcd efgh ijkl mnop"} error={errors.gmailPassword} /></SettingRow>
            <SettingRow title="Daily send limit" help={`Stops sending after this many emails per day from this Gmail account (shared if several stores use the same account). Gmail allows about 500 a day on a personal account and 2,000 on Google Workspace. Default ${400}.`}><s-number-field name="dailySendCap" label="Daily send limit" labelAccessibilityVisibility="exclusive" defaultValue={String(settings.dailySendCap)} min={1} max={2000} error={errors.dailySendCap} /></SettingRow>
            {settings.gmailConfigured && <p style={{ marginTop: 10 }}><Button danger onClick={() => { if (window.confirm("Disconnect Gmail? The saved app password is deleted and nothing is sent until you connect Gmail again.")) side.submit({ intent: "disconnectGmail" }, { method: "POST" }); }}>Disconnect Gmail</Button></p>}
            <ol className="wp-steps" style={{ marginTop: 12 }}>
              <li>Turn on <strong>2-Step Verification</strong> for the Google account.</li>
              <li>Open <strong>myaccount.google.com/apppasswords</strong>, create an app password (name it “Waitlist”) and copy the 16 letters.</li>
              <li>Paste the Gmail address and the app password above and press <strong>Save</strong>. The app checks the login with Gmail before saving.</li>
              <li>Use <strong>Test email notification</strong> on the right to send yourself a message.</li>
            </ol>
          </Card>

          <Card>
            <SectionTitle icon="mail" tone="blue" title="Extra emails" sub="Signup confirmation and pre-order ship-date emails, sent by the app through your Gmail." />
            {mailer.channel !== "smtp" && <Banner tone="warning" title="These emails need Gmail">Connect Gmail above. Until then nothing is queued or sent for these.</Banner>}
            {mailer.channel === "smtp" && <Banner tone="info" title="Sent from your Gmail">These emails are sent by the app through your Gmail account, so guests receive them too. Ship-date emails also need the order permission (see OPERATIONS.md).</Banner>}
            <SettingRow title="Waitlist signup confirmation" help="Sent right after someone joins a waitlist."><s-switch name="emailSignupConfirmation" label="Send a confirmation when someone joins the waitlist" labelAccessibilityVisibility="exclusive" defaultChecked={settings.emailSignupConfirmation} /></SettingRow>
            <SettingRow title="Pre-order confirmation" help="Sent right after a customer places an order that contains pre-order items: the items, quantities and expected ship dates. Needs the order permission (see OPERATIONS.md)."><s-switch name="emailPreorderConfirmation" label="Send a confirmation when someone places a pre-order" labelAccessibilityVisibility="exclusive" defaultChecked={settings.emailPreorderConfirmation} /></SettingRow>
            <SettingRow title="Ship-date reminder" help="Sent to customers with an open pre-order shortly before the expected ship date."><s-switch name="emailShipReminder" label="Remind pre-order customers before the ship date" labelAccessibilityVisibility="exclusive" defaultChecked={settings.emailShipReminder} /></SettingRow>
            <SettingRow title="Days before shipping" help="How many days ahead the reminder is sent (1-60)."><s-number-field name="shipReminderDays" label="Days before shipping" labelAccessibilityVisibility="exclusive" defaultValue={String(settings.shipReminderDays)} min={1} max={60} error={errors.shipReminderDays} /></SettingRow>
            <SettingRow title="Ship-date change notice" help="Sent when the expected ship date of an open pre-order changes."><s-switch name="emailShipDateChange" label="Tell pre-order customers when the ship date changes" labelAccessibilityVisibility="exclusive" defaultChecked={settings.emailShipDateChange} /></SettingRow>
          </Card>

          <Card>
            <SectionTitle icon="gear" title="Default settings" sub="Defaults used when you create pre-orders and campaigns. Existing ones are not changed." />
            <SettingRow title="Default button text"><s-text-field name="defaultButtonText" label="Default button text" labelAccessibilityVisibility="exclusive" defaultValue={settings.defaultButtonText} maxLength={40} /></SettingRow>
            <SettingRow title="Default pre-order limit (per variant)" help="Leave blank for no limit."><s-number-field name="defaultMaxQuantity" label="Default pre-order limit" labelAccessibilityVisibility="exclusive" defaultValue={String(settings.defaultMaxQuantity)} min={1} step={1} error={errors.defaultMaxQuantity} /></SettingRow>
            <SettingRow title="Default sales target (for progress bar)" help="Used for the progress bar on campaigns."><s-number-field name="defaultTargetUnits" label="Default sales target" labelAccessibilityVisibility="exclusive" defaultValue={String(settings.defaultTargetUnits)} min={1} step={1} error={errors.defaultTargetUnits} /></SettingRow>
            <SettingRow title="Show countdown timer by default" help="Display a live countdown on the product page."><s-switch name="defaultShowCountdown" label="Show countdown timer by default" labelAccessibilityVisibility="exclusive" defaultChecked={settings.defaultShowCountdown} /></SettingRow>
            <SettingRow title="Show progress bar by default" help="Display how many units have been pre-ordered."><s-switch name="defaultShowProgress" label="Show progress bar by default" labelAccessibilityVisibility="exclusive" defaultChecked={settings.defaultShowProgress} /></SettingRow>
          </Card>

          <Card>
            <SectionTitle icon="monitor" tone="blue" title="Storefront display" sub="Customize the look and feel of the pre-order widget." />
            <p className="wp-muted" style={{ marginBottom: 12 }}>
              Applies to blocks that have “Use the app&apos;s Settings look” turned on in the theme editor (on by default). Until you save this section, the theme editor&apos;s own style settings are used.
            </p>
            <div className="wp-grid-2 even" style={{ alignItems: "start" }}>
              <div className="wp-stack">
                <s-select name="buttonStyle" label="Button style" value={settings.buttonStyle} error={errors.buttonStyle}>
                  <s-option value="solid">Solid</s-option>
                  <s-option value="outline">Outline</s-option>
                </s-select>
                {color("buttonColor", "Button colour")}
                {color("buttonTextColor", "Button text colour")}
                {color("progressColor", "Progress bar colour")}
                <s-select name="countdownStyle" label="Countdown style" value={settings.countdownStyle} error={errors.countdownStyle}>
                  {Object.entries(countdownStyles).map(([value, label]) => <s-option key={value} value={value}>{label}</s-option>)}
                </s-select>
              </div>
              <div>
                {renderPreview(draft)}
                <p className="wp-muted" style={{ marginTop: 8 }}>Preview only. The real widget also follows your theme&apos;s font and size.</p>
              </div>
            </div>
          </Card>

          <Card>
            <SectionTitle icon="doc" tone="purple" title="Language & text" sub="Customize text used in the back-in-stock email." />
            <SettingRow title="Notification email subject" help="Use {{product}} for the product name."><s-text-field name="subject" label="Notification email subject" labelAccessibilityVisibility="exclusive" defaultValue={settings.subject} maxLength={150} /></SettingRow>
            <SettingRow title="Sender name"><s-text-field name="fromName" label="Sender name" labelAccessibilityVisibility="exclusive" defaultValue={settings.fromName} maxLength={80} /></SettingRow>
            <SettingRow title="Reply-to email"><s-text-field name="replyToEmail" label="Reply-to email" labelAccessibilityVisibility="exclusive" defaultValue={settings.replyToEmail} error={errors.replyToEmail} /></SettingRow>
          </Card>

          <button type="submit" className="wp-btn primary" disabled={saving}>{saving ? "Saving…" : "Save settings"}</button>
        </form>

        <aside className="wp-aside">
          <Card title="App status" action={<Badge tone={mailer.configured ? "success" : "warn"}>{mailer.configured ? "Active" : "Needs setup"}</Badge>}>
            <p className="wp-muted">Version {version}</p>
            <p style={{ marginTop: 6 }}>{mailer.configured ? "Your app is working correctly." : "Emails will not be sent until Gmail is connected."}</p>
          </Card>

          <Card title="Quick actions">
            <side.Form method="post" className="wp-stack">
              <input type="hidden" name="intent" value="testEmail" />
              <s-email-field name="testTo" label="Send a test email to" details="Use an inbox you own." error={side.data?.errors?.testTo} />
              <button type="submit" className="wp-btn block" disabled={side.state !== "idle" && side.formData?.get("intent") === "testEmail"}><Svg name="mail" /> Test email notification</button>
            </side.Form>
            <ul className="wp-list" style={{ marginTop: 12 }}>
              <li><a href="/app/notifications">View email logs</a></li>
              <li><Button danger block onClick={() => { if (window.confirm("Restore every setting on this page to its default?")) side.submit({ intent: "reset" }, { method: "POST" }); }}><Svg name="undo" /> Reset to default</Button></li>
            </ul>
          </Card>

          <Card title="Need help?">
            <p className="wp-muted" style={{ marginBottom: 10 }}>Contact support if you need any help.</p>
            <Button block href="mailto:info@mobidrag.com">Contact support</Button>
          </Card>
        </aside>
      </div>
    </Shell>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers = (h) => boundary.headers(h);
