// Runs the real block markup + JS + CSS in headless Chrome against a mocked
// backend. Run via `npm run test:storefront`. Skips if Chrome is not installed.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBlock } from "./render.mjs";

const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(CHROME)) { console.log("SKIP  Chrome not found (set CHROME_BIN)"); process.exit(0); }
const ASSETS = new URL("../../extensions/waitlist-preorder/assets/", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "wp-sf-"));
for (const f of readdirSync(ASSETS)) copyFileSync(join(ASSETS, f), join(dir, f));

const V = (id, o = {}) => ({ id, available: false, tracked: true, quantity: 0, ...o });
const ALL = (list) => list; // clarity
const cfgVariant = (variantId, o = {}) => ({ variantId: String(variantId), buttonText: "Reserve Yours", shipDate: "2026-12-24", remaining: 3, soldOut: false, ...o });

// Each scenario: store state + a driver script. `t` records assertions in the page.
const scenarios = [
  {
    name: "sold-out variant, waitlist on: Notify Me shown; pre-order hidden",
    variants: [V(1)], initial: 1, config: { waitlistEnabled: true, variants: [] },
    run: `
      t(vis('[data-wp-waitlist]'), 'waitlist block visible');
      t(!vis('[data-wp-preorder]'), 'pre-order block hidden');
      t(q('[data-wp-open]').textContent.trim() === 'Notify Me When Available', 'default button text');`,
  },
  {
    name: "in-stock variant: neither block shows (normal Add to Cart)",
    variants: [V(1, { available: true, quantity: 5 })], initial: 1, config: { waitlistEnabled: true, variants: [cfgVariant(1)] },
    run: `t(!vis('[data-wp-waitlist]'), 'waitlist hidden'); t(!vis('[data-wp-preorder]'), 'pre-order hidden');`,
  },
  {
    name: "waitlist disabled in app settings: no Notify Me",
    variants: [V(1)], initial: 1, config: { waitlistEnabled: false, variants: [] },
    run: `t(!vis('[data-wp-waitlist]'), 'waitlist hidden'); t(!vis('[data-wp-preorder]'), 'pre-order hidden');`,
  },
  {
    name: "config endpoint down: nothing shown (fails closed)",
    variants: [V(1)], initial: 1, config: null,
    run: `t(!vis('[data-wp-waitlist]'), 'waitlist hidden'); t(!vis('[data-wp-preorder]'), 'pre-order hidden');`,
  },
  {
    name: "pre-order enabled & out of stock: Pre-Order shown with date + quota; no double buttons",
    variants: [V(1, { available: true })], initial: 1, config: { waitlistEnabled: true, variants: [cfgVariant(1)] },
    run: `
      t(vis('[data-wp-preorder]'), 'pre-order visible');
      t(q('[data-wp-button]').textContent === 'Reserve Yours', 'per-variant button text');
      t(/December/.test(q('[data-wp-ships]').textContent) && /24/.test(q('[data-wp-ships]').textContent) && /2026/.test(q('[data-wp-ships]').textContent), 'ship date shown: ' + q('[data-wp-ships]').textContent);
      t(q('[data-wp-ships]').textContent.includes('3 left'), 'quota shown');
      t(!vis('[data-wp-waitlist]'), 'waitlist hidden while pre-order active');`,
  },
  {
    name: "pre-order sold out (but variant unavailable): clear sold-out message, no button, waitlist offered",
    variants: [V(1)], initial: 1, config: { waitlistEnabled: true, variants: [cfgVariant(1, { remaining: 0, soldOut: true })] },
    run: `t(vis('[data-wp-closed]') && !vis('[data-wp-button]'), 'sold-out message, no button'); t(vis('[data-wp-waitlist]'), 'waitlist shown');`,
  },
  {
    name: "explicit opt-in shows both buttons",
    variants: [V(1)], initial: 1, config: { waitlistEnabled: true, variants: [cfgVariant(1)] },
    waitlistSettings: { show_with_preorder: true },
    run: `t(vis('[data-wp-preorder]'), 'pre-order visible'); t(vis('[data-wp-waitlist]'), 'waitlist visible (opted in)');`,
  },
  {
    name: "variant change: visibility and variant id follow the selection (no stale state)",
    variants: [V(1), V(2, { available: true, quantity: 4 }), V(3, { available: true })], initial: 1,
    config: { waitlistEnabled: true, variants: [cfgVariant(3, { buttonText: 'Pre-Order Blue' })] },
    run: `
      t(vis('[data-wp-waitlist]') && !vis('[data-wp-preorder]'), 'v1: waitlist only');
      await pick(2);
      t(!vis('[data-wp-waitlist]') && !vis('[data-wp-preorder]'), 'v2 (in stock): neither');
      await pick(3);
      t(vis('[data-wp-preorder]') && !vis('[data-wp-waitlist]'), 'v3: pre-order only');
      t(q('[data-wp-button]').textContent === 'Pre-Order Blue', 'v3 text');
      await pick(1);
      t(vis('[data-wp-waitlist]') && !vis('[data-wp-preorder]'), 'back to v1: waitlist only');
      // signup posts the CURRENTLY selected variant
      q('[data-wp-open]').click();
      q('[name=email]').value = 'shopper@example.com';
      q('[data-wp-form]').requestSubmit();
      await sleep(100);
      const body = JSON.parse(calls.find((c) => c.url.includes('/signup')).body);
      t(body.variantId === '1' && body.productId === '999', 'signup used variant 1 / product 999: ' + JSON.stringify(body));`,
  },
  {
    name: "waitlist form: accessible open/close, validation, success",
    variants: [V(1)], initial: 1, config: { waitlistEnabled: true, variants: [] },
    run: `
      const open = q('[data-wp-open]'); const form = q('[data-wp-form]');
      t(form.hidden && open.getAttribute('aria-expanded') === 'false', 'form closed initially');
      open.click();
      t(!form.hidden && open.getAttribute('aria-expanded') === 'true', 'form opens, aria-expanded true');
      t(document.activeElement === q('[name=email]'), 'focus moves to email');
      const label = document.querySelector('label[for="' + q('[name=email]').id + '"]');
      t(label && label.textContent.trim().length > 0, 'email has a visible label');
      t(q('[data-wp-status]').getAttribute('role') === 'status' && q('[data-wp-status]').getAttribute('aria-live') === 'polite', 'status is a polite live region');
      q('[name=email]').value = 'not-an-email';
      form.requestSubmit(); await sleep(50);
      t(q('[data-wp-status]').dataset.state === 'error' && q('[name=email]').getAttribute('aria-invalid') === 'true', 'client validation error shown');
      t(!calls.some((c) => c.url.includes('/signup')), 'no request for invalid email');
      q('[name=email]').value = 'ok@example.com';
      form.requestSubmit(); await sleep(100);
      t(q('[data-wp-status]').dataset.state === 'success' && q('[data-wp-status]').textContent.includes('email you'), 'success message shown');
      t(form.hidden, 'form closes after success');`,
  },
  {
    name: "waitlist: server error is shown and the form stays usable",
    variants: [V(1)], initial: 1, config: { waitlistEnabled: true, variants: [] }, signup: { status: 409, body: { ok: false, message: 'This item is currently in stock.' } },
    run: `
      q('[data-wp-open]').click(); q('[name=email]').value = 'a@example.com'; q('[data-wp-form]').requestSubmit(); await sleep(100);
      t(q('[data-wp-status]').dataset.state === 'error' && q('[data-wp-status]').textContent === 'This item is currently in stock.', 'server message shown');
      t(!q('[data-wp-submit]').disabled && !q('[data-wp-form]').hidden, 'can retry');`,
  },
  {
    name: "waitlist: Escape closes the form and returns focus",
    variants: [V(1)], initial: 1, config: { waitlistEnabled: true, variants: [] },
    run: `
      q('[data-wp-open]').click();
      q('[name=email]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      t(q('[data-wp-form]').hidden && document.activeElement === q('[data-wp-open]'), 'closed + focus restored');`,
  },
  {
    name: "pre-order click: re-checks quota, posts variant/qty/properties to /cart/add.js, then goes to checkout",
    variants: [V(7, { available: true })], initial: 7, config: { waitlistEnabled: true, variants: [cfgVariant(7)] },
    run: `
      q('[data-wp-qty]').value = '2';
      q('[data-wp-button]').click(); await sleep(150);
      const add = calls.find((c) => c.url === '/cart/add.js');
      t(!!add, 'cart add called');
      const item = JSON.parse(add.body).items[0];
      t(item.id === 7 && item.quantity === 2, 'variant 7, qty 2: ' + JSON.stringify(item));
      t(item.properties._preorder === 'true' && /December/.test(item.properties['Expected shipping']) && item.properties._preorder_ship_date === '2026-12-24', 'pre-order properties kept: ' + JSON.stringify(item.properties));
      t(calls.findIndex((c) => c.url.includes('/config')) < calls.indexOf(add), 'quota re-validated before cart add');
      t(navigated === '/checkout', 'sent to checkout: ' + navigated);`,
  },
  // --- Smart campaigns ---
  {
    name: "campaign: click reserves units first, then adds to the cart with the reservation id, then checkout",
    variants: [V(7, { available: true })], initial: 7, config: { waitlistEnabled: true, variants: [cfgVariant(7, { phase: "active" })] },
    run: `
      q('[data-wp-qty]').value = '2';
      q('[data-wp-button]').click(); await sleep(250);
      const reserveIdx = calls.findIndex((c) => c.url.indexOf('/apps/waitlist/reserve') === 0 && JSON.parse(c.body).intent === 'reserve');
      const addIdx = calls.findIndex((c) => c.url === '/cart/add.js');
      t(reserveIdx > -1 && addIdx > reserveIdx, 'reserve happens before cart add');
      const body = JSON.parse(calls[reserveIdx].body);
      t(body.variantId === '7' && body.productId === '999' && body.quantity === 2, 'reserve body: ' + calls[reserveIdx].body);
      const item = JSON.parse(calls[addIdx].body).items[0];
      t(item.properties._preorder_reservation === 'res1' && item.properties._preorder === 'true', 'reservation id travels with the line: ' + JSON.stringify(item.properties));
      t(navigated === '/checkout', 'checkout');`,
  },
  {
    name: "campaign: reservation refused (limit) -> message shown, nothing added to the cart",
    variants: [V(7, { available: true })], initial: 7, config: { waitlistEnabled: true, variants: [cfgVariant(7, { phase: "active", remaining: 5 })] },
    reserve: { status: 409, body: { ok: false, error: "limit", message: "Only 1 left for pre-order." } },
    run: `
      q('[data-wp-button]').click(); await sleep(250);
      t(!calls.some((c) => c.url === '/cart/add.js'), 'cart untouched');
      t(q('[data-wp-preorder] [data-wp-status]').textContent === 'Only 1 left for pre-order.', 'message: ' + q('[data-wp-preorder] [data-wp-status]').textContent);
      t(!q('[data-wp-button]').disabled, 'button usable again'); t(navigated === null, 'no navigation');`,
  },
  {
    name: "campaign: if the cart add fails after a reservation, the hold is released",
    variants: [V(7, { available: true })], initial: 7, config: { waitlistEnabled: true, variants: [cfgVariant(7, { phase: "active" })] },
    cart: { status: 422, body: { description: "Cart error" } },
    run: `
      q('[data-wp-button]').click(); await sleep(300);
      const rel = calls.find((c) => c.url.indexOf('/apps/waitlist/reserve') === 0 && JSON.parse(c.body).intent === 'release');
      t(rel && JSON.parse(rel.body).reservationId === 'res1', 'release sent for res1');
      t(q('[data-wp-preorder] [data-wp-status]').textContent === 'Cart error', 'cart error shown');`,
  },
  {
    name: "campaign scheduled with countdown: shows 'opens in', no button; becomes purchasable when it starts (no reload)",
    variants: [V(7, { available: false })], initial: 7, switchAfter: { ms: 1500, config: { waitlistEnabled: true, serverNow: "2026-11-01T00:00:03.000Z", variants: [cfgVariant(7, { phase: "active", campaign: { name: "Launch", startsAt: "2026-11-01T00:00:01.000Z", endsAt: null, countdown: true, progress: null } })] } },
    config: { waitlistEnabled: true, serverNow: "2026-11-01T00:00:00.000Z", variants: [cfgVariant(7, { phase: "scheduled", soldOut: true, campaign: { name: "Launch", startsAt: "2026-11-01T00:00:01.000Z", endsAt: null, countdown: true, progress: null } })] },
    run: `
      t(vis('[data-wp-preorder]') && vis('[data-wp-countdown]'), 'countdown shown');
      t(/Pre-orders open in/.test(q('[data-wp-countdown]').textContent), 'label: ' + q('[data-wp-countdown]').textContent);
      t(q('[data-wp-countdown]').getAttribute('role') === 'timer', 'countdown has role=timer');
      t(!vis('[data-wp-button]'), 'no pre-order button yet');
      await sleep(5000);
      t(vis('[data-wp-button]'), 'Pre-Order button visible once started');
      t(!vis('[data-wp-waitlist]'), 'waitlist hidden once pre-order is live');`,
  },
  {
    name: "campaign scheduled WITHOUT countdown: pre-order block stays hidden; waitlist still offered",
    variants: [V(7, { available: false })], initial: 7,
    config: { waitlistEnabled: true, serverNow: "2026-11-01T00:00:00.000Z", variants: [cfgVariant(7, { phase: "scheduled", soldOut: true, campaign: { name: "Launch", startsAt: "2026-11-05T00:00:00.000Z", endsAt: null, countdown: false, progress: null } })] },
    run: `t(!vis('[data-wp-preorder]'), 'hidden'); t(vis('[data-wp-waitlist]'), 'waitlist offered');`,
  },
  {
    name: "campaign active: closing-time countdown and a verified-sales progress bar (accessible)",
    variants: [V(7, { available: true })], initial: 7,
    config: { waitlistEnabled: true, serverNow: "2026-11-01T00:00:00.000Z", variants: [cfgVariant(7, { phase: "active", campaign: { name: "Launch", startsAt: null, endsAt: "2026-11-02T01:02:03.000Z", countdown: true, progress: { sold: 2, target: 8 } } })] },
    run: `
      t(/Pre-orders close in/.test(q('[data-wp-countdown]').textContent) && /1d 01:02:0[0-9]/.test(q('[data-wp-countdown]').textContent), 'closing countdown: ' + q('[data-wp-countdown]').textContent);
      const p = q('[data-wp-progress] progress');
      t(p && p.value === 2 && p.max === 8, 'progress element 2/8');
      t(p.getAttribute('aria-label') && /pre-ordered/.test(q('[data-wp-progress]').textContent) && /2 of 8/.test(q('[data-wp-progress]').textContent), 'text alternative: ' + q('[data-wp-progress]').textContent);`,
  },
  {
    name: "campaign without progress/countdown flags shows neither",
    variants: [V(7, { available: true })], initial: 7,
    config: { waitlistEnabled: true, variants: [cfgVariant(7, { phase: "active", campaign: { name: "Launch", startsAt: null, endsAt: "2026-11-02T00:00:00.000Z", countdown: false, progress: null } })] },
    run: `t(vis('[data-wp-button]'), 'button'); t(!vis('[data-wp-countdown]') && !vis('[data-wp-progress]'), 'no countdown/progress');`,
  },
  {
    name: "campaign ended: clear closed message, no button, native buttons hidden, waitlist offered even before a reload",
    variants: [V(7, { available: true })], initial: 7,
    config: { waitlistEnabled: true, variants: [cfgVariant(7, { phase: "ended", soldOut: true, remaining: 3 })] },
    run: `
      t(vis('[data-wp-closed]') && /ended/i.test(q('[data-wp-closed]').textContent), 'ended message: ' + q('[data-wp-closed]').textContent);
      t(q('[data-wp-closed]').getAttribute('role') === 'status', 'announced politely');
      t(!vis('[data-wp-button]'), 'no pre-order button');
      const n = nat(); t(!n.add && !n.buy, 'native purchase buttons hidden (selling is closed)');
      t(vis('[data-wp-waitlist]'), 'waitlist offered after the campaign closed');`,
  },
  {
    name: "campaign sold out: sold-out message, no button, waitlist offered",
    variants: [V(7, { available: true })], initial: 7,
    config: { waitlistEnabled: true, variants: [cfgVariant(7, { phase: "sold_out", soldOut: true, remaining: 0 })] },
    run: `
      t(vis('[data-wp-closed]') && /no longer available/i.test(q('[data-wp-closed]').textContent), 'sold-out message: ' + q('[data-wp-closed]').textContent);
      t(!vis('[data-wp-button]') && vis('[data-wp-waitlist]'), 'no button, waitlist shown');`,
  },
  {
    name: "campaign closed but waitlist disabled in settings: message only, no Notify Me",
    variants: [V(7, { available: true })], initial: 7,
    config: { waitlistEnabled: false, variants: [cfgVariant(7, { phase: "ended", soldOut: true })] },
    run: `t(vis('[data-wp-closed]'), 'message'); t(!vis('[data-wp-waitlist]'), 'no waitlist');`,
  },
  {
    name: "campaign paused: pre-order block hidden, waitlist offered",
    variants: [V(7, { available: false })], initial: 7,
    config: { waitlistEnabled: true, variants: [cfgVariant(7, { phase: "paused", soldOut: true })] },
    run: `t(!vis('[data-wp-preorder]'), 'hidden'); t(vis('[data-wp-waitlist]'), 'waitlist');`,
  },
  {
    name: "campaign: an in-stock variant is never touched (normal purchase, no closed message)",
    variants: [V(7, { available: true, quantity: 12 })], initial: 7,
    config: { waitlistEnabled: true, variants: [cfgVariant(7, { phase: "ended", soldOut: true })] },
    run: `const n = nat(); t(n.add && n.buy, 'native buttons stay'); t(!vis('[data-wp-preorder]') && !vis('[data-wp-waitlist]') && !vis('[data-wp-closed]'), 'nothing shown');`,
  },
  {
    name: "pre-order: quantity above quota is refused and cart untouched",
    variants: [V(7, { available: true })], initial: 7, config: { waitlistEnabled: true, variants: [cfgVariant(7, { remaining: 2 })] },
    run: `
      q('[data-wp-qty]').value = '5';
      q('[data-wp-button]').click(); await sleep(150);
      t(!calls.some((c) => c.url === '/cart/add.js'), 'cart not called');
      t(q('[data-wp-preorder] [data-wp-status]').dataset.state === 'error' && q('[data-wp-preorder] [data-wp-status]').textContent.includes('Only 2'), 'quota message: ' + q('[data-wp-preorder] [data-wp-status]').textContent);
      t(navigated === null, 'no navigation');`,
  },
  {
    name: "pre-order: Shopify cart error is shown",
    variants: [V(7, { available: true })], initial: 7, config: { waitlistEnabled: true, variants: [cfgVariant(7)] }, cart: { status: 422, body: { description: 'All 0 are in your cart.' } },
    run: `
      q('[data-wp-button]').click(); await sleep(150);
      t(q('[data-wp-preorder] [data-wp-status]').dataset.state === 'error' && q('[data-wp-preorder] [data-wp-status]').textContent.includes('in your cart'), 'cart error shown');
      t(!q('[data-wp-button]').disabled, 'button re-enabled'); t(navigated === null, 'no navigation');`,
  },
  {
    name: "pre-order setting: 'go to cart' after add",
    variants: [V(7, { available: true })], initial: 7, config: { waitlistEnabled: true, variants: [cfgVariant(7)] }, preorderSettings: { after_add: 'cart' },
    run: `q('[data-wp-button]').click(); await sleep(150); t(navigated === '/cart', 'went to cart: ' + navigated);`,
  },
  {
    name: "merchant settings: custom text and colors are applied",
    variants: [V(1)], initial: 1, config: { waitlistEnabled: true, variants: [] },
    waitlistSettings: { button_text: 'Tell me!', button_color: '#ff0000', text_color: '#00ff00', corner_radius: 12 },
    run: `
      const b = q('[data-wp-open]');
      t(b.textContent.trim() === 'Tell me!', 'custom text');
      const cs = getComputedStyle(b);
      t(cs.backgroundColor === 'rgb(255, 0, 0)' && cs.color === 'rgb(0, 255, 0)', 'custom colors: ' + cs.backgroundColor + ' / ' + cs.color);
      t(cs.borderTopLeftRadius === '12px', 'custom radius');`,
  },
  {
    name: "outline style, centered, fit-to-text, custom size/weight/padding/border (waitlist)",
    variants: [V(1)], initial: 1, config: { waitlistEnabled: true, variants: [] }, width: 1000,
    waitlistSettings: { button_style: 'outline', button_color: '#0000ff', button_align: 'center', button_width: 'auto', font_size: 20, font_weight: '700', padding_y: 20, border_width: 3 },
    run: `
      const b = q('[data-wp-open]'); const cs = getComputedStyle(b);
      t(cs.backgroundColor === 'rgba(0, 0, 0, 0)' && cs.color === 'rgb(0, 0, 255)', 'outline: transparent bg, colored text: ' + cs.backgroundColor + ' / ' + cs.color);
      t(cs.borderTopWidth === '3px' && cs.borderTopColor === 'rgb(0, 0, 255)', 'border width/color: ' + cs.borderTopWidth + ' ' + cs.borderTopColor);
      t(cs.fontSize === '20px' && cs.fontWeight === '700', 'font size/weight');
      t(cs.paddingTop === '20px', 'vertical padding');
      t(getComputedStyle(q('[data-wp-waitlist]')).textAlign === 'center', 'centered');
      t(b.getBoundingClientRect().width < 500, 'fit to text, not full width: ' + b.getBoundingClientRect().width);`,
  },
  {
    name: "always-full-width option, and responsive default is full on mobile (pre-order)",
    variants: [V(7, { available: true })], initial: 7, config: { waitlistEnabled: true, variants: [cfgVariant(7)] }, width: 1000,
    preorderSettings: { button_width: 'full' },
    run: `
      const w = q('[data-wp-preorder]').getBoundingClientRect().width;
      t(Math.abs(q('[data-wp-button]').getBoundingClientRect().width - w) < 2, 'button spans the block width');`,
  },
  {
    name: "responsive width default on mobile fills the row",
    variants: [V(7, { available: true })], initial: 7, config: { waitlistEnabled: true, variants: [cfgVariant(7)] }, width: 375,
    run: `
      const w = q('[data-wp-preorder]').getBoundingClientRect().width;
      t(Math.abs(q('[data-wp-button]').getBoundingClientRect().width - w) < 2, 'full width on mobile');
      t(document.documentElement.scrollWidth <= window.innerWidth, 'no horizontal scroll');`,
  },
  {
    name: "mobile (375px): no horizontal overflow, buttons usable",
    variants: [V(1)], initial: 1, config: { waitlistEnabled: true, variants: [] }, width: 375,
    run: `
      q('[data-wp-open]').click();
      t(document.documentElement.scrollWidth <= window.innerWidth, 'no horizontal scroll (' + document.documentElement.scrollWidth + ' vs ' + window.innerWidth + ')');
      const r = q('[data-wp-open]').getBoundingClientRect();
      t(r.width <= window.innerWidth && r.height >= 40, 'button fits and is tap-sized: ' + r.width + 'x' + r.height);`,
  },
  {
    name: "desktop (1280px): button is not full-bleed",
    variants: [V(1)], initial: 1, config: { waitlistEnabled: true, variants: [] }, width: 1280,
    run: `t(q('[data-wp-open]').getBoundingClientRect().width < 600, 'compact button on desktop');`,
  },
  // --- Native purchase buttons (theme's Add to cart / Buy it now) ---
  {
    name: "native 1: in stock, not configured -> native buttons visible, no app buttons",
    variants: [V(1, { available: true, quantity: 7 })], initial: 1, config: { waitlistEnabled: true, variants: [] },
    run: `const n = nat(); t(n.add && n.buy, 'native Add to cart + Buy it now visible'); t(!vis('[data-wp-waitlist]') && !vis('[data-wp-preorder]'), 'no app buttons');`,
  },
  {
    name: "native 1b: in stock + pre-order configured (not yet 0) -> native buttons stay",
    variants: [V(1, { available: true, quantity: 7 })], initial: 1, config: { waitlistEnabled: true, variants: [cfgVariant(1)] },
    run: `const n = nat(); t(n.add && n.buy, 'native visible'); t(!vis('[data-wp-preorder]'), 'pre-order hidden');`,
  },
  {
    name: "native (Dawn): Shop Pay installments form earlier in the section does not steal the hiding; the real buy form is hidden",
    variants: [V(1, { available: false })], initial: 1, installmentForm: true, config: { waitlistEnabled: true, variants: [] },
    run: `
      const n = nat(); t(vis('[data-wp-waitlist]'), 'Waitlist shown'); t(!n.add && !n.buy, 'native Add to cart / Buy it now hidden');
      t(q('form.installment').getAttribute('data-wp-hide-native') === null, 'installments form untouched');`,
  },
  {
    name: "native 2: sold out + pre-order configured -> ONLY Pre-Order; native Add to cart/Buy it now hidden; no native flash while loading",
    variants: [V(1, { available: true, quantity: 0 })], initial: 1, configDelays: [0, 900], config: { waitlistEnabled: true, variants: [cfgVariant(1)] },
    run: `
      await sleep(900);
      const n = nat(); t(!n.add && !n.buy, 'native hidden'); t(vis('[data-wp-preorder]') && !vis('[data-wp-waitlist]'), 'only Pre-Order');
      t(!window.__flash.nat, 'native purchase buttons never visible while pre-order config was loading');
      t(n.other, 'other product section untouched');`,
  },
  {
    name: "native 3: sold out, not configured -> ONLY Waitlist; native hidden",
    variants: [V(1, { available: false, quantity: 0 })], initial: 1, config: { waitlistEnabled: true, variants: [] },
    run: `const n = nat(); t(!n.add && !n.buy, 'native hidden'); t(vis('[data-wp-waitlist]') && !vis('[data-wp-preorder]'), 'only Waitlist'); t(n.other, 'other product section untouched');`,
  },
  {
    name: "native 3b: sold out but merchant allows backorders (purchasable), not configured -> native flow preserved",
    variants: [V(1, { available: true, quantity: 0 })], initial: 1, config: { waitlistEnabled: true, variants: [] },
    run: `const n = nat(); t(n.add && n.buy, 'native visible (valid purchase)'); t(!vis('[data-wp-waitlist]') && !vis('[data-wp-preorder]'), 'no app buttons');`,
  },
  {
    name: "native 4: switching variants toggles native buttons with the app buttons, other variants/products untouched",
    variants: [V(1, { available: true, quantity: 5 }), V(2, { available: true, quantity: 0 }), V(3, { available: false })], initial: 1,
    config: { waitlistEnabled: true, variants: [cfgVariant(2)] },
    run: `
      let n = nat(); t(n.add && n.buy, 'v1 in stock: native visible');
      await pick(2); n = nat(); t(!n.add && !n.buy && vis('[data-wp-preorder]'), 'v2 pre-order: native hidden');
      await pick(3); n = nat(); t(!n.add && !n.buy && vis('[data-wp-waitlist]') && !vis('[data-wp-preorder]'), 'v3 waitlist: native hidden');
      await pick(1); n = nat(); t(n.add && n.buy && !vis('[data-wp-waitlist]') && !vis('[data-wp-preorder]'), 'back to v1: native restored');
      t(n.other, 'other product section untouched throughout');`,
  },
  {
    name: "native 5: pre-order disabled/removed -> sold-out variant falls back to Waitlist; native stays hidden (unpurchasable)",
    variants: [V(1, { available: false })], initial: 1, config: { waitlistEnabled: true, variants: [] },
    run: `const n = nat(); t(vis('[data-wp-waitlist]') && !vis('[data-wp-preorder]'), 'Waitlist'); t(!n.add && !n.buy, 'native hidden');`,
  },
  {
    name: "native: waitlist disabled in app and sold out -> native restored (nothing replaces it)",
    variants: [V(1, { available: false })], initial: 1, config: { waitlistEnabled: false, variants: [] },
    run: `const n = nat(); t(n.add && n.buy, 'native visible'); t(!vis('[data-wp-waitlist]'), 'no Waitlist');`,
  },
  {
    name: "native: failed config request -> app buttons hidden and native not left hidden",
    variants: [V(1, { available: true, quantity: 0 })], initial: 1, config: null,
    run: `const n = nat(); t(n.add && n.buy, 'native visible'); t(!vis('[data-wp-waitlist]') && !vis('[data-wp-preorder]'), 'no app buttons');`,
  },
  {
    name: "native: merchant setting 'hide theme buttons' off keeps native buttons",
    variants: [V(1, { available: false })], initial: 1, config: { waitlistEnabled: true, variants: [] },
    waitlistSettings: { hide_native_buttons: false }, preorderSettings: { hide_native_buttons: false },
    run: `const n = nat(); t(vis('[data-wp-waitlist]'), 'Waitlist shown'); t(n.add && n.buy, 'native kept');`,
  },
  {
    name: "native: Waitlist block alone hides natives; Pre-order block alone hides natives",
    variants: [V(1, { available: false })], initial: 1, config: { waitlistEnabled: true, variants: [] }, onlyWaitlist: true,
    run: `const n = nat(); t(vis('[data-wp-waitlist]') && !n.add && !n.buy, 'waitlist-only page');`,
  },
  {
    name: "native: Pre-order block alone hides natives",
    variants: [V(1, { available: true, quantity: 0 })], initial: 1, config: { waitlistEnabled: true, variants: [cfgVariant(1)] }, onlyPreorder: true,
    run: `const n = nat(); t(vis('[data-wp-preorder]') && !n.add && !n.buy, 'pre-order-only page');`,
  },
  {
    name: "native: theme editor preview-always waitlist on an in-stock variant does not hide natives",
    variants: [V(1, { available: true, quantity: 5 })], initial: 1, designMode: true, waitlistSettings: { show_when_available: true },
    config: { waitlistEnabled: true, variants: [] },
    run: `t(vis('[data-wp-waitlist]'), 'preview button shown'); const n = nat(); t(n.add && n.buy, 'native kept in preview');`,
  },
  // --- Visibility matrix (selected variant x pre-order config) ---
  {
    name: "visibility 1: in-stock selected variant hides both app buttons (even when pre-order is configured)",
    variants: [V(1, { available: true, quantity: 4 })], initial: 1, config: { waitlistEnabled: true, variants: [cfgVariant(1)] },
    run: `t(!vis('[data-wp-waitlist]'), 'no Notify Me'); t(!vis('[data-wp-preorder]'), 'no Pre-Order'); t(!window.__flash.wl && !window.__flash.po, 'never flashed either button');`,
  },
  {
    name: "visibility 2: sold-out + pre-order configured (store still says unavailable) shows ONLY Pre-Order, Notify Me never flashes",
    variants: [V(1, { available: false, quantity: 0 })], initial: 1, configDelays: [0, 900], config: { waitlistEnabled: true, variants: [cfgVariant(1)] },
    run: `
      await sleep(900);
      t(vis('[data-wp-preorder]'), 'Pre-Order Now shown');
      t(!vis('[data-wp-waitlist]'), 'Notify Me hidden');
      t(!window.__flash.wl, 'Notify Me never flashed while pre-order config was loading');`,
  },
  {
    name: "visibility 3: sold-out + not configured shows ONLY Notify Me",
    variants: [V(1, { available: false, quantity: 0 })], initial: 1, config: { waitlistEnabled: true, variants: [cfgVariant(99)] },
    run: `t(vis('[data-wp-waitlist]'), 'Notify Me shown'); t(!vis('[data-wp-preorder]'), 'Pre-Order hidden'); t(!window.__flash.po, 'Pre-Order never flashed');`,
  },
  {
    name: "visibility 4: switching variants updates both buttons immediately, never showing both or a stale one",
    variants: [V(1, { available: true, quantity: 5 }), V(2, { available: false }), V(3, { available: false })], initial: 1,
    config: { waitlistEnabled: true, variants: [cfgVariant(2)] },
    run: `
      t(!vis('[data-wp-waitlist]') && !vis('[data-wp-preorder]'), 'start: in stock, none');
      window.__flash.wl = false; window.__flash.po = false;
      await pick(2); t(vis('[data-wp-preorder]') && !vis('[data-wp-waitlist]'), 'variant 2: only Pre-Order'); t(!window.__flash.wl, 'Notify Me did not flash on switch to configured variant');
      await pick(3); t(vis('[data-wp-waitlist]') && !vis('[data-wp-preorder]'), 'variant 3: only Notify Me');
      await pick(1); t(!vis('[data-wp-waitlist]') && !vis('[data-wp-preorder]'), 'back in stock: none');
      await pick(2); t(vis('[data-wp-preorder]') && !vis('[data-wp-waitlist]'), 'variant 2 again: only Pre-Order');`,
  },
  {
    name: "visibility 5: pre-order removed/disabled -> sold-out variant gets Notify Me again",
    variants: [V(1, { available: false })], initial: 1, config: { waitlistEnabled: true, variants: [] },
    run: `t(vis('[data-wp-waitlist]'), 'Notify Me restored'); t(!vis('[data-wp-preorder]'), 'Pre-Order gone');`,
  },
  {
    name: "visibility 5b: config removed while the page is open -> next variant change restores Notify Me",
    variants: [V(1, { available: true, quantity: 3 }), V(2, { available: false })], initial: 1, config: { waitlistEnabled: true, variants: [cfgVariant(2)] },
    run: `
      await pick(2); t(vis('[data-wp-preorder]') && !vis('[data-wp-waitlist]'), 'configured: Pre-Order only');
      scenario.config = { waitlistEnabled: true, variants: [] };
      await pick(1); await pick(2);
      t(vis('[data-wp-waitlist]') && !vis('[data-wp-preorder]'), 'after removal: Notify Me only');`,
  },
  {
    name: "visibility: independently removable - waitlist block alone ignores pre-order entirely (no waiting)",
    variants: [V(1, { available: false })], initial: 1, config: { waitlistEnabled: true, variants: [cfgVariant(1)] }, onlyWaitlist: true,
    run: `t(vis('[data-wp-waitlist]'), 'Notify Me shown without a pre-order block');`,
  },
  {
    name: "visibility: pre-order block alone works without the waitlist block",
    variants: [V(1, { available: false })], initial: 1, config: { waitlistEnabled: true, variants: [cfgVariant(1)] }, onlyPreorder: true,
    run: `t(vis('[data-wp-preorder]'), 'Pre-Order shown without a waitlist block');`,
  },
  {
    name: "visibility: a broken Pre-order script does not hide the waitlist forever",
    variants: [V(1, { available: false })], initial: 1, config: { waitlistEnabled: true, variants: [] },
    broken: true,
    run: `t(vis('[data-wp-waitlist]'), 'Notify Me still shown'); t(!vis('[data-wp-preorder]'), 'broken Pre-order hidden');`,
  },
  {
    name: "visibility: failed config request fails closed for both buttons (no stale/incorrect button)",
    variants: [V(1, { available: false })], initial: 1, config: null,
    run: `t(!vis('[data-wp-waitlist]') && !vis('[data-wp-preorder]'), 'nothing shown'); t(!window.__flash.wl && !window.__flash.po, 'no flash');`,
  },
  {
    name: "variant ids: gid-style or numeric ids from the server still match",
    variants: [V(50725370134714, { available: false })], initial: 50725370134714,
    config: { waitlistEnabled: true, variants: [cfgVariant("gid://shopify/ProductVariant/50725370134714")] },
    run: `t(vis('[data-wp-preorder]') && !vis('[data-wp-waitlist]'), 'matched despite gid format');`,
  },
  {
    name: "theme editor: configured but in-stock variant explains why Pre-order is hidden",
    variants: [V(1, { available: true, quantity: 10 })], initial: 1, designMode: true, config: { waitlistEnabled: true, variants: [cfgVariant(1)] },
    run: `
      t(vis('[data-wp-hint]') && /still in stock/.test(q('[data-wp-hint]').textContent), 'hint shown: ' + q('[data-wp-hint]').textContent);
      t(!vis('[data-wp-button]'), 'no pre-order button yet');
      await pick(1); t(vis('[data-wp-hint]'), 'hint persists');`,
  },
  {
    name: "theme editor: not-configured variant hint; out of stock shows the real button, no hint",
    variants: [V(1, { available: true, quantity: 10 }), V(2)], initial: 1, designMode: true, config: { waitlistEnabled: true, variants: [cfgVariant(2)] },
    run: `
      t(/not enabled for pre-order/.test(q('[data-wp-hint]').textContent), 'not-configured hint');
      await pick(2);
      t(vis('[data-wp-button]') && !vis('[data-wp-hint]'), 'button shown, hint gone');`,
  },
  {
    name: "live storefront: in-stock variant shows no hint and nothing",
    variants: [V(1, { available: true, quantity: 10 })], initial: 1, config: { waitlistEnabled: true, variants: [cfgVariant(1)] },
    run: `t(!vis('[data-wp-preorder]') && !vis('[data-wp-hint]'), 'completely hidden outside the editor');`,
  },
  {
    name: "logged-in customer: email is prefilled from Shopify, editable, and the confirmed email is what is submitted",
    variants: [V(1)], initial: 1, customerEmail: "jane@example.com", config: { waitlistEnabled: true, variants: [] },
    run: `
      q('[data-wp-open]').click();
      t(q('[data-wp-form]').elements.email.value === 'jane@example.com', 'prefilled');
      q('[data-wp-form]').elements.email.value = 'other@example.com';
      q('[data-wp-form]').requestSubmit(); await sleep(400);
      const post = calls.find(function (c) { return c.method === 'POST' && c.url.indexOf('/signup') > -1; });
      t(post && JSON.parse(post.body).email === 'other@example.com', 'edited email submitted');`,
  },
  {
    name: "after a successful signup the Notify Me button is hidden and only the success message remains",
    variants: [V(1)], initial: 1, config: { waitlistEnabled: true, variants: [] },
    run: `
      q('[data-wp-open]').click();
      q('[data-wp-form]').elements.email.value = 'a@example.com';
      q('[data-wp-form]').requestSubmit(); await sleep(500);
      t(q('[data-wp-open]').getClientRects().length === 0, 'button not rendered after signup');
      t(/back in stock/.test(q('[data-wp-status]').textContent), 'success message visible: ' + q('[data-wp-status]').textContent);`,
  },
  {
    name: "logged-in customer: one click to confirm the prefilled email",
    variants: [V(1)], initial: 1, customerEmail: "jane@example.com", config: { waitlistEnabled: true, variants: [] },
    run: `
      q('[data-wp-open]').click(); q('[data-wp-form]').requestSubmit(); await sleep(400);
      const post = calls.find(function (c) { return c.method === 'POST' && c.url.indexOf('/signup') > -1; });
      t(post && JSON.parse(post.body).email === 'jane@example.com' && post.body.indexOf('"variantId":"1"') > -1, 'signed up with Shopify email');
      t(/./.test(q('[data-wp-status]').textContent), 'success message shown');`,
  },
  {
    name: "guest: email field starts empty and an invalid prefill is ignored",
    variants: [V(1)], initial: 1, customerEmail: "not-an-email", config: { waitlistEnabled: true, variants: [] },
    run: `q('[data-wp-open]').click(); t(q('[data-wp-form]').elements.email.value === '', 'empty');`,
  },
  {
    name: "login required, guest: button says Log in to pre-order and sends them to login (no hold)",
    variants: [V(1, { available: true })], initial: 1, config: { waitlistEnabled: true, requirePreorderLogin: true, variants: [cfgVariant(1)] },
    run: `
      t(q('[data-wp-button]').textContent === 'Log in to pre-order', 'login text: ' + q('[data-wp-button]').textContent);
      q('[data-wp-button]').click(); await sleep(400);
      t(navigated && navigated.indexOf('/account/login?return_url=') === 0, 'went to login: ' + navigated);
      t(!calls.some(function (c) { return c.url.indexOf('/apps/waitlist/reserve') === 0; }), 'no reserve call'); t(!calls.some(function (c) { return c.url === '/cart/add.js'; }), 'no cart call');`,
  },
  {
    name: "login required, logged-in customer: normal pre-order button and checkout",
    variants: [V(1, { available: true })], initial: 1, customerId: "8123", config: { waitlistEnabled: true, requirePreorderLogin: true, variants: [cfgVariant(1)] },
    run: `
      t(q('[data-wp-button]').textContent === 'Reserve Yours', 'normal text');
      q('[data-wp-button]').click(); await sleep(500);
      t(navigated === '/checkout', 'checkout: ' + navigated); t(calls.some(function (c) { return c.url.indexOf('/apps/waitlist/reserve') === 0; }), 'reserved');`,
  },
  {
    name: "login not required (default): guests keep the normal button and can pre-order",
    variants: [V(1, { available: true })], initial: 1, config: { waitlistEnabled: true, requirePreorderLogin: false, variants: [cfgVariant(1)] },
    run: `
      t(q('[data-wp-button]').textContent === 'Reserve Yours', 'normal text');
      q('[data-wp-button]').click(); await sleep(500);
      t(navigated === '/checkout', 'checkout: ' + navigated);`,
  },
  {
    name: "stale page: setting turned on after load, signed 401 login_required redirects to login",
    variants: [V(1, { available: true })], initial: 1, customerId: "", reserve: { status: 401, body: { ok: false, error: 'login_required', message: 'Please log in to pre-order.' } },
    config: { waitlistEnabled: true, requirePreorderLogin: false, variants: [cfgVariant(1)] },
    run: `
      q('[data-wp-button]').click(); await sleep(500);
      t(navigated && navigated.indexOf('/account/login?return_url=') === 0, 'went to login: ' + navigated);
      t(!calls.some(function (c) { return c.url === '/cart/add.js'; }), 'cart untouched');`,
  },
  {
    name: "theme editor: re-rendered section does not leak or double-initialise",
    variants: [V(1)], initial: 1, config: { waitlistEnabled: true, variants: [] },
    run: `
      const old = q('[data-wp-waitlist]'); const html = old.outerHTML.replace(' data-wp-ready="1"', '');
      old.remove();
      document.querySelector('.shopify-section').insertAdjacentHTML('beforeend', html);
      document.dispatchEvent(new Event('shopify:section:load')); await sleep(400);
      t(document.querySelectorAll('[data-wp-waitlist]').length === 1 && vis('[data-wp-waitlist]'), 'single, visible block after reload');
      q('[data-wp-open]').click(); t(!q('[data-wp-form]').hidden, 'new block works');`,
  },
];

