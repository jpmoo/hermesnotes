import { createHash, randomBytes } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Opaque token for API access. Returned once; only its sha256 is stored. */
export function generateToken(): string {
  return `hn_${randomBytes(32).toString("base64url")}`;
}
