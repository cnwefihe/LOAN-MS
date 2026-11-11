import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";

/**
 * Text drawn by pdf-lib: decode every stream in the document through pdf-lib itself (so compressed data is
 * never cut at the wrong byte) and read its hex-string show operators.
 */
export async function pdfText(bytes: Buffer): Promise<{ text: string; pages: number }> {
  const doc = await PDFDocument.load(bytes);
  let text = "";
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    let content: string;
    try { content = Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1"); } catch { continue; }
    for (const t of content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) text += `${Buffer.from(t[1], "hex").toString("latin1")}\n`;
  }
  return { text, pages: doc.getPageCount() };
}
