import { createHmac, randomBytes } from "node:crypto";

// Tags identify API credentials, not passwords. The nonce prevents a tag
// outside this process from serving as an offline credential-check oracle.
const nonce = randomBytes(32);

export function credentialTag(key: string, purpose: string): string {
  // The encoding preserves code units; the length separates zero-padded keys.
  return createHmac("sha256", key, { encoding: "utf16le" })
    .update(nonce)
    .update(`${key.length}:${purpose}`)
    .digest("hex");
}
