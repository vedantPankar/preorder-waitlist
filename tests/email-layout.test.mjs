import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, fakeMailer, variant } from "./helpers.mjs";
import { DEFAULT_ACCENT, EMAIL_FONTS, EMAIL_HEADERS, EMAIL_TEMPLATES, brandFromSettings, cleanAccent, cleanLogoUrl, parseEmailLookForm, renderEmail } from "../app/lib/email-layout.server.js";
import { buildPreorderConfirmationEmail, buildShipEmail, buildSignupConfirmationEmail } from "../app/lib/email-templates.server.js";
import { buildPreviewEmail, PREVIEW_KINDS } from "../app/lib/email-preview.server.js";
import { buildEmail, enqueueRestock, processQueue } from "../app/lib/notify.server.js";
import { handleSignupRequest } from "../app/lib/signup.server.js";
import { processFlowDeliveries } from "../app/lib/flow-notify.server.js";
import { addSignup } from "../app/lib/waitlist.server.js";
import { getShopMailer } from "../app/lib/shop-mailer.server.js";
import { encryptSecret } from "../app/lib/secrets.server.js";

// The look of the emails: three layouts, accent colour, logo. Only HTML changes; text, subjects and delivery do not.
process.env.SHOPIFY_API_SECRET ||= "test-api-secret-0123456789";
const ENV = { SHOPIFY_API_SECRET: "test-api-secret-0123456789" };
let db;
before(async () => { db = await createTestDb(); });
let n = 0;
const newShop = () => `el${++n}.myshopify.com`;

const brand = (over = {}) => brandFromSettings({ emailTemplate: "classic", ...over });
const content = (over = {}) => ({ shop: "s.myshopify.com", paragraphs: ["Hello there.", ["Good news! ", { strong: "Shoe" }, " is here."]], button: { label: "View the product", url: "https://s.myshopify.com/products/shoe" }, footer: "Small print.", ...over });
const LOGO = "https://cdn.example.com/logo.png";

test("the six layouts all render the content, the button link and the footer", () => {
  assert.deepEqual(Object.keys(EMAIL_TEMPLATES), ["classic", "modern", "minimal", "bold", "elegant", "dark"]);
  for (const template of Object.keys(EMAIL_TEMPLATES)) {
    const html = renderEmail(brand({ emailTemplate: template, emailAccentColor: "#B42318" }), content());
    for (const piece of ["Hello there.", "<strong>Shoe</strong>", 'href="https://s.myshopify.com/products/shoe"', "View the product", "Small print."]) assert.ok(html.includes(piece), `${template}: ${piece}`);
  }
});

test("Classic with no customisation is byte-identical to the email the app always sent", () => {
  const legacy = '<p>Hello there.</p><p>Good news! <strong>Shoe</strong> is here.</p><p><a href="https://s.myshopify.com/products/shoe">View the product</a></p><p style="color:#6d7175;font-size:12px">Small print.</p>';
  assert.equal(renderEmail(brand(), content()), legacy);
  assert.equal(renderEmail(null, content()), legacy, "no brand at all is the default look");
  assert.equal(renderEmail(brand({ emailAccentColor: "nonsense", emailLogoUrl: "http://x.com/a.png" }), content()), legacy, "invalid values change nothing");
  const row = { emailTemplate: "classic", emailAccentColor: null, emailLogoUrl: null };
  const v = { productTitle: "Shoe", variantTitle: "Red", productHandle: "shoe", variantId: "111" };
  assert.equal(buildEmail({ shop: "s.myshopify.com", variant: v, settings: row, delivery: null }).html,
    '<p>Good news! <strong>Shoe (Red)</strong> is back in stock.</p><p><a href="https://s.myshopify.com/products/shoe?variant=111">View the product</a></p><p style="color:#6d7175;font-size:12px">You received this one-time email because you asked to be notified. We will not email you again about this product unless you sign up again.</p>');
});

