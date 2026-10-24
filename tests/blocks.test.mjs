import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { renderBlock } from "./storefront/render.mjs";

const blocksDir = new URL("../extensions/waitlist-preorder/blocks/", import.meta.url);
const schemaOf = (f) => JSON.parse(readFileSync(new URL(f, blocksDir), "utf8").match(/{%\s*schema\s*%}([\s\S]*?){%\s*endschema\s*%}/)[1]);
const appBlocks = ["waitlist_button.liquid", "preorder_button.liquid"];
const appEmbeds = ["pause_buttons.liquid"];

test("the extension has exactly the two app blocks and the pause embed, each with a parseable schema", () => {
  const files = readdirSync(blocksDir).sort();
  assert.deepEqual(files, [...appBlocks, ...appEmbeds].sort(), "no leftover template blocks");
  for (const f of files) assert.ok(schemaOf(f).name, `${f} has a name`);
});

test("app blocks target product sections and have well-formed settings", () => {
  for (const f of appBlocks) {
    const s = schemaOf(f);
    assert.equal(s.target, "section");
    const ids = s.settings.filter((x) => x.id).map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, `${f}: unique setting ids`);
    for (const x of s.settings) {
      assert.ok(x.type, `${f}: type`);
      if (x.type !== "paragraph" && x.type !== "header") assert.ok(x.label, `${f}: ${x.id} label`);
      if (x.type === "select") assert.ok(x.options.some((o) => o.value === x.default), `${f}: ${x.id} default is an option`);
      if (x.type === "range") assert.ok(x.default >= x.min && x.default <= x.max && (x.max - x.min) / x.step <= 101, `${f}: ${x.id} range valid`);
    }
  }
});

test("merchant-configurable text/color settings exist on both blocks", () => {
  const ids = (f) => schemaOf(f).settings.map((x) => x.id);
  for (const f of appBlocks) for (const id of ["hide_native_buttons", "button_style", "button_color", "text_color", "button_width", "button_align", "font_size", "font_weight", "padding_y", "border_width", "corner_radius"]) assert.ok(ids(f).includes(id), `${f}: ${id}`);
  assert.ok(ids("waitlist_button.liquid").includes("button_text"));
  assert.ok(ids("preorder_button.liquid").includes("fallback_button_text"));
});

test("blocks render with defaults and carry the data the scripts need", () => {
  const wl = renderBlock("waitlist_button.liquid", { currentVariantId: 5, variantsJson: [{ id: 5, available: false }] }).html;
  for (const attr of ['data-product-id="999"', 'data-endpoint="/apps/waitlist/signup"', 'data-config-url="/apps/waitlist/config"', 'data-initial-variant="5"']) assert.ok(wl.includes(attr), attr);
  assert.match(wl, /<label class="wp-label" for="wp-email-blk1">/);
  assert.ok(!/\son\w+=/.test(wl), "no inline event handlers");
  const po = renderBlock("preorder_button.liquid", { currentVariantId: 5, variantsJson: [{ id: 5, tracked: true, quantity: 0 }] }).html;
  assert.ok(po.includes('data-config-url="/apps/waitlist/config"') && !/\son\w+=/.test(po));
});

test("blocks use the product page's own product (not a stale picker value); picker is only a fallback", () => {
  for (const f of appBlocks) {
    const src = readFileSync(new URL(f, blocksDir), "utf8");
    assert.match(src, /assign wp_product = product\s+if wp_product == blank\s+assign wp_product = block\.settings\.product/, f);
    assert.ok(!/assign product =/.test(src), `${f}: must not overwrite the global product`);
    assert.ok(!/\{\{\s*product\./.test(src) && !/in product\.variants/.test(src), `${f}: only wp_product is used`);
    assert.ok(!schemaOf(f).settings.find((x) => x.id === "product").autofill, `${f}: no autofill (it froze one product into the block)`);
  }
});

test("pre-order block exposes campaign settings and accessible campaign markup", () => {
  const ids = schemaOf("preorder_button.liquid").settings.map((x) => x.id);
  for (const id of ["ended_text", "countdown_start_label", "countdown_end_label", "sold_out_text"]) assert.ok(ids.includes(id), id);
  const po = renderBlock("preorder_button.liquid", { currentVariantId: 5, variantsJson: [{ id: 5, tracked: true, quantity: 0 }] }).html;
  assert.ok(po.includes('data-reserve-url="/apps/waitlist/reserve"'));
  assert.match(po, /data-wp-countdown role="timer"/);          // countdown is a timer region
  assert.match(po, /data-wp-closed role="status"/);            // closed state is announced politely
  assert.match(po, /<progress max="1" value="0" aria-label="[^"]+"/); // native, labelled progress element
  assert.match(po, /data-ended-text="This pre-order campaign has ended\."/);
  assert.match(po, /data-countdown-start="Pre-orders open in"/);
});

test("every block name fits Shopify's 25-character limit (a longer name makes the release fail)", () => {
  for (const f of readdirSync(blocksDir)) assert.ok(schemaOf(f).name.length <= 25, `${f}: "${schemaOf(f).name}" is ${schemaOf(f).name.length} characters`);
});

test("the pause embed is an app embed in the head with one switch that defaults to paused", () => {
  const s = schemaOf("pause_buttons.liquid");
  assert.equal(s.target, "head");
  assert.deepEqual(s.settings.filter((x) => x.id).map((x) => [x.id, x.type, x.default]), [["pause", "checkbox", true]]);
  const src = readFileSync(new URL("pause_buttons.liquid", blocksDir), "utf8");
  assert.match(src, /window\.wpPaused = true/);
  assert.match(src, /\.wp-block \{ display: none !important; \}/);
  assert.match(src, /\{%-? if block\.settings\.pause -%?\}/, "only acts while the setting is on");
});

for (const script of ["preorder.js", "waitlist.js"]) {
  test(`${script} does nothing while the store is paused, and starts normally otherwise`, async () => {
    const { runInNewContext } = await import("node:vm");
    const code = readFileSync(new URL(`../extensions/waitlist-preorder/assets/${script}`, import.meta.url), "utf8");
    const make = (paused) => {
      const touched = [];
      // A root that records every use; a paused store must only set `hidden`.
      const root = new Proxy({ hidden: false, dataset: {} }, {
        get: (t, k) => { if (k !== "hidden" && k !== "dataset") touched.push(String(k)); return t[k]; },
        set: (t, k, v) => { t[k] = v; return true; },
      });
      const selector = script === "preorder.js" ? "[data-wp-preorder]" : "[data-wp-waitlist]";
      const document = { readyState: "complete", addEventListener() {}, dispatchEvent() {}, querySelectorAll: (q) => (q === selector ? [root] : []) };
      const window = { wpPaused: paused, WPCommon: {} };
      window.document = document;
      // The fake element is too bare for a normal start-up; an error there still proves start-up was attempted.
      try { runInNewContext(code, { window, document, CustomEvent: function () {}, setInterval() {}, clearInterval() {}, console }); } catch { /* expected when not paused */ }
      return { root, touched };
    };
    const paused = make(true);
    assert.equal(paused.root.hidden, true, "hidden while paused");
    assert.deepEqual(paused.touched, [], "paused: no other work was done on the block");
    const normal = make(false);
    assert.ok(normal.root.dataset.wpReady === "1" || normal.touched.includes("querySelector"), "not paused: initialisation was attempted");
  });
}
