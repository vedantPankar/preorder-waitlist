// Encryption at rest for credentials the merchant types into Settings (the Gmail app password).
//
// AES-256-GCM with a random 96-bit IV per value. The shop domain is bound in as additional authenticated data, so a
// ciphertext copied to another shop's row does not decrypt. Format: "v1.<iv>.<tag>.<ciphertext>" (base64url).
//
// Key management: the key is NEVER stored in the database. It is derived (HKDF-SHA256) from EMAIL_SETTINGS_KEY when
// set, otherwise from SHOPIFY_API_SECRET, which the app already needs and keeps only in the environment. Rotating either
// makes saved credentials undecryptable: decryptSecret() then returns null and the merchant simply re-enters the
// password (nothing is guessed, nothing crashes). Plaintext is never logged and never included in errors.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
const INFO = "waitlist-preorder:settings-secret:v1";

export class SecretKeyMissingError extends Error {
  constructor() {
    super("No encryption key is available. Set EMAIL_SETTINGS_KEY (or SHOPIFY_API_SECRET) on the server.");
    this.name = "SecretKeyMissingError";
  }
}

function deriveKey(env) {
  const material = env.EMAIL_SETTINGS_KEY || env.SHOPIFY_API_SECRET;
  if (!material || String(material).length < 8) throw new SecretKeyMissingError();
  return Buffer.from(hkdfSync("sha256", Buffer.from(String(material)), Buffer.alloc(0), INFO, 32));
}

/** Whether a key is available, without revealing anything about it. */
export function secretsAvailable(env = process.env) {
  try { deriveKey(env); return true; } catch { return false; }
}

export function encryptSecret(plain, { shop, env = process.env }) {
  const key = deriveKey(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(String(shop)));
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

/** The plaintext, or null when the value is missing, malformed, tampered with, for another shop, or the key changed. */
export function decryptSecret(blob, { shop, env = process.env }) {
  if (typeof blob !== "string") return null;
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== VERSION || !iv || !tag || !ct) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(env), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(String(shop)));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Removes every occurrence of the given secrets from text (defence in depth for error messages and logs). */
export function scrub(text, secrets) {
  let out = String(text ?? "");
  for (const s of secrets) if (s && String(s).length >= 4) out = out.split(String(s)).join("[hidden]");
  return out;
}
