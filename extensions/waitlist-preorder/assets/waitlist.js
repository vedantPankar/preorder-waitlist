(function () {
  var C = window.WPCommon;

  function init(root) {
    // Store-wide pause (the "Pause" app embed).
    if (window.wpPaused) { root.hidden = true; return; }
    if (root.dataset.wpReady) return;
    root.dataset.wpReady = '1';
    var variants = JSON.parse(root.querySelector('[data-wp-variants]').textContent);
    var openBtn = root.querySelector('[data-wp-open]');
    var form = root.querySelector('[data-wp-form]');
    var status = root.querySelector('[data-wp-status]');
    var submit = root.querySelector('[data-wp-submit]');
    var successText = root.querySelector('[data-wp-success]').textContent;
    var previewAlways = root.dataset.showAlways === 'true' && window.Shopify && window.Shopify.designMode;
    var showWithPreorder = root.dataset.showWithPreorder === 'true';
    var variantId = null;
    var waitlistEnabled = null; // unknown until config loads -> stay hidden
    var done = {};              // variants already signed up on this page

    function setStatus(state, text) { status.dataset.state = state; status.textContent = text; }

    var hideNative = root.dataset.hideNative !== 'false';
    // Sold-out variants the waitlist might replace the native buttons for: hold them hidden until we know.
    function couldReplaceNative() {
      var v = C.findVariant(variants, variantId === null ? C.currentVariantId(root) : variantId);
      return !!v && !v.available;
    }
    function syncNative(replaces) { C.setNativeHidden(root, hideNative && replaces); }

    function render() {
      if (waitlistEnabled === null || variantId === null) { root.hidden = true; syncNative(couldReplaceNative()); return; }
      var key = C.normalizeId(variantId);
      // A Pre-order block is on the page but has not ruled on this variant yet: stay hidden, don't flash.
      if (C.hasPreorderBlock() && !(key in C.state.preorderActive)) { root.hidden = true; syncNative(couldReplaceNative()); return; }
      var offer = C.waitlistOffer(C.findVariant(variants, variantId), {
        waitlistEnabled: waitlistEnabled, previewAlways: previewAlways,
        preorderActive: Boolean(C.state.preorderActive[key]), preorderClosed: Boolean(C.state.preorderClosed[key]), showWithPreorder: showWithPreorder
      });
      root.hidden = !offer.visible;
      syncNative(offer.visible && offer.reason !== 'preview'); // editor-only preview must not hide a purchasable button
      if (!offer.visible) { form.hidden = true; openBtn.setAttribute('aria-expanded', 'false'); }
      openBtn.hidden = Boolean(done[variantId]);
      if (done[variantId]) { setStatus('success', successText); }
    }

    // Logged-in customers: start from their Shopify email (they can still change it).
    var customerEmail = (root.dataset.customerEmail || '').trim();
    if (customerEmail && C.isValidEmail(customerEmail) && !form.elements.email.value) form.elements.email.value = customerEmail;

    openBtn.addEventListener('click', function () {
      form.hidden = !form.hidden;
      openBtn.setAttribute('aria-expanded', String(!form.hidden));
      if (!form.hidden) form.elements.email.focus();
    });

    form.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { form.hidden = true; openBtn.setAttribute('aria-expanded', 'false'); openBtn.focus(); }
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var email = form.elements.email;
      var vid = variantId; // the variant selected when the customer submitted
      if (!C.isValidEmail(email.value)) {
        setStatus('error', 'Please enter a valid email address.');
        email.setAttribute('aria-invalid', 'true');
        email.focus();
        return;
      }
      email.removeAttribute('aria-invalid');
      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
      setStatus('loading', 'Saving…');
      C.submitSignup(window.fetch.bind(window), root.dataset.endpoint, {
        email: email.value, productId: root.dataset.productId, variantId: vid, website: form.elements.website.value
      }).then(function (res) {
        if (res.ok) {
          done[vid] = true;
          form.hidden = true;
          render();
          setStatus('success', successText);
        } else {
          setStatus('error', res.message);
        }
        submit.disabled = false;
        submit.removeAttribute('aria-busy');
      });
    });

    syncNative(couldReplaceNative());
    document.addEventListener('wp:preorder-state', render);
    C.fetchConfig(window.fetch.bind(window), root.dataset.configUrl, root.dataset.productId).then(function (cfg) {
      waitlistEnabled = cfg.waitlistEnabled;
      render();
    });
    C.watchVariant(root, function (id) { variantId = id; setStatus('', ''); render(); });
  }

  function boot() { document.querySelectorAll('[data-wp-waitlist]').forEach(init); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  document.addEventListener('shopify:section:load', boot);
})();