test("every designed layout is a table-based, inline-styled document that fits a phone", () => {
  for (const template of ["modern", "minimal", "bold", "elegant", "dark"]) {
    const html = renderEmail(brand({ emailTemplate: template }), content());
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /<table role="presentation"/);
    assert.match(html, /max-width:(600|560)px/);
    assert.ok(!/<style|<script|<link|@import|url\(/i.test(html), `${template}: no style blocks, scripts or external styles`);
    assert.ok(html.includes(DEFAULT_ACCENT), `${template}: the default accent applies`);
  }
  const modern = renderEmail(brand({ emailTemplate: "modern", emailAccentColor: "#FFD60A" }), content());
  assert.ok(modern.includes("color:#202223;text-decoration:none"), "light accent gets dark button text");
  assert.ok(renderEmail(brand({ emailTemplate: "modern", emailAccentColor: "#0B3D91" }), content()).includes("color:#FFFFFF;text-decoration:none"), "dark accent gets white button text");
});

test("accent colour and logo are applied when valid", () => {
  const classic = renderEmail(brand({ emailAccentColor: "#b42318", emailLogoUrl: LOGO }), content());
  assert.ok(classic.includes('style="color:#B42318"') && classic.includes(`<img src="${LOGO}"`), "Classic colours its link and shows the logo");
  const modern = renderEmail(brand({ emailTemplate: "modern", emailAccentColor: "#b42318", emailLogoUrl: LOGO }), content());
  assert.ok(modern.includes("#B42318") && modern.includes(`<img src="${LOGO}"`) && !modern.includes(">s.myshopify.com</span>"), "a logo replaces the store name");
  assert.ok(renderEmail(brand({ emailTemplate: "minimal" }), content()).includes(">s.myshopify.com</span>"), "without a logo the store name is shown");
});

test("every dynamic value is HTML-escaped, in every layout", () => {
  const evil = `<img src=x onerror=alert(1)>"'&`;
  for (const template of Object.keys(EMAIL_TEMPLATES)) {
    const html = renderEmail(brand({ emailTemplate: template, emailAccentColor: "#B42318", emailLogoUrl: LOGO }), {
      shop: `${evil}.myshopify.com`, paragraphs: [evil, ["x ", { strong: evil }]], button: { label: evil, url: `https://s.myshopify.com/?a="><script>alert(1)</script>&b=${evil}` }, footer: evil,
    });
    assert.ok(!/<img src=x/i.test(html) && !html.includes("<script>") && !html.includes("onerror=alert(1)>"), `${template}: nothing injected`);
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;"), `${template}: escaped text is shown`);
    assert.ok(!html.includes('"><script'), `${template}: the link cannot break out of its attribute`);
  }
  // the real builders pass product titles through the same path
  const mail = buildSignupConfirmationEmail({ shop: "s.myshopify.com", productTitle: evil, variantTitle: "", productHandle: "x", brand: brand({ emailTemplate: "modern" }) });
  assert.ok(!mail.html.includes("<img src=x"));
});

