import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { renderBlock } from "./storefront/render.mjs";

const blocksDir = new URL("../extensions/waitlist-preorder/blocks/", import.meta.url);
const schemaOf = (f) => JSON.parse(readFileSync(new URL(f, blocksDir), "utf8").match(/{%\s*schema\s*%}([\s\S]*?){%\s*endschema\s*%}/)[1]);
const appBlocks = ["waitlist_button.liquid", "preorder_button.liquid"];

test("all blocks (including the template's star rating) have a parseable schema and are present", () => {
  const files = readdirSync(blocksDir);
  for (const f of [...appBlocks, "star_rating.liquid"]) assert.ok(files.includes(f), f);
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
