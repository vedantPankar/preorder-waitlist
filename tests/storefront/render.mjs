// Minimal stand-in for Shopify's Liquid renderer, good enough for the two app
// blocks: fills settings from the block's own schema defaults (or overrides),
// evaluates the handful of objects used, and drops control tags. It is NOT real
// Liquid; real rendering must be checked in a development preview.
import { readFileSync } from "node:fs";

const ROOT = new URL("../../extensions/waitlist-preorder/", import.meta.url);

export function renderBlock(file, { settings = {}, productId = 999, customerEmail = "", customerId = "", currentVariantId, variantsJson, blockId = "blk1" }) {
  const src = readFileSync(new URL(`blocks/${file}`, ROOT), "utf8");
  const schema = JSON.parse(src.match(/{%\s*schema\s*%}([\s\S]*?){%\s*endschema\s*%}/)[1]);
  const defaults = Object.fromEntries(schema.settings.filter((s) => s.id).map((s) => [s.id, s.default ?? ""]));
  const values = { ...defaults, ...settings };
  const ctx = { "block.id": blockId, "block.shopify_attributes": "", "wp_product.id": productId, "customer.email": customerEmail, "customer.id": customerId, "current.id": currentVariantId };
  let html = src.replace(/{%\s*schema\s*%}[\s\S]*?{%\s*endschema\s*%}/, "");
  html = html.replace(/\[\{%-\s*for v in wp_product\.variants[\s\S]*?\{%-\s*endfor\s*-%\}\]/, JSON.stringify(variantsJson));
  html = html.replace(/\{\{\s*'([\w.-]+)'\s*\|\s*asset_url\s*\|\s*stylesheet_tag\s*\}\}/g, (_, f) => `<link rel="stylesheet" href="${f}">`);
  html = html.replace(/\{\{\s*'([\w.-]+)'\s*\|\s*asset_url\s*\}\}/g, (_, f) => f);
  html = html.replace(/\{\{-?\s*([\w.]+)((?:\s*\|[^}]*)?)\s*-?\}\}/g, (_, key, filters) => {
    const k = key.startsWith("block.settings.") ? key.slice(15) : null;
    let v = k ? values[k] : ctx[key];
    if (v === undefined) throw new Error(`unresolved Liquid variable ${key} in ${file}`);
    v = String(v);
    return /\bescape\b/.test(filters) ? v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]) : v;
  });
  // {%- if X != blank -%} ... {%- endif -%}: keep when the setting is non-empty
  html = html.replace(/\{%-?\s*if (\w+(?:\.\w+)*) != blank\s*-?%\}([\s\S]*?)\{%-?\s*endif\s*-?%\}/g, (_, key, body) => {
    const k = key.startsWith("block.settings.") ? key.slice(15) : null;
    const v = k ? values[k] : { wp_product: "x" }[key];
    return v ? body : "";
  });
  html = html.replace(/\{%-?\s*if block\.settings\.(\w+)\s*-?%\}([\s\S]*?)\{%-?\s*endif\s*-?%\}/g, (_, k, body) => (values[k] && values[k] !== "false" ? body : ""));
  html = html.replace(/\{%-?[\s\S]*?-?%\}/g, "");
  if (/\{\{|\{%/.test(html)) throw new Error(`unrendered Liquid left in ${file}:\n${html.match(/.*(\{\{|\{%).*/)[0]}`);
  return { html, schema, values };
}
