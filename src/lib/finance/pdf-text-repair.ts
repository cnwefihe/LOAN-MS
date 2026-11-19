/**
 * Repairs the text layer of a PDF saved by Safari or Preview on a Mac. When macOS re-saves a web page or
 * PDF, it embeds each font as a subset whose character codes are glyph numbers, and writes a broken
 * ToUnicode table that maps every code to itself. The page looks right, but the text reads as nonsense
 * ("1,395,656.42" comes out as ".8052832371/"). The embedded font still holds the true character for each
 * glyph in its own cmap table, so the ToUnicode table is rebuilt from it. Nothing else in the file changes.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream, type PDFObject } from "pdf-lib";

/** Glyph number to character, from a TrueType font's Unicode cmap (format 4 or 12). */
export function glyphToUnicode(font: Buffer): Map<number, number> {
  const out = new Map<number, number>();
  if (font.length < 12) return out;
  const tables = font.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < tables; i++) {
    const o = 12 + i * 16;
    if (o + 16 > font.length) return out;
    if (font.toString("latin1", o, o + 4) === "cmap") cmap = font.readUInt32BE(o + 8);
  }
  if (cmap < 0 || cmap + 4 > font.length) return out;
  const subtables = font.readUInt16BE(cmap + 2);
  const candidates: number[] = [];
  for (let i = 0; i < subtables; i++) {
    const p = font.readUInt16BE(cmap + 4 + i * 8), e = font.readUInt16BE(cmap + 6 + i * 8);
    if ((p === 3 && (e === 1 || e === 10)) || p === 0) candidates.push(cmap + font.readUInt32BE(cmap + 8 + i * 8));
  }
  const add = (code: number, glyph: number) => { if (glyph && !out.has(glyph)) out.set(glyph, code); };
  for (const sub of candidates) {
    const format = font.readUInt16BE(sub);
    if (format === 4) {
      const segX2 = font.readUInt16BE(sub + 6);
      const ends = sub + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let k = 0; k < segX2 / 2; k++) {
        const end = font.readUInt16BE(ends + k * 2), start = font.readUInt16BE(starts + k * 2);
        const delta = font.readInt16BE(deltas + k * 2), range = font.readUInt16BE(ranges + k * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          if (range === 0) add(c, (c + delta) & 0xffff);
          else {
            const at = ranges + k * 2 + range + (c - start) * 2;
            if (at + 2 > font.length) continue;
            const g = font.readUInt16BE(at);
            if (g) add(c, (g + delta) & 0xffff);
          }
        }
      }
    } else if (format === 12) {
      const groups = font.readUInt32BE(sub + 12);
      for (let k = 0; k < groups; k++) {
        const o = sub + 16 + k * 12;
        const start = font.readUInt32BE(o), end = font.readUInt32BE(o + 4), glyph = font.readUInt32BE(o + 8);
        for (let c = start; c <= end && c - start < 0x10000; c++) add(c, glyph + (c - start));
      }
    }
  }
  return out;
}

const hex = (n: number, w = 4) => n.toString(16).toUpperCase().padStart(w, "0");

function utf16(code: number) {
  if (code < 0x10000) return hex(code);
  const v = code - 0x10000;
  return hex(0xd800 + (v >> 10)) + hex(0xdc00 + (v & 0x3ff));
}

/** A ToUnicode CMap mapping each glyph number (two-byte code) to its character. */
function buildCMap(map: Map<number, number>) {
  const entries = [...map.entries()].sort((a, b) => a[0] - b[0]);
  const blocks: string[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    blocks.push(`${chunk.length} beginbfchar\n${chunk.map(([g, c]) => `<${hex(g)}> <${utf16(c)}>`).join("\n")}\nendbfchar`);
  }
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${blocks.join("\n")}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
}

/** Whether a ToUnicode table only maps codes to themselves (one range starting at the same number). */
function isIdentityOnly(text: string) {
  if (/beginbfchar/.test(text)) return false;
  const ranges = [...text.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)];
  return ranges.length > 0 && ranges.every((r) => parseInt(r[1], 16) === parseInt(r[3], 16));
}

/**
 * Returns a copy of the PDF with broken ToUnicode tables rebuilt, or null when there was nothing to repair
 * (the file is left as it was).
 */
export async function repairMacText(bytes: Uint8Array): Promise<Uint8Array | null> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return null;
  }
  const ctx = doc.context;
  const look = (o: PDFObject | undefined) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const streamText = (s: PDFObject | undefined) => (s instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(s).decode()) : null);
  let repaired = 0;
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (look(obj.get(PDFName.of("Subtype")))?.toString() !== "/Type0") continue;
    const toUnicode = look(obj.get(PDFName.of("ToUnicode")));
    const current = streamText(toUnicode);
    if (!current || !isIdentityOnly(current.toString("latin1"))) continue;
    const descendants = look(obj.get(PDFName.of("DescendantFonts")));
    const cid = descendants instanceof PDFArray ? look(descendants.get(0)) : undefined;
    if (!(cid instanceof PDFDict)) continue;
    // Codes are glyph numbers only when the CID-to-glyph map is the identity (or not given).
    const cidToGid = look(cid.get(PDFName.of("CIDToGIDMap")));
    if (cidToGid && cidToGid.toString() !== "/Identity") continue;
    const descriptor = look(cid.get(PDFName.of("FontDescriptor")));
    if (!(descriptor instanceof PDFDict)) continue;
    const fontFile = streamText(look(descriptor.get(PDFName.of("FontFile2"))));
    if (!fontFile) continue;
    const map = glyphToUnicode(fontFile);
    if (map.size < 5) continue;
    const stream = ctx.flateStream(buildCMap(map));
    obj.set(PDFName.of("ToUnicode"), ctx.register(stream));
    repaired++;
  }
  if (!repaired) return null;
  return doc.save({ useObjectStreams: false });
}

