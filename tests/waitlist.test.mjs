import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, variant, fakeAdmin } from "./helpers.mjs";
import { isValidEmail } from "../app/lib/validation.server.js";
import { addSignup, listEntries, removeEntries, deleteEntries, WaitlistError } from "../app/lib/waitlist.server.js";
import { handleSignupRequest } from "../app/lib/signup.server.js";

let db;
before(async () => { db = await createTestDb(); });

test("email validation", () => {
  for (const ok of ["a@b.co", "User+tag@Example.com"]) assert.ok(isValidEmail(ok), ok);
  for (const bad of ["", "a", "a@b", "a b@c.com", "a@@b.com", "<x>@b.com", null, 5]) assert.ok(!isValidEmail(bad), String(bad));
});

test("backend rejects invalid email", async () => {
  await assert.rejects(addSignup(db, { shop: "a.myshopify.com", email: "nope", variant: variant() }), WaitlistError);
});

test("duplicate signups are prevented, case-insensitively, even concurrently", async () => {
  const shop = "dup.myshopify.com";
  const results = await Promise.all(
    ["Bob@x.com", "bob@x.com ", "BOB@X.COM", "bob@x.com"].map((email) => addSignup(db, { shop, email, variant: variant() })),
  );
  assert.equal(results.filter((r) => r.result === "created").length, 1);
  assert.equal(await db.waitlistEntry.count({ where: { shop } }), 1);
  // different variant is a separate signup
  assert.equal((await addSignup(db, { shop, email: "bob@x.com", variant: variant({ variantId: "222" }) })).result, "created");
});

test("re-signup after notification re-activates the same row", async () => {
  const shop = "re.myshopify.com";
  await addSignup(db, { shop, email: "c@x.com", variant: variant() });
  await db.waitlistEntry.updateMany({ where: { shop }, data: { status: "NOTIFIED" } });
  assert.equal((await addSignup(db, { shop, email: "c@x.com", variant: variant() })).result, "created");
  const rows = await db.waitlistEntry.findMany({ where: { shop } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "ACTIVE");
});

test("shop isolation for list/remove/delete", async () => {
  await addSignup(db, { shop: "one.myshopify.com", email: "i@x.com", variant: variant() });
  const two = await addSignup(db, { shop: "two.myshopify.com", email: "i@x.com", variant: variant() });
  assert.equal(two.result, "created"); // same email, other shop: independent
  const { entries } = await listEntries(db, "one.myshopify.com");
  assert.equal(entries.length, 1);
  const otherId = (await db.waitlistEntry.findFirst({ where: { shop: "two.myshopify.com" } })).id;
  assert.equal(await removeEntries(db, "one.myshopify.com", [otherId]), 0);
  assert.equal(await deleteEntries(db, "one.myshopify.com", [otherId]), 0);
  assert.ok(await db.waitlistEntry.findUnique({ where: { id: otherId } }));
});

const adminFor = (v) => fakeAdmin(() => ({ data: { nodes: v ? [{ id: `gid://shopify/ProductVariant/${v.variantId}`, title: v.variantTitle, inventoryQuantity: v.inventoryQuantity, inventoryPolicy: "DENY", product: { id: `gid://shopify/Product/${v.productId}`, title: v.productTitle, handle: v.productHandle } }] : [null] } }));

test("signup endpoint logic: validation, ownership, in-stock, honeypot", async () => {
  const shop = "ep.myshopify.com";
  const base = { email: "z@x.com", productId: "999", variantId: "111" };
  assert.equal((await handleSignupRequest({ db, admin: adminFor(variant()), shop, input: { ...base, email: "bad" } })).status, 422);
  assert.equal((await handleSignupRequest({ db, admin: adminFor(variant()), shop, input: { ...base, productId: "1" } })).status, 422);
  assert.equal((await handleSignupRequest({ db, admin: adminFor(null), shop, input: base })).status, 422);
  assert.equal((await handleSignupRequest({ db, admin: adminFor(variant({ inventoryQuantity: 5 })), shop, input: base })).status, 409);
  assert.equal((await handleSignupRequest({ db, admin: adminFor(variant()), shop, input: { ...base, website: "spam.com" } })).status, 200);
  assert.equal(await db.waitlistEntry.count({ where: { shop } }), 0);
  const ok = await handleSignupRequest({ db, admin: adminFor(variant()), shop, input: base });
  assert.deepEqual([ok.status, ok.body.ok], [200, true]);
  const again = await handleSignupRequest({ db, admin: adminFor(variant()), shop, input: base });
  assert.equal(again.body.result, "duplicate");
});

test("waitlist can be disabled per shop: signup refused (403), re-enabled works", async () => {
  const shop = "off.myshopify.com";
  const input = { email: "z@x.com", productId: "999", variantId: "111" };
  await db.shopSettings.create({ data: { shop, waitlistEnabled: false } });
  const off = await handleSignupRequest({ db, admin: adminFor(variant()), shop, input });
  assert.equal(off.status, 403); assert.equal(off.body.error, "waitlist_disabled");
  assert.equal(await db.waitlistEntry.count({ where: { shop } }), 0);
  await db.shopSettings.update({ where: { shop }, data: { waitlistEnabled: true } });
  assert.equal((await handleSignupRequest({ db, admin: adminFor(variant()), shop, input })).status, 200);
});
