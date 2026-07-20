import { hash, verify } from "@node-rs/argon2";

// argon2id defaults per OWASP guidance.
const opts = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, opts);
}

export function verifyPassword(stored: string, plain: string): Promise<boolean> {
  return verify(stored, plain, opts);
}
