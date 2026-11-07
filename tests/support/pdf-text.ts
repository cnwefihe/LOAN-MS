import zlib from "node:zlib";
import { PDFDocument } from "pdf-lib";

/** Text drawn by pdf-lib: inflate each content stream and decode its hex-string show operators. */
export async function pdfText(bytes: Buffer): Promise<{ text: string; pages: number }> {
  const raw = bytes.toString("latin1");
  let text = "";
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content: string;
    try { content = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); } catch { content = m[1]; }
    for (const t of content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) text += `${Buffer.from(t[1], "hex").toString("latin1")}\n`;
  }
  return { text, pages: (await PDFDocument.load(bytes)).getPageCount() };
}
