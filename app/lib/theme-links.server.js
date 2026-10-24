// Deep links into the Shopify theme editor that add one of the app's blocks to the product page.
// `block` is the block's file name without ".liquid" (the extension's blocks/ folder).
export const THEME_BLOCKS = { preorder_button: "Pre-order button", waitlist_button: "Waitlist button" };

export function themeEditorLink({ shop, apiKey, block, template = "product", target = "mainSection" }) {
  if (!shop || !apiKey || !Object.hasOwn(THEME_BLOCKS, block)) return null;
  const params = new URLSearchParams({ template, addAppBlockId: `${apiKey}/${block}`, target });
  return `https://${shop}/admin/themes/current/editor?${params}`;
}

/** App embeds (Theme settings > App embeds), by file name in blocks/. */
export const THEME_EMBEDS = { pause_buttons: "Pause store buttons" };

/** Opens the theme editor on App embeds with the embed switched on. */
export function appEmbedLink({ shop, apiKey, embed }) {
  if (!shop || !apiKey || !Object.hasOwn(THEME_EMBEDS, embed)) return null;
  const params = new URLSearchParams({ context: "apps", activateAppId: `${apiKey}/${embed}` });
  return `https://${shop}/admin/themes/current/editor?${params}`;
}

/** All the links the Dashboard shows for a shop (the API key comes from the environment). */
export function themeLinksFor(shop, apiKey = process.env.SHOPIFY_API_KEY) {
  return {
    preorder: themeEditorLink({ shop, apiKey, block: "preorder_button" }),
    waitlist: themeEditorLink({ shop, apiKey, block: "waitlist_button" }),
    editor: themeEditorHome(shop),
    pause: appEmbedLink({ shop, apiKey, embed: "pause_buttons" }),
  };
}

/** The plain theme editor on the product template, for merchants who want to place the blocks themselves. */
export const themeEditorHome = (shop) => (shop ? `https://${shop}/admin/themes/current/editor?template=product` : null);
