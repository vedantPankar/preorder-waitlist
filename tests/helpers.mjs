import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

export async function createTestDb() {
  const dir = mkdtempSync(join(tmpdir(), "wp-test-"));
  const url = `file:${join(dir, "test.sqlite")}`;
  // Apply the migrations over ONE connection: DROP TABLE / PRAGMA statements in a migration must all
  // see the same connection state. (With a pool, a statement could land on a connection with a stale
  // schema and fail with "index ... already exists".) The test client below keeps a normal pool, since
  // the concurrency tests need several connections.
  const migrator = new PrismaClient({ datasourceUrl: `${url}?connection_limit=1` });
  const root = new URL("../prisma/migrations/", import.meta.url).pathname;
  for (const name of readdirSync(root).sort()) {
    if (name.endsWith(".toml")) continue;
    const sql = readFileSync(join(root, name, "migration.sql"), "utf8");
    for (const stmt of sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await migrator.$executeRawUnsafe(stmt);
  }
  await migrator.$disconnect();
  return new PrismaClient({ datasourceUrl: url });
}

export const variant = (over = {}) => ({
  variantId: "111", variantTitle: "Red", productId: "999", productTitle: "Shoe", productHandle: "shoe", inventoryQuantity: 0, inventoryPolicy: "DENY", ...over,
});

export function fakeMailer({ fail = false } = {}) {
  const sent = [];
  return { sent, async send(msg) { if (fail) throw new Error("Email provider responded with HTTP 500"); sent.push(msg); } };
}

export function fakeAdmin(handlers) {
  const calls = [];
  return { calls, graphql: async (query, opts) => { calls.push({ query, opts }); return { json: async () => handlers(query, opts) }; } };
}