function page(s) {
  const wl = renderBlock("waitlist_button.liquid", { settings: s.waitlistSettings, customerEmail: s.customerEmail, currentVariantId: s.initial, variantsJson: s.variants.map((v) => ({ id: v.id, available: v.available })) });
  const po = renderBlock("preorder_button.liquid", { settings: s.preorderSettings, customerId: s.customerId, currentVariantId: s.initial, variantsJson: s.variants.map((v) => ({ id: v.id, tracked: v.tracked, quantity: v.quantity })) });
  const width = s.width || 1000;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:16px;font-family:sans-serif}</style></head><body>
<div class="shopify-section">${s.installmentForm ? '<form action="/cart/add" method="post" class="installment"><input type="hidden" name="id" value="' + s.initial + '"><shopify-payment-terms></shopify-payment-terms></form>' : ''}<form action="/cart/add" method="post" id="main-form"><input type="hidden" name="id" value="${s.initial}" disabled><button type="submit" name="add" id="native-add">Add to cart</button><div class="shopify-payment-button"><button type="button" id="native-buy">Buy it now</button></div></form>${s.onlyPreorder ? '' : wl.html}${s.onlyWaitlist ? '' : s.broken ? po.html.replace('{', '{ ').replace(/data-wp-variants>[\s\S]*?<\/script>/, 'data-wp-variants>not json</script>') : po.html}</div>
<div class="shopify-section" id="other-section"><form action="/cart/add" method="post"><input type="hidden" name="id" value="777"><button type="submit" name="add" id="other-add">Add to cart</button><div class="shopify-payment-button"><button type="button" id="other-buy">Buy it now</button></div></form></div>
<script>
  var calls = [], navigated = null, results = [];
  window.__t0 = Date.now();
  window.__flash = { wl: false, po: false, nat: false };
  window.__started = false; document.addEventListener('DOMContentLoaded', function () { window.__started = true; });
  setInterval(function () {
    var v = function (sel) { var e = document.querySelector(sel); return !!e && !e.hidden && getComputedStyle(e).display !== 'none'; };
    if (v('[data-wp-waitlist]')) window.__flash.wl = true;
    if (v('[data-wp-preorder]')) window.__flash.po = true;
    if (window.__started) { var na = document.querySelector('#native-add'); if (na && na.getClientRects().length > 0) window.__flash.nat = true; }
  }, 5);
  window.Shopify = { designMode: ${s.designMode ? 'true' : 'false'} };
  var scenario = ${JSON.stringify({ delays: s.configDelays || [], switchAfter: s.switchAfter || null, reserve: s.reserve || { status: 200, body: { ok: true, limited: true, reservationId: 'res1', remaining: 2 } }, config: s.config, signup: s.signup || { status: 200, body: { ok: true, result: 'created' } }, cart: s.cart || { status: 200, body: { items: [] } } })};
  window.fetch = function (url, init) {
    init = init || {}; calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    var respond = function (status, body) { return Promise.resolve({ ok: status < 300, status: status, json: function () { return Promise.resolve(body); } }); };
    if (url.indexOf('/apps/waitlist/config') === 0) {
      var n = calls.filter(function (c) { return c.url.indexOf('/apps/waitlist/config') === 0; }).length - 1;
      var cfg = scenario.switchAfter && Date.now() - window.__t0 >= scenario.switchAfter.ms ? scenario.switchAfter.config : scenario.config;
      var d = scenario.delays[n] || 0, res = cfg ? respond(200, cfg) : respond(500, {});
      return d ? new Promise(function (r) { setTimeout(function () { r(res); }, d); }) : res;
    }
    if (url.indexOf('/apps/waitlist/reserve') === 0) return respond(scenario.reserve.status, JSON.parse(init.body).intent === 'release' ? { ok: true, released: true } : scenario.reserve.body);
    if (url.indexOf('/apps/waitlist/signup') === 0) return respond(scenario.signup.status, scenario.signup.body);
    if (url === '/cart/add.js') return respond(scenario.cart.status, scenario.cart.body);
    return respond(404, {});
  };
