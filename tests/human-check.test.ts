import { describe, expect, it } from "vitest";
import { checkAnswer, hasPassed, newChallenge, passCookie, type Trail } from "@/server/human-check";

const human = (to: number): Trail => [[0, 10, 200], [90, 40, 201], [170, 75, 203], [260, to - 5, 202], [330, to, 202]];

describe("human check", () => {
  it("draws a picture and a piece as PNG images without giving away where the gap is", () => {
    const c = newChallenge({ dev: true });
    expect(c.background.startsWith("data:image/png;base64,iVBOR")).toBe(true);
    expect(c.piece.startsWith("data:image/png;base64,iVBOR")).toBe(true);
    expect(c.token).not.toContain(String(c.devAnswer));
    expect(newChallenge().devAnswer).toBeUndefined();
  });

  it("accepts the piece in the gap with a person's movement, and refuses a wrong place or a robot's movement", () => {
    const c = newChallenge({ dev: true });
    const x = c.devAnswer!;
    expect(checkAnswer(c.token, x + 4, human(x + 4), "pointer").ok).toBe(true);
    expect(checkAnswer(c.token, x + 25, human(x + 25), "pointer")).toEqual({ ok: false, reason: "position" });
    // Instant, or perfectly even steps in a straight line.
    expect(checkAnswer(c.token, x, [[0, 0, 0], [10, x, 0]], "pointer")).toEqual({ ok: false, reason: "movement" });
    const robot: Trail = Array.from({ length: 10 }, (_, i) => [i * 50, i * 10, 100]);
    expect(checkAnswer(c.token, x, robot, "pointer")).toEqual({ ok: false, reason: "movement" });
    // Keyboard: position and time only.
    expect(checkAnswer(c.token, x, [[0, 0, 0], [400, x, 0]], "keyboard").ok).toBe(true);
  });

  it("refuses a tampered or expired puzzle", () => {
    const c = newChallenge({ dev: true });
    expect(checkAnswer(c.token.slice(0, -4) + "AAAA", c.devAnswer!, human(c.devAnswer!), "pointer").ok).toBe(false);
    expect(checkAnswer(c.token, c.devAnswer!, human(c.devAnswer!), "pointer", Date.now() + 3 * 60_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("the pass lasts a short while and cannot be forged", () => {
    const now = Date.now();
    const v = passCookie(15, now);
    expect(hasPassed(v, now + 60_000)).toBe(true);
    expect(hasPassed(v, now + 16 * 60_000)).toBe(false);
    expect(hasPassed(`${now + 999_999}.${v.split(".")[1]}`, now)).toBe(false);
    expect(hasPassed(undefined)).toBe(false);
  });
});
