import { test } from "node:test";
import assert from "node:assert/strict";
import { THEME_BLOCKS, THEME_EMBEDS, appEmbedLink, themeEditorHome, themeEditorLink, themeLinksFor } from "../app/lib/theme-links.server.js";
import { readdirSync } from "node:fs";

const KEY = "314ba6456c05f8b1730c8ef9bae2acdb";

test("each app block gets a theme-editor link that adds it to the product page", () => {
  const url = new URL(themeEditorLink({ shop: "s.myshopify.com", apiKey: KEY, block: "preorder_button" }));
  assert.equal(url.origin + url.pathname, "https://s.myshopify.com/admin/themes/current/editor");
  assert.equal(url.searchParams.get("template"), "product");
  assert.equal(url.searchParams.get("addAppBlockId"), `${KEY}/preorder_button`);
  assert.equal(url.searchParams.get("target"), "mainSection");
  assert.equal(new URL(themeEditorLink({ shop: "s.myshopify.com", apiKey: KEY, block: "waitlist_button" })).searchParams.get("addAppBlockId"), `${KEY}/waitlist_button`);
});

test("the linked blocks and embeds are exactly what the extension ships", () => {
  const shipped = readdirSync(new URL("../extensions/waitlist-preorder/blocks/", import.meta.url)).map((f) => f.replace(/\.liquid$/, "")).sort();
  assert.deepEqual([...Object.keys(THEME_BLOCKS), ...Object.keys(THEME_EMBEDS)].sort(), shipped);
});

test("the pause embed link opens App embeds with the switch activated", () => {
  const url = new URL(appEmbedLink({ shop: "s.myshopify.com", apiKey: KEY, embed: "pause_buttons" }));
  assert.equal(url.searchParams.get("context"), "apps");
  assert.equal(url.searchParams.get("activateAppId"), `${KEY}/pause_buttons`);
  assert.equal(appEmbedLink({ shop: "s.myshopify.com", apiKey: KEY, embed: "preorder_button" }), null, "blocks are not embeds");
  assert.equal(appEmbedLink({ shop: "", apiKey: KEY, embed: "pause_buttons" }), null);
});

test("missing inputs or an unknown block produce no link instead of a broken one", () => {
  assert.equal(themeEditorLink({ shop: "s.myshopify.com", apiKey: "", block: "preorder_button" }), null);
  assert.equal(themeEditorLink({ shop: "", apiKey: KEY, block: "preorder_button" }), null);
  assert.equal(themeEditorLink({ shop: "s.myshopify.com", apiKey: KEY, block: "star_rating" }), null);
  assert.equal(themeEditorLink({ shop: "s.myshopify.com", apiKey: KEY, block: "toString" }), null);
  assert.equal(themeEditorHome("s.myshopify.com"), "https://s.myshopify.com/admin/themes/current/editor?template=product");
  assert.equal(themeEditorHome(""), null);
});

test("the Dashboard gets all three links for a shop", () => {
  const links = themeLinksFor("s.myshopify.com", KEY);
  assert.ok(links.preorder.includes("preorder_button") && links.waitlist.includes("waitlist_button") && links.editor.endsWith("template=product") && links.pause.includes("pause_buttons"));
});
