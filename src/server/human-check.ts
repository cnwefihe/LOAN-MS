/**
 * Human check before sign-in: a slider puzzle. The server draws a picture with a piece-shaped gap and
 * sends the picture and the piece as PNG images; where the gap is stays secret, sealed (encrypted) in a
 * token that only the server can open. The person drags the piece into the gap; the server checks the
 * position, how long it took and how the pointer moved, then sets a short-lived signed cookie that lets
 * them reach the sign-in buttons. Each puzzle can be tried once.
 */
import crypto from "node:crypto";
import zlib from "node:zlib";
import { decryptString, encryptString, hmac, timingSafeEqualStr } from "@/lib/security/crypto";

export const HUMAN_COOKIE = "pau_human";
export const W = 300;
export const H = 160;
export const PIECE = 44; // the square part of the piece
const KNOB = 9; // radius of the round tab on the top and right
const PAD = KNOB + 2; // the piece image is larger than the square by this on each side
const TOLERANCE = 6; // pixels either side of the gap that still count
const TOKEN_LIFE_MS = 2 * 60 * 1000;

/* ───────── PNG output, without outside libraries ───────── */

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf: Buffer) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(rgba: Uint8ClampedArray, w: number, h: number) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/* ───────── Drawing ───────── */

const rand = (min: number, max: number) => min + crypto.randomInt(0, Math.max(1, max - min + 1));

/** Whether a point (relative to the piece's square) is inside the piece: the square plus round tabs on top and right. */
function inPiece(px: number, py: number) {
  const inSquare = px >= 0 && px < PIECE && py >= 0 && py < PIECE;
  const top = (px - PIECE / 2) ** 2 + (py - 0) ** 2 <= KNOB ** 2;
  const right = (px - PIECE) ** 2 + (py - PIECE / 2) ** 2 <= KNOB ** 2;
  return inSquare || top || right;
}
const onEdge = (px: number, py: number) => inPiece(px, py) && !(inPiece(px - 2, py) && inPiece(px + 2, py) && inPiece(px, py - 2) && inPiece(px, py + 2));

