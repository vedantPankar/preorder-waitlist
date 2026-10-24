// Public privacy policy (no login). Linked from the App Store listing; keep it in step with what the app stores
// (see prisma/schema.prisma, waitlist.server.js purgeExpired and webhooks.server.js).
export const meta = () => [{ title: "Privacy Policy · Mobi-Preorder & Back in Stock" }, { name: "robots", content: "index" }];

const UPDATED = "23 October 2026";
const CONTACT = "info@mobidrag.com";

const css = `
  .pp { --ink:#1a1c1e; --sub:#5c6166; --line:#e3e5e7; --accent:#006f5c; font-family: Inter, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background:#f6f7f8; min-height:100vh; padding: 32px 16px 64px; line-height:1.6; }
  .pp main { max-width: 760px; margin: 0 auto; background:#fff; border:1px solid var(--line); border-radius:12px; padding: 32px clamp(20px, 5vw, 44px); }
  .pp h1 { font-size: clamp(26px, 5vw, 34px); line-height:1.15; margin: 0 0 6px; }
  .pp h2 { font-size: 20px; margin: 32px 0 8px; }
  .pp p, .pp li { color:#2b2f33; }
  .pp .meta { color: var(--sub); margin: 0 0 20px; }
  .pp ul { padding-left: 20px; display:grid; gap:6px; }
  .pp a { color: var(--accent); }
  .pp table { width:100%; border-collapse: collapse; margin: 8px 0; font-size: 15px; display:block; overflow-x:auto; }
  .pp th, .pp td { text-align:left; vertical-align: top; padding: 10px 12px; border-bottom: 1px solid var(--line); }
  .pp th { background:#f7f8f9; font-size: 13px; color: var(--sub); }
`;

export default function Privacy() {
  return (
    <div className="pp">
      <style>{css}</style>
      <main>
        <h1>Privacy Policy</h1>
        <p className="meta">Mobi-Preorder &amp; Back in Stock · Last updated {UPDATED}</p>

        <p>
          Mobi-Preorder &amp; Back in Stock (“the app”) is a Shopify app built by MobiDrag (“we”, “us”). It lets a store
          (“the merchant”) take pre-orders, run pre-order campaigns and email shoppers when a sold-out product is back in stock.
          This policy explains what the app stores, why, and how to have it removed.
        </p>
        <p>
          For shopper data, the merchant decides why and how it is used (the merchant is the controller) and we process it on
          the merchant&apos;s behalf. For the merchant&apos;s own account details, we are the controller.
        </p>

        <h2>What we collect</h2>
        <table>
          <thead><tr><th>Whose</th><th>What</th><th>Why</th></tr></thead>
          <tbody>
            <tr><td>Merchant</td><td>Store domain, the access token Shopify issues to the app, and the name and email Shopify shares for a signed-in staff account, if any.</td><td>To run the app inside the Shopify admin.</td></tr>
            <tr><td>Merchant</td><td>App settings: sender name, reply-to address, email look, limits and campaign details.</td><td>To apply the merchant&apos;s choices.</td></tr>
            <tr><td>Merchant</td><td>If the merchant connects Gmail: the Gmail or Google Workspace address and an app password. The password is stored encrypted and is never shown again.</td><td>To send emails from the merchant&apos;s own address.</td></tr>
            <tr><td>Shopper</td><td>Waitlist signup: email address, the product and variant chosen (and its options such as size), signup time and whether the email was sent.</td><td>To email the shopper once when the product is back in stock.</td></tr>
            <tr><td>Shopper</td><td>Pre-order orders: Shopify customer ID, order number, product details, quantity, expected ship date, and the email address only while the store sends through Gmail.</td><td>To send the pre-order confirmation and ship-date emails the merchant has turned on.</td></tr>
            <tr><td>Shopper</td><td>Short pre-order holds: variant, quantity and time. No personal details.</td><td>To stop more units being held than the pre-order limit.</td></tr>
            <tr><td>Shopper</td><td>Optional click count on the product link in restock emails, only if the merchant turns it on. No IP address or device is stored.</td><td>To show the merchant whether emails are useful.</td></tr>
          </tbody>
        </table>
        <p>
          We do not store shoppers&apos; names, postal addresses or payment details. The app sets no cookies and uses no browser
          storage on the storefront, and it contains no advertising or analytics trackers.
        </p>

        <h2>How we use it</h2>
        <ul>
          <li>To provide the features above to the merchant, and nothing else.</li>
          <li>To keep the app secure and working (for example limiting how many emails are sent per day).</li>
          <li>We do not sell personal data, use it for advertising, or use it to build profiles.</li>
        </ul>

        <h2>Who it is shared with</h2>
        <ul>
          <li><strong>Shopify</strong>, the platform the app runs on, which provides store, product, inventory and order information to the app.</li>
          <li><strong>Google</strong> (Gmail), only when the merchant connects Gmail. Emails to shoppers are sent through the merchant&apos;s own Gmail account, so the recipient address and message pass through Google&apos;s mail service.</li>
          <li><strong>Our hosting provider</strong>, which stores the app&apos;s database on servers we operate.</li>
        </ul>
        <p>We do not share data with anyone else unless the law requires it.</p>

        <h2>How long we keep it</h2>
        <ul>
          <li>Waitlist entries that have been notified or removed, and the records of sent and failed emails, are deleted after the merchant&apos;s retention period (90 days by default; the merchant can set 1 to 3,650 days in Settings). Shoppers still waiting stay on the list until they are notified or removed.</li>
          <li>Pre-order holds are deleted a week after they are settled.</li>
          <li>When the app is uninstalled, Shopify tells us to delete all of the store&apos;s data, and we do so.</li>
        </ul>

        <h2>Your rights</h2>
        <p>
          Shoppers can ask the store (or us) to see, correct or delete the data held about them. When Shopify sends us a customer
          data-erasure request, we delete that customer&apos;s waitlist entries, pre-order records and email records. For data
          access requests, the merchant can export the waitlist from the app. You can also write to us at
          {" "}<a href={`mailto:${CONTACT}`}>{CONTACT}</a> and we will help; depending on where you live you may also have the
          right to complain to your data protection authority.
        </p>

        <h2>Security</h2>
        <p>
          Data is sent over HTTPS. The Gmail app password is encrypted at rest and is write-only: it is never displayed or
          returned by the app. Access to the servers is limited to people who run the app.
        </p>

        <h2>Changes</h2>
        <p>If we change what the app collects, we will update this page and its date.</p>

        <h2>Contact</h2>
        <p>
          MobiDrag · <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
        </p>
      </main>
    </div>
  );
}
