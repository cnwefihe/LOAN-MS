/**
 * Time-based one-time passwords (RFC 6238, HMAC-SHA1, 6 digits, 30-second steps): the codes shown by
 * Microsoft Authenticator, Google Authenticator and similar apps.
 */
import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32-encoded for authenticator apps. */
export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** The code for a given 30-second step. */
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = h[h.length - 1] & 15;
  const bin = ((h[offset] & 127) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

export const currentStep = (now = Date.now()) => Math.floor(now / 30_000);

export function totp(secret: string, now = Date.now()): string {
  return totpAt(secret, currentStep(now));
}

/** Accepts the current code and one step either side, to allow for clock drift. Constant-time compare. */
export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  const step = currentStep(now);
  return [-1, 0, 1].some((d) => crypto.timingSafeEqual(Buffer.from(totpAt(secret, step + d)), Buffer.from(c)));
}

export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** Eight one-time recovery codes such as 4F7K-9QX2, for use if the phone is lost. */
export function generateRecoveryCodes(n = 8): string[] {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: n }, () => {
    const b = crypto.randomBytes(8);
    const s = Array.from(b, (x) => chars[x % chars.length]).join("");
    return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
  });
}

export const normaliseRecoveryCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
