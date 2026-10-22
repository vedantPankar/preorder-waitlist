/* Shared storefront logic for the Waitlist and Pre-order blocks.
   Pure functions (no DOM access) so they can be unit tested; the DOM wiring
   lives in waitlist.js / preorder.js. Exposed as window.WPCommon. */
(function (root) {
  'use strict';
  if (root.WPCommon) return; // both blocks include this file; keep one shared instance

  var EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

  function isValidEmail(value) {
    var email = String(value || '').trim();
    return email.length > 0 && email.length <= 254 && EMAIL_RE.test(email);
  }

  /* Variant ids arrive as numbers (Liquid), numeric strings (DOM/URL) or GIDs
     (gid://shopify/ProductVariant/123). Compare them all as the numeric string. */
  function normalizeId(id) { return String(id == null ? '' : id).replace(/^.*\//, ''); }

  function findVariant(list, id) {
    for (var i = 0; i < list.length; i++) if (normalizeId(list[i].id) === normalizeId(id)) return list[i];
    return null;
  }

  /* Pre-order is offered only for an explicitly enabled variant that is out of stock
     (tracked inventory <= 0) and whose campaign (if any) is open with quota left.
     `display` tells the block what to show instead of the button:
       'countdown' (campaign not started yet) or 'closed' (ended / sold out).
     Paused/draft/disabled campaigns show nothing. Older server answers have no
     `phase`; then `soldOut` means sold out. In-stock variants are never affected. */
  function preorderOffer(variant, cfg) {
    if (!variant || !cfg) return { active: false, reason: 'not_configured' };
    if (!variant.tracked) return { active: false, reason: 'untracked_inventory' };
    if (variant.quantity > 0) return { active: false, reason: 'in_stock' };
    var phase = cfg.phase || (cfg.soldOut ? 'sold_out' : 'active');
    if (phase === 'scheduled') return { active: false, reason: 'scheduled', display: 'countdown' };
    if (phase === 'ended' || phase === 'sold_out') return { active: false, reason: phase, display: 'closed' };
    if (phase !== 'active') return { active: false, reason: phase };
    return { active: true, reason: 'ok' };
  }

  /* Merchant-only explanation (theme editor) of why the pre-order button is hidden. */
  function preorderHint(reason) {
    var hints = {
      not_configured: 'Pre-order button is hidden: this variant is not enabled for pre-order in the app (Product configuration).',
      sold_out: 'Pre-order button is hidden: the pre-order limit for this variant has been reached.',
      untracked_inventory: 'Pre-order button is hidden: this variant does not track inventory. Turn on "Track quantity" in Shopify.',
      in_stock: 'Pre-order button is hidden: this variant is still in stock. It appears once the stock reaches 0.',
      paused: 'Pre-order button is hidden: the campaign is paused.',
      draft: 'Pre-order button is hidden: the campaign is still a draft.',
      scheduled: 'The campaign has not started yet.',
      ended: 'The campaign has ended.'
    };
    return hints[reason] || '';
  }

  /* Waitlist is offered for unavailable variants when the merchant has it
     enabled. If a pre-order is active for the variant, pre-order wins unless
     the merchant explicitly chose to show both. */
  function waitlistOffer(variant, opts) {
    opts = opts || {};
    if (!variant) return { visible: false, reason: 'no_variant' };
    if (opts.waitlistEnabled === false) return { visible: false, reason: 'disabled' };
    if (opts.previewAlways) return { visible: true, reason: 'preview' };
    // A closed pre-order campaign ends selling even if this page still shows the variant as purchasable.
    if (variant.available && !opts.preorderClosed) return { visible: false, reason: 'available' };
    if (opts.preorderActive && !opts.showWithPreorder) return { visible: false, reason: 'preorder_active' };
    return { visible: true, reason: 'ok' };
  }

  /* --- countdown & progress (pure) --- */

  /* Milliseconds to add to the visitor's clock to get the server's clock. */
  function clockOffset(serverNowIso, clientNowMs) {
    var server = Date.parse(serverNowIso);
    return isNaN(server) ? 0 : server - clientNowMs;
  }
  function remainingMs(targetMs, clientNowMs, offsetMs) { return targetMs - (clientNowMs + offsetMs); }

  /* style: 'compact' (default, "1d 01:01:01"), 'dhms' ("1d 01h 01m 01s") or 'hms' ("25h 01m 01s"). */
  function formatCountdown(ms, style) {
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var total = ms > 0 ? Math.floor(ms / 1000) : 0;
    var days = Math.floor(total / 86400), h = Math.floor((total % 86400) / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
    var text;
    if (style === 'dhms') text = (days > 0 ? days + 'd ' : '') + pad(h) + 'h ' + pad(m) + 'm ' + pad(sec) + 's';
    else if (style === 'hms') text = pad(Math.floor(total / 3600)) + 'h ' + pad(m) + 'm ' + pad(sec) + 's';
    else text = (days > 0 ? days + 'd ' : '') + pad(h) + ':' + pad(m) + ':' + pad(sec);
    return { done: !(ms > 0), text: text };
  }

  /* Which instant to count down to, if the merchant switched the countdown on. */
  function countdownTarget(cfg) {
    var c = cfg && cfg.campaign;
    if (!c || !c.countdown) return null;
    if (cfg.phase === 'scheduled' && c.startsAt && !isNaN(Date.parse(c.startsAt))) return { kind: 'start', at: Date.parse(c.startsAt) };
    if (cfg.phase === 'active' && c.endsAt && !isNaN(Date.parse(c.endsAt))) return { kind: 'end', at: Date.parse(c.endsAt) };
    return null;
  }

  /* Progress from VERIFIED sold units (never reservations or estimates). */
  function progressInfo(cfg) {
    var p = cfg && cfg.campaign && cfg.campaign.progress;
    if (!p || !(p.target > 0)) return null;
    var sold = Math.max(0, Number(p.sold) || 0);
    return { sold: sold, target: p.target, pct: Math.min(100, Math.round((sold / p.target) * 100)), text: sold + ' of ' + p.target + ' pre-ordered' };
  }

  function clampQuantity(raw, cfg) {
    var qty = parseInt(raw, 10);
    if (!(qty >= 1)) qty = 1;
    if (cfg && cfg.remaining != null && qty > cfg.remaining) return { quantity: cfg.remaining, clamped: true };
    return { quantity: qty, clamped: false };
  }

  function formatDate(iso, locale) {
    var p = String(iso || '').split('-');
    if (p.length !== 3) return '';
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    try { return d.toLocaleDateString(locale, { dateStyle: 'long', timeZone: 'UTC' }); } catch (e) { return iso; }
  }

  /* Body for POST /cart/add.js. Selected variant, quantity and properties are
     preserved; `_preorder` is hidden (underscore prefix), the date is shown. */
  function buildCartPayload(variantId, quantity, cfg, locale, reservationId) {
    var properties = { _preorder: 'true' };
    if (reservationId) properties._preorder_reservation = reservationId;
    if (cfg && cfg.shipDate) {
      properties['Expected shipping'] = formatDate(cfg.shipDate, locale);
      properties._preorder_ship_date = cfg.shipDate;
    }
    return { items: [{ id: Number(variantId), quantity: quantity, properties: properties }] };
  }

  function parseJson(response) {
    return response.json().then(function (b) { return { ok: response.ok, status: response.status, body: b || {} }; },
      function () { return { ok: response.ok, status: response.status, body: {} }; });
  }

  function fetchConfig(fetchFn, url, productId) {
    return fetchFn(url + '?product=' + encodeURIComponent(productId), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : { variants: [], waitlistEnabled: false }; })
      .catch(function () { return { variants: [], waitlistEnabled: false }; })
      .then(function (body) {
        var map = {};
        (body.variants || []).forEach(function (c) { map[normalizeId(c.variantId)] = c; });
        return { waitlistEnabled: body.waitlistEnabled !== false, requirePreorderLogin: body.requirePreorderLogin === true, variants: map, serverNow: body.serverNow || null, display: body.display || null };
      });
  }

  /* Resolves { ok, message }. Never rejects. */
  function submitSignup(fetchFn, endpoint, data) {
    if (!isValidEmail(data.email)) return Promise.resolve({ ok: false, field: 'email', message: 'Please enter a valid email address.' });
    if (!data.variantId) return Promise.resolve({ ok: false, message: 'Please select an option first.' });
    return fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: String(data.email).trim(), productId: String(data.productId), variantId: String(data.variantId), website: data.website || '' })
    }).then(parseJson).then(function (res) {
      if (res.ok && res.body.ok) return { ok: true, result: res.body.result };
      return { ok: false, message: res.body.message || 'Something went wrong. Please try again.' };
    }, function () { return { ok: false, message: 'Network error. Please try again.' }; });
  }

  /* Where a logged-out visitor goes to log in; the login page returns them to the product page. */
  function loginUrl(loginPath, returnPath) {
    return (loginPath || '/account/login') + '?return_url=' + encodeURIComponent(returnPath || '/');
  }

  /* Takes a short hold on the units BEFORE they go into the cart (atomic on the server, so
     simultaneous customers cannot hold more than the limit). Resolves { ok, reservationId, message }. */
  function reserveUnits(fetchFn, url, o) {
    return fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ intent: 'reserve', productId: String(o.productId), variantId: String(o.variantId), quantity: o.quantity })
    }).then(parseJson).then(function (res) {
      if (res.ok && res.body.ok) return { ok: true, reservationId: res.body.reservationId || null };
      if (res.body && res.body.error === 'login_required') return { ok: false, loginRequired: true, message: res.body.message || 'Please log in to pre-order.' };
      return { ok: false, message: res.body.message || o.soldOutText || 'Sorry, this item is no longer available for pre-order.' };
    }, function () { return { ok: false, message: o.errorText || 'Network error. Please try again.' }; });
  }

  function releaseUnits(fetchFn, url, reservationId) {
    if (!reservationId) return Promise.resolve();
    return fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ intent: 'release', reservationId: reservationId })
    }).then(function () {}, function () {});
  }

  /* Re-checks the campaign with the server, holds the units, then adds to the cart through
     Shopify's Cart API (releasing the hold if that fails). Resolves { ok, message?, remaining? }.
     This is a best-effort limit: Shopify checkout itself is not gated by the app. */
  function addPreorderToCart(fetchFn, o) {
    var reserveUrl = o.reserveUrl || '/apps/waitlist/reserve';
    return fetchConfig(fetchFn, o.configUrl, o.productId).then(function (fresh) {
      var cfg = fresh.variants[normalizeId(o.variantId)];
      var phase = cfg && (cfg.phase || (cfg.soldOut ? 'sold_out' : 'active'));
      if (!cfg || phase !== 'active') {
        return { ok: false, message: phase === 'ended' ? (o.endedText || 'This pre-order campaign has ended.') : (o.soldOutText || 'Sorry, this item is no longer available for pre-order.') };
      }
      var q = clampQuantity(o.quantity, cfg);
      if (q.clamped) return { ok: false, remaining: cfg.remaining, message: 'Only ' + cfg.remaining + ' left for pre-order.' };
      return reserveUnits(fetchFn, reserveUrl, { productId: o.productId, variantId: o.variantId, quantity: q.quantity, soldOutText: o.soldOutText, errorText: o.errorText }).then(function (hold) {
        if (!hold.ok) return hold.loginRequired ? { ok: false, loginRequired: true, message: hold.message } : { ok: false, message: hold.message };
        return fetchFn('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(buildCartPayload(o.variantId, q.quantity, cfg, o.locale, hold.reservationId))
        }).then(parseJson).then(function (res) {
          if (res.ok) return { ok: true };
          return releaseUnits(fetchFn, reserveUrl, hold.reservationId).then(function () {
            return { ok: false, message: (res.body && res.body.description) || o.errorText || 'Sorry, we couldn\'t add this pre-order.' };
          });
        }, function () {
          return releaseUnits(fetchFn, reserveUrl, hold.reservationId).then(function () { return { ok: false, message: o.errorText || 'Network error. Please try again.' }; });
        });
      });
    });
  }

  /* --- DOM helpers (only used in the browser) --- */

  var state = { preorderActive: {}, preorderClosed: {} };

  /* True while a working Pre-order block is on the page (present in the markup,
     even if its script has not run yet). The waitlist then waits for its verdict
     on the selected variant so it never flashes first. A block whose script
     threw is marked data-wp-failed and no longer holds the waitlist back. */
  function hasPreorderBlock() { return !!document.querySelector('[data-wp-preorder]:not([data-wp-failed])'); }

  function sectionScope(rootEl) {
    return (rootEl.closest && (rootEl.closest('.shopify-section') || rootEl.closest('section'))) || document;
  }

  /* The product form of the same section as the block (never another product's).
     Themes can render several /cart/add forms (e.g. Dawn's Shop Pay installments
     form comes first), so prefer the one that holds the purchase buttons. */
  function productForm(rootEl) {
    var forms = sectionScope(rootEl).querySelectorAll('form[action*="/cart/add"]');
    for (var i = 0; i < forms.length; i++) {
      if (forms[i].querySelector('button[type="submit"], input[type="submit"], [name="add"], .shopify-payment-button')) return forms[i];
    }
    return forms[0] || null;
  }

  /* Hide/restore the theme's own Add to cart / Buy it now for this section only.
     Pure CSS switch (data-wp-hide-native on the product form; see wp-shared.css):
     nothing is removed, and inventory/availability are never touched. Each block
     holds its own token, so the buttons come back only when no block wants them hidden. */
  var tokenSeq = 0;
  function setNativeHidden(rootEl, hide) {
    var form = productForm(rootEl);
    if (!form) return;
    if (!rootEl.__wpToken) rootEl.__wpToken = 't' + (++tokenSeq);
    var tokens = (form.getAttribute('data-wp-hide-native') || '').split(' ').filter(Boolean).filter(function (t) { return t !== rootEl.__wpToken; });
    if (hide) tokens.push(rootEl.__wpToken);
    if (tokens.length) form.setAttribute('data-wp-hide-native', tokens.join(' ')); else form.removeAttribute('data-wp-hide-native');
    var holder = form.parentElement;
    // Themes commonly render the accelerated-checkout (Buy it now) button as a sibling of the form.
    if (holder) { if (tokens.length) holder.setAttribute('data-wp-hide-native-scope', ''); else holder.removeAttribute('data-wp-hide-native-scope'); }
  }

  function currentVariantId(rootEl) {
    var scope = sectionScope(rootEl);
    // The product form's id input is what "Add to cart" will actually submit.
    var form = productForm(rootEl);
    var input = (form && form.querySelector('[name="id"]')) || scope.querySelector('form[action*="/cart/add"] [name="id"]') || document.querySelector('form[action*="/cart/add"] [name="id"]');
    if (input && input.value) return String(input.value);
    var fromUrl = new URLSearchParams(window.location.search).get('variant');
    return String(fromUrl || rootEl.getAttribute('data-initial-variant'));
  }

  function watchVariant(rootEl, callback) {
    var last = null;
    function check() {
      if (!rootEl.isConnected) { clearInterval(timer); return; } // theme editor re-rendered the section
      var id = currentVariantId(rootEl);
      if (id !== last) { last = id; callback(id); }
    }
    document.addEventListener('change', check);
    document.addEventListener('variant:change', check);
    window.addEventListener('popstate', check);
    var timer = setInterval(check, 250);
    check();
  }

  function navigate(url) { window.location.href = url; } // overridable seam (tests)

  function setPreorderActive(variantId, active, closed) {
    variantId = normalizeId(variantId);
    if (active === null) { delete state.preorderActive[variantId]; delete state.preorderClosed[variantId]; } // verdict withdrawn: waitlist waits for a fresh one
    else { state.preorderActive[variantId] = active; state.preorderClosed[variantId] = Boolean(closed); }
    document.dispatchEvent(new CustomEvent('wp:preorder-state', { detail: { variantId: variantId, active: active } }));
  }

  root.WPCommon = {
    isValidEmail: isValidEmail, normalizeId: normalizeId, hasPreorderBlock: hasPreorderBlock, findVariant: findVariant, preorderOffer: preorderOffer, preorderHint: preorderHint, waitlistOffer: waitlistOffer,
    clampQuantity: clampQuantity, clockOffset: clockOffset, remainingMs: remainingMs, formatCountdown: formatCountdown, countdownTarget: countdownTarget, progressInfo: progressInfo, formatDate: formatDate, buildCartPayload: buildCartPayload, fetchConfig: fetchConfig,
    submitSignup: submitSignup, addPreorderToCart: addPreorderToCart, loginUrl: loginUrl,
    setNativeHidden: setNativeHidden, productForm: productForm, state: state, navigate: navigate, currentVariantId: currentVariantId, watchVariant: watchVariant, setPreorderActive: setPreorderActive
  };
})(typeof window !== 'undefined' ? window : this);
