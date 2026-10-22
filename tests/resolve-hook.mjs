import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && context.parentURL && !/\.(m?js|cjs|json|node)$/.test(specifier)) {
    const base = new URL(specifier, context.parentURL);
    if (existsSync(fileURLToPath(base) + ".js")) return next(specifier + ".js", context);
  }
  return next(specifier, context);
}