</script>
<script src="wp-common.js" defer></script><script src="waitlist.js" defer></script>
<script src="wp-common.js" defer></script><script src="preorder.js" defer></script>
<script defer>
  window.addEventListener('load', async function () {
    window.WPCommon.navigate = function (u) { navigated = u; };
    var q = function (s) { return document.querySelector(s); };
    var shown = function (s) { var e = q(s); return !!e && e.getClientRects().length > 0; };
    var nat = function () { return { add: shown('#native-add'), buy: shown('#native-buy'), other: shown('#other-add') && shown('#other-buy') }; };
    var vis = function (s) { var e = q(s); return !!e && getComputedStyle(e).display !== 'none' && !e.hidden; };
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var t = function (ok, msg) { results.push({ ok: !!ok, msg: msg }); };
    var pick = async function (id) { var i = q('form[action*="/cart/add"] [name=id]'); i.value = String(id); i.dispatchEvent(new Event('change', { bubbles: true })); await sleep(600); };
    try { await sleep(700); ${s.run} } catch (e) { results.push({ ok: false, msg: 'driver error: ' + e.message }); }
    document.body.insertAdjacentHTML('beforeend', '<pre id="wp-results">' + JSON.stringify(results).replace(/</g, '\\\\u003c') + '</pre>');
  });
