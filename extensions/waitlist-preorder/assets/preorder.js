(function () {
  var C = window.WPCommon;

  function init(root) {
    // Store-wide pause (the "Pause" app embed): do nothing, so the theme's own buttons stay as they are.
    if (window.wpPaused) { root.hidden = true; return; }
    if (root.dataset.wpReady) return;
    root.dataset.wpReady = '1';
    var variants = JSON.parse(root.querySelector('[data-wp-variants]').textContent);
    var button = root.querySelector('[data-wp-button]');
    var ships = root.querySelector('[data-wp-ships]');
    var status = root.querySelector('[data-wp-status]');
    var qtyInput = root.querySelector('[data-wp-qty]');
    var countdownEl = root.querySelector('[data-wp-countdown]');
    var progressEl = root.querySelector('[data-wp-progress]');
    var closedEl = root.querySelector('[data-wp-closed]');
    var showRemaining = root.dataset.showRemaining === 'true';
    // Liquid's customer object: set only for a logged-in customer. The server enforces the rule either way.
    var loggedIn = !!root.dataset.customerId;
    var requireLogin = false; // from the app's Settings, via the config response
    var config = {};
    var display = null;       // the look saved in the app's Settings, when the merchant has customised it
    var offset = 0;           // server clock minus visitor clock, from the config response
    var variantId = null;
    var announced = null;
    var timer = null;
    var lastRefetch = 0;

    function setStatus(state, text) { status.dataset.state = state; status.textContent = text; }

    function announce(id, active, closed) {
      if (announced && announced.id !== id) C.setPreorderActive(announced.id, null);
      announced = { id: id, active: active };
      C.setPreorderActive(id, active, closed);
    }

    var hideNative = root.dataset.hideNative !== 'false';
    function syncNative(replaces) { C.setNativeHidden(root, hideNative && replaces); }
    // Until the config answers, hold the native buttons hidden for a variant pre-order could take over (tracked, 0 stock).
    (function () {
      var v = C.findVariant(variants, C.currentVariantId(root));
      syncNative(!!v && v.tracked && v.quantity <= 0);
    })();

    function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

    // Countdown text for the current variant's config; refetches the config once it reaches zero.
    function tick(cfg) {
      var target = C.countdownTarget(cfg);
      if (!target) { countdownEl.hidden = true; return; }
      var left = C.formatCountdown(C.remainingMs(target.at, Date.now(), offset), display && display.countdownStyle);
      var label = target.kind === 'start' ? root.dataset.countdownStart : root.dataset.countdownEnd;
      countdownEl.textContent = label + ' ' + left.text;
      countdownEl.hidden = false;
      // At zero ask the server again. Our estimate of its clock can be a few ms early, so keep retrying briefly.
      if (left.done && Date.now() - lastRefetch > 1500) { lastRefetch = Date.now(); refresh(); }
    }

    function render() {
      if (variantId === null) return;
      stopTimer();
      var cfg = config[C.normalizeId(variantId)];
      var offer = C.preorderOffer(C.findVariant(variants, variantId), cfg);
      var closed = offer.display === 'closed' || offer.display === 'countdown';
      announce(variantId, offer.active, closed);

      var hint = root.querySelector('[data-wp-hint]');
      var designMode = !!(window.Shopify && window.Shopify.designMode);
      // In the theme editor, say why the block is hidden instead of showing nothing.
      var showHint = !offer.active && !offer.display && designMode && !!hint;
      var mode = offer.active ? 'active' : offer.display || (showHint ? 'hint' : '');
      var target = cfg ? C.countdownTarget(cfg) : null;
      var showCountdownOnly = offer.display === 'countdown' && !!target;
      root.hidden = !(offer.active || offer.display === 'closed' || showCountdownOnly || showHint);
      root.dataset.mode = root.hidden ? '' : mode === 'countdown' && !showCountdownOnly ? '' : mode;
      if (hint) { hint.hidden = !showHint; hint.textContent = showHint ? C.preorderHint(offer.reason) : ''; }
      // Selling is closed or not open yet for an out-of-stock variant: the theme's own buttons must not offer it either.
      syncNative(offer.active || closed);

      closedEl.hidden = offer.display !== 'closed';
      closedEl.textContent = offer.display !== 'closed' ? '' : offer.reason === 'ended' ? root.dataset.endedText : root.dataset.soldOutText;
      if (offer.display === 'countdown') { tick(cfg); timer = setInterval(function () { tick(cfg); }, 1000); }
      if (!offer.active) { progressEl.hidden = true; if (offer.display !== 'countdown') countdownEl.hidden = true; return; }

      button.textContent = requireLogin && !loggedIn ? root.dataset.loginText : cfg.buttonText;
      if (qtyInput) {
        qtyInput.max = cfg.remaining == null ? '' : String(cfg.remaining);
        var q = C.clampQuantity(qtyInput.value, cfg);
        qtyInput.value = String(q.quantity);
      }
      var parts = [];
      if (cfg.shipDate) parts.push(root.dataset.shipsLabel + ' ' + C.formatDate(cfg.shipDate));
      if (showRemaining && cfg.remaining != null) parts.push(cfg.remaining + ' left');
      ships.textContent = parts.join(' · ');

      var progress = C.progressInfo(cfg);
      progressEl.hidden = !progress;
      if (progress) {
        var bar = progressEl.querySelector('progress');
        bar.max = progress.target; bar.value = Math.min(progress.sold, progress.target);
        bar.setAttribute('aria-label', progress.text);
        progressEl.querySelector('[data-wp-progress-text]').textContent = progress.text;
      }
      if (C.countdownTarget(cfg)) { tick(cfg); timer = setInterval(function () { tick(cfg); }, 1000); } else countdownEl.hidden = true;
    }

    // Settings > Storefront display, unless this block opted out in the theme editor.
    function applyDisplay(d) {
      display = root.dataset.useAppStyle === 'true' ? d : null;
      if (!display) return;
      root.classList.remove('wp-style-solid', 'wp-style-outline');
      root.classList.add('wp-style-' + (display.buttonStyle === 'outline' ? 'outline' : 'solid'));
      root.style.setProperty('--wp-bg', display.buttonColor);
      root.style.setProperty('--wp-fg', display.buttonTextColor);
      root.style.setProperty('--wp-progress', display.progressColor);
    }

    function refresh() {
      return C.fetchConfig(window.fetch.bind(window), root.dataset.configUrl, root.dataset.productId).then(function (cfg) {
        config = cfg.variants;
        requireLogin = cfg.requirePreorderLogin === true;
        applyDisplay(cfg.display);
        offset = C.clockOffset(cfg.serverNow, Date.now());
        if (!root.isConnected) { stopTimer(); return; }
        render();
      });
    }

    function goToLogin() {
      C.navigate(C.loginUrl(root.dataset.loginUrl, window.location.pathname + window.location.search));
    }

    button.addEventListener('click', function () {
      var vid = variantId; // exactly the variant that is selected right now
      if (!vid) return;
      if (requireLogin && !loggedIn) { goToLogin(); return; }
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      setStatus('loading', 'Adding to cart…');
      C.addPreorderToCart(window.fetch.bind(window), {
        configUrl: root.dataset.configUrl, reserveUrl: root.dataset.reserveUrl, productId: root.dataset.productId, variantId: vid,
        quantity: qtyInput ? qtyInput.value : 1, errorText: root.dataset.errorText, soldOutText: root.dataset.soldOutText, endedText: root.dataset.endedText
      }).then(function (res) {
        if (res.ok) {
          C.navigate(root.dataset.afterAdd === 'cart' ? '/cart' : '/checkout');
          return;
        }
        if (res.loginRequired) { loggedIn = false; requireLogin = true; goToLogin(); return; }
        setStatus('error', res.message);
        button.disabled = false;
        button.removeAttribute('aria-busy');
        refresh();
      });
    });

    refresh().then(function () {
      C.watchVariant(root, function (id) { variantId = id; setStatus('', ''); render(); refresh(); });
    });
  }

  function boot() {
    document.querySelectorAll('[data-wp-preorder]').forEach(function (root) {
      try { init(root); } catch (e) { root.dataset.wpFailed = '1'; root.hidden = true; document.dispatchEvent(new CustomEvent('wp:preorder-state')); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  document.addEventListener('shopify:section:load', boot);
})();
