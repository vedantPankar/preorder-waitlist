import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import process from "node:process";
import { runAllShops } from "../lib/worker.server";
import { isValidShopDomain } from "../lib/validation.server";

// POST /api/notifications/run with "Authorization: Bearer <CRON_SECRET>".
// For an external scheduler (cron, Cloud Scheduler...) on hosts where an in-process
// worker is not appropriate. Disabled (404) unless CRON_SECRET is set.
const safeEqual = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const action = async ({ request }) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return new Response("Not found", { status: 404 });
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (request.method !== "POST" || !safeEqual(given, secret)) return new Response("Unauthorized", { status: 401 });
  const only = new URL(request.url).searchParams.get("shop");
  const result = await runAllShops({ only: isValidShopDomain(only) ? only : null }); // ?shop= limits the pass to one store
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
};

export const loader = () => new Response("Not found", { status: 404 });
