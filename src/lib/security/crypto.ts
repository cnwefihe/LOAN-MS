import crypto from "node:crypto";

export function sha256Hex(input: string | Buffer | Uint8Array): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

let warned = false;

/**
 * 32-byte key for field- and file-level encryption at rest (AES-256-GCM).
 * Production requires DATA_ENCRYPTION_KEY (base64, 32 bytes), ideally sourced from Azure Key Vault.
 */
function dataKey(): Buffer {
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (raw) {
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
    return key;
  }
  if (process.env.NODE_ENV === "production") throw new Error("DATA_ENCRYPTION_KEY is required in production");
  if (!warned) {
    console.warn("[security] DATA_ENCRYPTION_KEY not set; using an insecure development key. Never use this in production.");
    warned = true;
  }
  return crypto.createHash("sha256").update("pau-loans-insecure-development-key").digest();
}

/** Output layout: version(1) | iv(12) | tag(16) | ciphertext. */
export function encryptBuffer(plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dataKey(), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ct]);
}

export function decryptBuffer(blob: Buffer): Buffer {
  if (blob[0] !== 1) throw new Error("Unknown ciphertext version");
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const decipher = crypto.createDecipheriv("aes-256-gcm", dataKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]);
}

export function encryptString(plain: string): string {
  return encryptBuffer(Buffer.from(plain, "utf8")).toString("base64");
}

export function decryptString(blob: string): string {
  return decryptBuffer(Buffer.from(blob, "base64")).toString("utf8");
}

/** HMAC for signing short-lived cookies (OIDC state). */
export function hmac(value: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret && process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET is required in production");
  return crypto.createHmac("sha256", secret ?? "pau-loans-insecure-development-secret").update(value).digest("base64url");
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
