import { describe, expect, it } from "vitest";
import { glyphToUnicode, repairMacText } from "@/lib/finance/pdf-text-repair";
import { renderPayslipPdf, samplePayslip } from "@/lib/finance/payslip-pdf";

/** A minimal TrueType font holding only a cmap table (format 4): "A" to "C" are glyphs 1 to 3, "0" to "2" are glyphs 10 to 12. */
function fontWithCmap() {
  const segs = [{ start: 0x30, end: 0x32, delta: 10 - 0x30 }, { start: 0x41, end: 0x43, delta: 1 - 0x41 }, { start: 0xffff, end: 0xffff, delta: 1 }];
  const n = segs.length;
  const sub = Buffer.alloc(16 + n * 8);
  sub.writeUInt16BE(4, 0); sub.writeUInt16BE(sub.length, 2); sub.writeUInt16BE(n * 2, 6);
  segs.forEach((s, i) => {
    sub.writeUInt16BE(s.end, 14 + i * 2);
    sub.writeUInt16BE(s.start, 16 + n * 2 + i * 2);
    sub.writeInt16BE(s.delta, 16 + n * 4 + i * 2);
    sub.writeUInt16BE(0, 16 + n * 6 + i * 2);
  });
  const cmap = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 3, 0, 1, 0, 0, 0, 12]), sub]);
  const head = Buffer.alloc(12 + 16);
  head.writeUInt32BE(0x00010000, 0); head.writeUInt16BE(1, 4);
  head.write("cmap", 12, "latin1"); head.writeUInt32BE(head.length, 20); head.writeUInt32BE(cmap.length, 24);
  return Buffer.concat([head, cmap]);
}

describe("payslips saved on a Mac", () => {
  it("finds the character behind each glyph from the font itself", () => {
    const map = glyphToUnicode(fontWithCmap());
    expect(String.fromCharCode(map.get(1)!, map.get(2)!, map.get(3)!)).toBe("ABC");
    expect(String.fromCharCode(map.get(10)!, map.get(12)!)).toBe("02");
    expect(glyphToUnicode(Buffer.alloc(4)).size).toBe(0);
  });

  it("leaves a PDF with a sound text layer untouched", async () => {
    const pdf = await renderPayslipPdf(samplePayslip({ name: "Ada Obi", code: "EX-0001", grade: "Officer I Step 1", period: "2026-05", basic: "300000", medical: "20000", tax: "40000", pension: "24000" }));
    expect(await repairMacText(new Uint8Array(pdf))).toBeNull();
  });
});