test("an invalid accent colour or logo falls back to the default look, never into the markup", () => {
  for (const bad of ["red", "#fff", "#12345", "#GGGGGG", "#006F5C;background:url(x)", 'javascript:alert(1)', "", null, 42]) {
    assert.equal(cleanAccent(bad), null, `accent ${JSON.stringify(bad)}`);
    const html = renderEmail(brand({ emailTemplate: "modern", emailAccentColor: bad }), content());
    assert.ok(html.includes(DEFAULT_ACCENT) && !html.includes("url(x)") && !html.includes("javascript:"), `modern with ${JSON.stringify(bad)}`);
  }
  for (const bad of ["http://cdn.example.com/a.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "//cdn.example.com/a.png", "https://", "https://u:p@cdn.example.com/a.png", 'https://cdn.example.com/a".png', "https://cdn.example.com/a b.png", "https://cdn.example.com/<x>.png", `https://cdn.example.com/${"a".repeat(600)}`, "not a url", "", null]) {
    assert.equal(cleanLogoUrl(bad), null, `logo ${JSON.stringify(bad)}`);
    assert.ok(!renderEmail(brand({ emailTemplate: "modern", emailLogoUrl: bad }), content()).includes("<img"), `no image for ${JSON.stringify(bad)}`);
  }
  assert.equal(cleanLogoUrl(` ${LOGO} `), LOGO);
  // junk already stored in the database (or an unknown template) renders the default look
  const DEFAULT_BRAND = { template: "classic", accent: null, logoUrl: null, font: null, header: null };
  assert.deepEqual(brandFromSettings({ emailTemplate: "fancy", emailAccentColor: "red", emailLogoUrl: "http://x", emailFont: "comic", emailHeader: "huge" }), DEFAULT_BRAND);
  assert.deepEqual(brandFromSettings(null), DEFAULT_BRAND);
  assert.equal(brandFromSettings({ emailTemplate: "toString" }).template, "classic", "inherited object keys are not templates");
});

test("the Email templates form validates and keeps defaults as null", () => {
  const f = (o) => new URLSearchParams(o);
  assert.deepEqual(parseEmailLookForm(f({ emailTemplate: "modern", emailAccentColor: "#b42318", emailLogoUrl: LOGO })).data, { emailTemplate: "modern", emailAccentColor: "#B42318", emailLogoUrl: LOGO, emailFont: null, emailHeader: null });
  assert.deepEqual(parseEmailLookForm(f({ emailTemplate: "classic", emailAccentColor: DEFAULT_ACCENT.toLowerCase(), emailLogoUrl: "  " })).data, { emailTemplate: "classic", emailAccentColor: null, emailLogoUrl: null, emailFont: null, emailHeader: null }, "the default accent and a blank logo are stored as unset");
  assert.ok(parseEmailLookForm(f({ emailTemplate: "fancy" })).errors.emailTemplate);
  assert.ok(parseEmailLookForm(f({})).errors.emailTemplate);
  assert.ok(parseEmailLookForm(f({ emailTemplate: "modern", emailAccentColor: "blue" })).errors.emailAccentColor);
  assert.ok(parseEmailLookForm(f({ emailTemplate: "modern", emailLogoUrl: "http://x.com/a.png" })).errors.emailLogoUrl);
});

test("plain-text versions and subjects are identical in every layout", () => {
  const ship = { shop: "s.myshopify.com", productTitle: "Shoe", variantTitle: "Red", orderName: "#1", shipDate: "2026-11-13", productHandle: "shoe" };
  const lines = [{ productTitle: "Shoe", variantTitle: "Red", quantity: 2, shipDate: "2026-11-13", productHandle: "shoe" }];
  const v = variant({ inventoryQuantity: 5 });
  const make = (b) => [
    buildSignupConfirmationEmail({ shop: ship.shop, productTitle: "Shoe", variantTitle: "Red", productHandle: "shoe", brand: b }),
    buildShipEmail("SHIP_REMINDER", { ...ship, brand: b }), buildShipEmail("SHIP_DATE_CHANGE", { ...ship, brand: b }),
    buildPreorderConfirmationEmail({ shop: ship.shop, orderName: "#1", lines, brand: b }),
    buildEmail({ shop: ship.shop, variant: v, settings: { trackClicks: true }, delivery: { trackingToken: "tok_abcdefghijkl" }, brand: b }),
  ];
  const base = make(undefined);
  for (const template of ["modern", "minimal", "bold", "elegant", "dark"]) {
    const styled = make(brand({ emailTemplate: template, emailAccentColor: "#B42318", emailLogoUrl: LOGO }));
    styled.forEach((m, i) => { assert.equal(m.text, base[i].text); assert.equal(m.subject, base[i].subject); assert.notEqual(m.html, base[i].html); });
  }
});

test("the preview builds every email kind in every layout", () => {
  for (const template of Object.keys(EMAIL_TEMPLATES)) for (const kind of Object.keys(PREVIEW_KINDS)) {
    const m = buildPreviewEmail(kind, { shop: "s.myshopify.com", brand: brand({ emailTemplate: template }), settings: null });
    assert.ok(m.subject && m.text && m.html.includes("View the product"), `${template}/${kind}`);
  }
  assert.ok(buildPreviewEmail("nonsense", { shop: "s.myshopify.com", brand: brand(), settings: null }).subject.endsWith("is back in stock"));
});

// ---- delivery paths -----------------------------------------------------------------------------------------------

test("queued restock emails use the saved look and keep click tracking", async () => {
  const shop = newShop();
  const stocked = variant({ inventoryQuantity: 5 });
  await db.shopSettings.create({ data: { shop, trackClicks: true, emailTemplate: "modern", emailAccentColor: "#B42318", emailLogoUrl: LOGO } });
  await addSignup(db, { shop, email: "a@x.com", variant: variant() });
  await enqueueRestock(db, { shop, variant: stocked });
  const mailer = fakeMailer();
  const r = await processQueue(db, { shop, mailer, stockCheck: async () => stocked });
  assert.equal(r.sent, 1);
  const [m] = mailer.sent;
  assert.match(m.html, /^<!doctype html>/);
  assert.ok(m.html.includes("#B42318") && m.html.includes(LOGO));
  const token = (await db.notificationDelivery.findFirst({ where: { shop } })).trackingToken;
  assert.ok(m.html.includes(`href="https://${shop}/apps/waitlist/r/${token}"`), "the tracked link is the button");
  assert.ok(m.text.includes(`/apps/waitlist/r/${token}`) && !m.text.includes("<"), "the text part is untouched");
  assert.equal((await db.notificationDelivery.findFirst({ where: { shop } })).status, "ACCEPTED");
});

test("a shop that never opened the page sends exactly the email it always did", async () => {
  const shop = newShop();
  const stocked = variant({ inventoryQuantity: 5 });
  await addSignup(db, { shop, email: "a@x.com", variant: variant() });
  await enqueueRestock(db, { shop, variant: stocked });
  const mailer = fakeMailer();
  await processQueue(db, { shop, mailer, stockCheck: async () => stocked });
  assert.ok(mailer.sent[0].html.startsWith("<p>Good news! <strong>Shoe (Red)</strong>"));
});

test("queued signup confirmations (the Flow-style sender) use the saved look and still deliver", async () => {
  const shop = newShop();
  await db.shopSettings.create({ data: { shop, emailSignupConfirmation: true, emailTemplate: "minimal", emailAccentColor: "#0B3D91" } });
  const admin = { graphql: async () => ({ json: async () => ({ data: { nodes: [{ id: "gid://shopify/ProductVariant/111", title: "Red", inventoryQuantity: 0, inventoryPolicy: "DENY", product: { id: "gid://shopify/Product/999", title: "Shoe", handle: "shoe" } }] } }) }) };
  const r = await handleSignupRequest({ db, admin, shop, input: { email: "known@x.com", productId: "999", variantId: "111" }, canConfirm: true });
  assert.equal(r.confirmationQueued, true);
  const sent = [];
  const mailer = { channel: "smtp", provider: "gmail", async send(m) { sent.push(m); return { id: "m1" }; } };
  const s = await processFlowDeliveries(db, { shop, mailer });
  assert.equal(s.sent, 1);
  assert.match(sent[0].html, /^<!doctype html>/);
  assert.ok(sent[0].html.includes("#0B3D91") && sent[0].html.includes("Shoe (Red)"));
  assert.equal((await db.notificationDelivery.findFirst({ where: { shop } })).status, "ACCEPTED");
});

test("the Gmail SMTP sender passes the styled HTML and the unchanged text through", async () => {
  const shop = newShop();
  const data = { gmailAddress: "store@gmail.com", gmailPasswordEnc: encryptSecret("abcdefghijklmnop", { shop, env: ENV }), emailTemplate: "modern", emailAccentColor: "#B42318" };
  await db.shopSettings.create({ data: { shop, ...data } });
  const calls = [];
  const transportFactory = () => ({ sendMail: async (m) => { calls.push(m); return { accepted: [m.to], rejected: [], messageId: "<m1@gmail>" }; }, verify: async () => true });
  const mailer = await getShopMailer(db, shop, { env: ENV, transportFactory });
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  const mail = buildEmail({ shop, variant: variant({ inventoryQuantity: 5 }), settings, delivery: null });
  await mailer.send({ to: "c@x.com", ...mail });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].html, mail.html);
  assert.equal(calls[0].text, mail.text);
  assert.match(calls[0].html, /^<!doctype html>/);
});

