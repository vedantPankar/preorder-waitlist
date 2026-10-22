import { toGid, toNumericId } from "./validation.server";

const VARIANT_FIELDS = `
  id title inventoryQuantity inventoryPolicy
  selectedOptions { name value }
  product { id title handle }`;

function mapVariant(node) {
  if (!node?.id || !node.product) return null;
  return {
    variantId: toNumericId(node.id),
    variantTitle: node.title && node.title !== "Default Title" ? node.title : null,
    productId: toNumericId(node.product.id),
    productTitle: node.product.title,
    productHandle: node.product.handle,
    inventoryQuantity: node.inventoryQuantity ?? 0,
    inventoryPolicy: node.inventoryPolicy,
    options: (node.selectedOptions ?? []).filter((o) => o?.name && o.name !== "Title").map((o) => ({ name: String(o.name), value: String(o.value) })),
  };
}

/** Looks up variants by numeric ids. Missing/foreign ids are omitted by Shopify. */
export async function fetchVariants(admin, variantIds) {
  const ids = variantIds.map((id) => toGid("ProductVariant", id)).filter(Boolean);
  if (!ids.length) return [];
  const response = await admin.graphql(
    `#graphql
    query WaitlistVariants($ids: [ID!]!) {
      nodes(ids: $ids) { ... on ProductVariant { ${VARIANT_FIELDS} } }
    }`,
    { variables: { ids } },
  );
  const json = await response.json();
  return (json.data?.nodes ?? []).map(mapVariant).filter(Boolean);
}

/** Maps an inventory item (from inventory_levels/update) to its variant(s). */
export async function fetchVariantsForInventoryItem(admin, inventoryItemId) {
  const response = await admin.graphql(
    `#graphql
    query WaitlistInventoryItem($id: ID!) {
      inventoryItem(id: $id) { id variants(first: 5) { nodes { ${VARIANT_FIELDS} } } }
    }`,
    { variables: { id: toGid("InventoryItem", inventoryItemId) } },
  );
  const json = await response.json();
  return (json.data?.inventoryItem?.variants?.nodes ?? []).map(mapVariant).filter(Boolean);
}

export async function setVariantInventoryPolicy(admin, { productId, variantId, policy }) {
  const response = await admin.graphql(
    `#graphql
    mutation WaitlistSetPolicy($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id inventoryPolicy }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        productId: toGid("Product", productId),
        variants: [{ id: toGid("ProductVariant", variantId), inventoryPolicy: policy }],
      },
    },
  );
  const json = await response.json();
  const errors = json.data?.productVariantsBulkUpdate?.userErrors ?? [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
}
