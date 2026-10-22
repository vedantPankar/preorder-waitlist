// Lets `node --test` import the app's extensionless ESM specifiers (Vite style).
import { register } from "node:module";
register("./resolve-hook.mjs", import.meta.url);