test("the email settings columns default to the old look and survive being saved", async () => {
  const shop = newShop();
  await db.shopSettings.create({ data: { shop } });
  let row = await db.shopSettings.findUnique({ where: { shop } });
  assert.deepEqual([row.emailTemplate, row.emailAccentColor, row.emailLogoUrl, row.emailFont, row.emailHeader], ["classic", null, null, null, null]);
  await db.shopSettings.update({ where: { shop }, data: parseEmailLookForm(new URLSearchParams({ emailTemplate: "minimal", emailAccentColor: "#B42318", emailLogoUrl: LOGO })).data });
  row = await db.shopSettings.findUnique({ where: { shop } });
  assert.deepEqual(brandFromSettings(row), { template: "minimal", accent: "#B42318", logoUrl: LOGO, font: null, header: null });
});

// ---- Bold, Elegant, Dark, fonts and headers -------------------------------------------------------------------------

const html = (over, c = content()) => renderEmail(brand(over), c);

test("Bold, Elegant and Dark each have their own design", () => {
  const bold = html({ emailTemplate: "bold", emailAccentColor: "#B42318" });
  assert.ok(bold.includes('bgcolor="#B42318"') && bold.includes("font-size:24px"), "Bold: accent band and a large first line");
  assert.equal(bold.match(/font-size:24px/g).length, 1, "only the first paragraph is large");
  const elegant = html({ emailTemplate: "elegant" });
  assert.ok(elegant.includes("Georgia") && elegant.includes("text-align:center"), "Elegant: serif and centred");
  const darkMail = html({ emailTemplate: "dark" });
  assert.ok(darkMail.includes("#1c1d20") && darkMail.includes("#e8eaed") && darkMail.includes('content="dark light"'), "Dark: dark card, light text");
  assert.equal(new Set(["bold", "elegant", "dark", "modern", "minimal"].map((t) => html({ emailTemplate: t }))).size, 5, "all different");
});