</script></body></html>`;
}

if (process.env.DUMP) { writeFileSync(process.env.DUMP, page(scenarios[0])); process.exit(0); }
let total = 0, failed = 0;
for (const [i, s] of scenarios.entries()) {
  const file = join(dir, `s${i}.html`);
  writeFileSync(file, page(s));
  let dom;
  try {
    dom = execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files", `--window-size=${s.width || 1000},900`, "--virtual-time-budget=15000", "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) { dom = String(e.stdout || ""); if (!dom) console.log("chrome error:", String(e.message).slice(0, 200)); }
  const start = dom.lastIndexOf('<pre id="wp-results">'); const m = start < 0 ? null : [null, dom.slice(start + 21, dom.indexOf("</pre>", start))];
  let res;
  try { res = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")); } catch { res = [{ ok: false, msg: "page did not produce results" }]; }
  const bad = res.filter((r) => !r.ok);
  total += res.length; failed += bad.length;
  console.log(`${bad.length ? "FAIL" : "PASS"}  ${s.name}  (${res.length - bad.length}/${res.length})`);
  for (const b of bad) console.log(`        x ${b.msg}`);
}
rmSync(dir, { recursive: true, force: true });
console.log(`\n${total - failed}/${total} storefront assertions passed in ${scenarios.length} scenarios`);
process.exit(failed ? 1 : 0);