/** A soft, random landscape of colour: a gradient with overlapping translucent circles and fine grain. */
function background() {
  const img = new Uint8ClampedArray(W * H * 4);
  const hue = rand(0, 359);
  const c1 = hsl(hue, 55, 42), c2 = hsl((hue + rand(60, 140)) % 360, 60, 62);
  const blobs = Array.from({ length: rand(9, 14) }, () => ({ x: rand(0, W), y: rand(0, H), r: rand(14, 60), c: hsl((hue + rand(0, 300)) % 360, rand(45, 75), rand(35, 75)), a: rand(25, 55) / 100 }));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = (x / W) * 0.7 + (y / H) * 0.3;
    let r = c1[0] + (c2[0] - c1[0]) * t, g = c1[1] + (c2[1] - c1[1]) * t, b = c1[2] + (c2[2] - c1[2]) * t;
    for (const bl of blobs) {
      const d = Math.hypot(x - bl.x, y - bl.y);
      if (d < bl.r) { const a = bl.a * (1 - d / bl.r) ** 0.5; r += (bl.c[0] - r) * a; g += (bl.c[1] - g) * a; b += (bl.c[2] - b) * a; }
    }
    const n = crypto.randomInt(0, 15) - 7;
    const i = (y * W + x) * 4;
    img[i] = r + n; img[i + 1] = g + n; img[i + 2] = b + n; img[i + 3] = 255;
  }
  return img;
}
function hsl(h: number, s: number, l: number): [number, number, number] {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** Cuts the piece out of the picture: the picture gets a shaded gap, and the piece is returned as its own image. */
function cut(bg: Uint8ClampedArray, gx: number, gy: number) {
  const pw = PIECE + PAD * 2;
  const piece = new Uint8ClampedArray(pw * pw * 4);
  for (let y = 0; y < pw; y++) for (let x = 0; x < pw; x++) {
    const px = x - PAD, py = y - PAD;
    if (!inPiece(px, py)) continue;
    const bx = gx + px, by = gy + py;
    if (bx < 0 || bx >= W || by < 0 || by >= H) continue;
    const bi = (by * W + bx) * 4, pi = (y * pw + x) * 4;
    const edge = onEdge(px, py);
    piece[pi] = edge ? 255 : bg[bi]; piece[pi + 1] = edge ? 255 : bg[bi + 1]; piece[pi + 2] = edge ? 255 : bg[bi + 2]; piece[pi + 3] = 255;
    // The gap: darkened, with a light rim.
    if (edge) { bg[bi] = bg[bi] * 0.5 + 120; bg[bi + 1] = bg[bi + 1] * 0.5 + 120; bg[bi + 2] = bg[bi + 2] * 0.5 + 120; }
    else { bg[bi] *= 0.38; bg[bi + 1] *= 0.38; bg[bi + 2] *= 0.38; }
  }
  return { piece, size: pw };
}

/* ───────── Challenge and check ───────── */

interface Sealed { x: number; y: number; exp: number; id: string }

export interface Challenge { token: string; background: string; piece: string; pieceY: number; width: number; height: number; pieceSize: number; offset: number; devAnswer?: number }

/** A new puzzle. `devAnswer` (where the piece belongs) is only included for automated tests outside production. */
export function newChallenge(opts: { dev?: boolean } = {}): Challenge {
  const x = rand(PIECE + 50, W - PIECE - PAD - 4); // never at the start, where the piece begins
  const y = rand(PAD + 2, H - PIECE - PAD - 2);
  const bg = background();
  const { piece, size } = cut(bg, x, y);
  const token = encryptString(JSON.stringify({ x, y, exp: Date.now() + TOKEN_LIFE_MS, id: crypto.randomUUID() } satisfies Sealed));
  return {
    token, width: W, height: H, pieceSize: size, offset: PAD, pieceY: y - PAD,
    background: `data:image/png;base64,${png(bg, W, H).toString("base64")}`,
    piece: `data:image/png;base64,${png(piece, size, size).toString("base64")}`,
    ...(opts.dev ? { devAnswer: x } : {}),
  };
}

export type Trail = [number, number, number][]; // [milliseconds since start, x, y]

export type CheckResult = { ok: true; id: string } | { ok: false; reason: "expired" | "position" | "movement" | "invalid" };

/**
 * Checks an answer: the piece must sit within a few pixels of the gap, and the movement must look like a
 * person's (it took a moment, with several steps that are not perfectly even). A keyboard answer is accepted
 * on position and time alone, so the check works without a mouse.
 */
export function checkAnswer(token: string, x: number, trail: Trail, method: "pointer" | "keyboard", now = Date.now()): CheckResult {
  let s: Sealed;
  try { s = JSON.parse(decryptString(token)); } catch { return { ok: false, reason: "invalid" }; }
  if (typeof s?.x !== "number" || now > s.exp) return { ok: false, reason: "expired" };
  if (!Number.isFinite(x) || Math.abs(x - s.x) > TOLERANCE) return { ok: false, reason: "position" };
  if (!Array.isArray(trail) || trail.length > 2000) return { ok: false, reason: "movement" };
  const steps = trail.filter((p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite));
  const duration = steps.length ? steps[steps.length - 1][0] - steps[0][0] : 0;
  if (duration < 250) return { ok: false, reason: "movement" };
  if (method === "pointer") {
    if (steps.length < 5) return { ok: false, reason: "movement" };
    const gaps = steps.slice(1).map((p, i) => p[0] - steps[i][0]);
    const moves = steps.slice(1).map((p, i) => p[1] - steps[i][1]);
    const ys = new Set(steps.map((p) => Math.round(p[2])));
    const even = new Set(gaps.map((g) => Math.round(g))).size <= 1 && new Set(moves.map((m) => Math.round(m))).size <= 1;
    if (even && ys.size <= 1) return { ok: false, reason: "movement" };
  }
  return { ok: true, id: s.id };
}

/**
 * The cookie value showing the check was passed: expiry and a signature. It lasts the time set under
 * Settings > Security; with none set, long enough to sign in once, and it is removed at sign-in.
 */
export const passSeconds = (validMinutes: number) => (validMinutes > 0 ? validMinutes * 60 : 5 * 60);
export function passCookie(validMinutes: number, now = Date.now()) {
  const exp = String(now + passSeconds(validMinutes) * 1000);
  return `${exp}.${hmac(`human:${exp}`)}`;
}

export function hasPassed(value: string | undefined, now = Date.now()) {
  if (!value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < now) return false;
  return timingSafeEqualStr(sig, hmac(`human:${exp}`));
}