test("font style: system stacks only, template default when unset, applied to every layout", () => {
  assert.deepEqual(Object.keys(EMAIL_FONTS), ["sans", "serif", "rounded"]);
  for (const template of Object.keys(EMAIL_TEMPLATES)) {
    const serif = html({ emailTemplate: template, emailFont: "serif" });
    const rounded = html({ emailTemplate: template, emailFont: "rounded" });
    assert.ok(serif.includes("Georgia"), `${template}: serif`);
    assert.ok(rounded.includes("ui-rounded") && rounded.includes("Trebuchet MS"), `${template}: rounded`);
    assert.ok(!/@font-face|fonts\.googleapis|url\(/i.test(serif + rounded), `${template}: no web fonts`);
  }
  assert.ok(html({ emailTemplate: "modern" }).includes("-apple-system") && !html({ emailTemplate: "modern" }).includes("Georgia"), "sans is the default");
  assert.ok(html({ emailTemplate: "elegant", emailFont: "sans" }).includes("-apple-system") && !html({ emailTemplate: "elegant", emailFont: "sans" }).includes("Georgia"), "an explicit choice beats the template's own font");
  assert.ok(html({ emailTemplate: "classic", emailFont: "serif" }).startsWith('<div style="font-family:Georgia'), "Classic wraps its markup only when a font is chosen");
  assert.equal(html({ emailTemplate: "modern", emailFont: "comic sans" }), html({ emailTemplate: "modern" }), "an unknown font falls back to the default");
});

test("header style: logo, store name or hidden, in every layout", () => {
  assert.deepEqual(Object.keys(EMAIL_HEADERS), ["logo", "name", "none"]);
  const shop = "s.myshopify.com";
  for (const template of Object.keys(EMAIL_TEMPLATES)) {
    const visible = (out) => out.replace(/<title>.*?<\/title>/, ""); // the document title is not the header
    const withLogo = (header) => visible(html({ emailTemplate: template, emailLogoUrl: LOGO, emailHeader: header }));
    const noLogo = (header) => visible(html({ emailTemplate: template, emailHeader: header }));
    assert.ok(withLogo("logo").includes(`<img src="${LOGO}"`), `${template}: logo`);
    assert.ok(!withLogo("name").includes("<img") && withLogo("name").includes(`>${shop}<`), `${template}: name even when a logo is set`);
    assert.ok(!withLogo("none").includes("<img"), `${template}: hidden hides the logo`);
    assert.ok(!noLogo("none").includes(`>${shop}<`), `${template}: hidden hides the name`);
    assert.ok(noLogo("logo").includes(`>${shop}<`) === (template !== "classic"), `${template}: "logo" without a logo address shows the name (Classic shows nothing)`);
    assert.ok(withLogo(undefined).includes("<img"), `${template}: unset shows the logo when there is one`);
  }
  assert.equal(html({ emailTemplate: "modern", emailHeader: "huge" }), html({ emailTemplate: "modern" }), "an unknown header falls back to the default");
});

test("fonts and headers are validated on save, blank meaning the template default", () => {
  const f = (o) => new URLSearchParams({ emailTemplate: "bold", ...o });
  assert.deepEqual([parseEmailLookForm(f({ emailFont: "serif", emailHeader: "none" })).data.emailFont, parseEmailLookForm(f({ emailFont: "serif", emailHeader: "none" })).data.emailHeader], ["serif", "none"]);
  assert.deepEqual([parseEmailLookForm(f({ emailFont: "", emailHeader: "" })).data.emailFont, parseEmailLookForm(f({ emailFont: "", emailHeader: "" })).data.emailHeader], [null, null]);
  assert.ok(parseEmailLookForm(f({ emailFont: "comic" })).errors.emailFont);
  assert.ok(parseEmailLookForm(f({ emailHeader: "huge" })).errors.emailHeader);
  assert.ok(parseEmailLookForm(f({ emailTemplate: "toString" })).errors.emailTemplate);
});

test("a shop that saved the first version's look (no font or header) keeps it exactly", async () => {
  const shop = newShop();
  await db.shopSettings.create({ data: { shop, emailTemplate: "modern", emailAccentColor: "#B42318", emailLogoUrl: LOGO } });
  const row = await db.shopSettings.findUnique({ where: { shop } });
  assert.deepEqual([row.emailFont, row.emailHeader], [null, null]);
  assert.equal(renderEmail(brandFromSettings(row), content()), html({ emailTemplate: "modern", emailAccentColor: "#B42318", emailLogoUrl: LOGO }));
});

test("the new layouts escape every dynamic value, including with a font and header set", () => {
  const evil = `<img src=x onerror=alert(1)>"'&`;
  for (const template of ["bold", "elegant", "dark"]) for (const header of ["logo", "name", "none"]) {
    const out = renderEmail(brand({ emailTemplate: template, emailAccentColor: "#B42318", emailLogoUrl: LOGO, emailFont: "rounded", emailHeader: header }), {
      shop: `${evil}.myshopify.com`, paragraphs: [evil, ["x ", { strong: evil }]], button: { label: evil, url: `https://s.myshopify.com/?a="><script>alert(1)</script>` }, footer: evil,
    });
    assert.ok(!/<img src=x/i.test(out) && !out.includes("<script>") && !out.includes('"><script'), `${template}/${header}`);
    assert.ok(out.includes("&lt;img src=x onerror=alert(1)&gt;"), `${template}/${header}: shown as text`);
  }
});

test("the preview and test-send helpers cover every template with font and header set", () => {
  for (const template of Object.keys(EMAIL_TEMPLATES)) for (const kind of Object.keys(PREVIEW_KINDS)) {
    const m = buildPreviewEmail(kind, { shop: "s.myshopify.com", brand: brand({ emailTemplate: template, emailFont: "serif", emailHeader: "name" }), settings: null });
    assert.ok(m.html.includes("View the product") && m.text.length > 0, `${template}/${kind}`);
  }
});
