/**
 * Branded PDF layout engine for agreements, advices, receipts, statements, letters and reports.
 *
 * Every page carries the institution's logo header, a bold diagonal security watermark, and a footer
 * with the authorised-users notice, the document reference and page numbering. Each finished document
 * gets a unique reference and its SHA-256 is recorded in issued_documents so it can be verified later.
 *
 * Reports use the standard structure: document control panel, numbered sections, executive summary,
 * detail tables with totals, notes and definitions, and a review and sign-off block.
 */
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import type { Executor } from "@/db";
import { issuedDocuments } from "@/db/schema";
import { sha256Hex } from "@/lib/security/crypto";
import { hexToRgb, shade } from "@/lib/colour";
import { getBranding, getLogo, type Branding } from "./branding";
import { nextReference } from "./references";
import type { Actor } from "./actor";

const TEXT = rgb(0x17 / 255, 0x20 / 255, 0x33 / 255);
const MUTED = rgb(0x5f / 255, 0x6f / 255, 0x86 / 255);
const LINE = rgb(0.86, 0.88, 0.92);
const ZEBRA = rgb(0.965, 0.972, 0.982);
const MARK = rgb(0.72, 0.11, 0.11);
const TONES = { default: null, good: rgb(0.08, 0.5, 0.24), warn: rgb(0.85, 0.47, 0.02), bad: rgb(0.86, 0.15, 0.15) } as const;

const hex = (h: string): RGB => {
  const [r, g, b] = hexToRgb(h);
  return rgb(r / 255, g / 255, b / 255);
};

/** Standard PDF fonts are WinAnsi-only; replace characters they cannot encode. */
export function safe(text: string): string {
  return text.replace(/₦/g, "NGN ").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/·/g, "|").replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/g, "?");
}

export function lagosStamp(d = new Date()): string {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${f.format(d).replace(",", "").replace("Sept", "Sep")} WAT`;
}

export interface PdfOptions {
  title: string;
  subtitle?: string;
  /** Register category, e.g. "receipt", "statement", "loan_agreement", "report". */
  kind: string;
  landscape?: boolean;
  /** Reference of the loan this document belongs to; it becomes the document's reference (one reference per loan cycle). */
  parent?: string;
  /** Prefix headings with section numbers (1, 2, 3 ...), as in formal reports. */
  numbered?: boolean;
}

export interface SummaryItem { label: string; value: string; tone?: keyof typeof TONES }
export interface TableOptions { align?: ("left" | "right")[]; totals?: string[] }
export interface ChartSeries { name: string; values: number[] }

export class PdfBuilder {
  private doc!: PDFDocument;
  private page!: PDFPage;
  private font!: PDFFont;
  private bold!: PDFFont;
  private logo: PDFImage | null = null;
  private brand!: Branding;
  private primary!: RGB;
  private tint!: RGB;
  private opts!: PdfOptions;
  readonly reference: string = "";
  readonly issuedAt = lagosStamp();
  private section = 0;
  private y = 0;
  private readonly margin = 50;
  private readonly bottom = 72;
  private width = 595.28;
  private height = 841.89;

  static async create(db: Executor, opts: PdfOptions): Promise<PdfBuilder> {
    const b = new PdfBuilder();
    b.opts = opts;
    b.brand = await getBranding(db);
    b.primary = hex(b.brand.primaryColour);
    b.tint = hex(shade(b.brand.primaryColour, 0.92));
    (b as { reference: string }).reference = opts.parent ?? (await nextReference(db));
    b.doc = await PDFDocument.create();
    b.doc.setTitle(safe(opts.title));
    b.doc.setAuthor(safe(b.brand.institutionName));
    b.doc.setSubject(safe(`${b.brand.confidentialMarking}. ${b.brand.footerNotice}`));
    b.doc.setKeywords([b.reference, opts.kind, b.brand.confidentialMarking]);
    b.doc.setProducer(safe(b.brand.systemName));
    b.doc.setCreator(safe(`${b.brand.systemName}, ${b.brand.institutionName}`));
    b.font = await b.doc.embedFont(StandardFonts.Helvetica);
    b.bold = await b.doc.embedFont(StandardFonts.HelveticaBold);
    const logo = await getLogo(db, "logo");
    if (logo) {
      try {
        b.logo = logo.mimeType === "image/jpeg" ? await b.doc.embedJpg(logo.bytes) : await b.doc.embedPng(logo.bytes);
      } catch {
        b.logo = null; // unreadable upload: fall back to the text header rather than failing the document
      }
    }
    if (opts.landscape) [b.width, b.height] = [b.height, b.width];
    b.firstPage();
    return b;
  }

  private get usable() { return this.width - this.margin * 2; }

  private firstPage() {
    this.page = this.doc.addPage([this.width, this.height]);
    const top = this.height - 34;
    const right = this.width - this.margin;
    let headerBottom: number;
    if (this.logo) {
      const h = 44;
      const w = (this.logo.width / this.logo.height) * h;
      this.page.drawImage(this.logo, { x: this.margin, y: top - h, width: w, height: h });
      headerBottom = top - h;
    } else {
      this.page.drawText(safe(this.brand.institutionName.toUpperCase()), { x: this.margin, y: top - 16, size: 14, font: this.bold, color: this.primary });
      headerBottom = top - 24;
    }
    const lines: [string, PDFFont, number, RGB][] = [
      [this.brand.institutionName, this.bold, 10, this.primary],
      [this.brand.systemName, this.font, 9, TEXT],
      ...(this.brand.address ? [[this.brand.address, this.font, 7.5, MUTED] as [string, PDFFont, number, RGB]] : []),
      ...(this.brand.supportEmail ? [[[this.brand.supportEmail, this.brand.supportPhone].filter(Boolean).join("  |  "), this.font, 7.5, MUTED] as [string, PDFFont, number, RGB]] : []),
    ];
    let ly = top - 8;
    for (const [t, f, s, c] of lines) {
      const txt = safe(t);
      this.page.drawText(txt, { x: right - f.widthOfTextAtSize(txt, s), y: ly, size: s, font: f, color: c });
      ly -= s + 4;
    }
    const ruleY = Math.min(headerBottom, ly) - 8;
    this.page.drawRectangle({ x: this.margin, y: ruleY, width: this.usable, height: 2, color: this.primary });
    this.y = ruleY - 14;
    this.text(this.opts.title, { size: 16, bold: true, color: this.primary });
    if (this.opts.subtitle) this.text(this.opts.subtitle, { size: 9, color: MUTED });
    this.text(`Document reference ${this.reference}  |  Issued ${this.issuedAt}`, { size: 8, color: MUTED });
    this.gap(8);
  }

  private continuationPage() {
    this.page = this.doc.addPage([this.width, this.height]);
    const y = this.height - 40;
    this.page.drawText(safe(`${this.brand.institutionName}  |  ${this.brand.systemName}`), { x: this.margin, y, size: 8, font: this.bold, color: this.primary });
    const t = safe(this.opts.title);
    this.page.drawText(t, { x: this.width - this.margin - this.font.widthOfTextAtSize(t, 8), y, size: 8, font: this.font, color: MUTED });
    this.page.drawLine({ start: { x: this.margin, y: y - 6 }, end: { x: this.width - this.margin, y: y - 6 }, thickness: 1, color: this.primary });
    this.y = y - 20;
  }

  private ensure(h: number) {
    if (this.y - h < this.bottom) this.continuationPage();
  }

  /** Starts the next section on a fresh page (used between major report parts). */
  newPage() { this.continuationPage(); }

  gap(h = 10) { this.y -= h; }

  private wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const out: string[] = [];
    for (const para of safe(text).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) { out.push(line); line = word; }
        else line = candidate;
      }
      out.push(line);
    }
    return out;
  }

  text(text: string, opts: { size?: number; bold?: boolean; color?: RGB } = {}) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.font;
    for (const line of this.wrap(text, font, size, this.usable)) {
      this.ensure(size + 4);
      this.page.drawText(line, { x: this.margin, y: this.y - size, size, font, color: opts.color ?? TEXT });
      this.y -= size + 4;
    }
  }

  /** Muted explanatory line, e.g. a note under a table. */
  note(text: string) { this.text(text, { size: 8, color: MUTED }); }

  heading(text: string) {
    this.gap(8);
    this.ensure(48);
    const label = this.opts.numbered ? `${++this.section}. ${text}` : text;
    this.text(label, { size: 12, bold: true, color: this.primary });
    this.page.drawLine({ start: { x: this.margin, y: this.y }, end: { x: this.width - this.margin, y: this.y }, thickness: 0.5, color: LINE });
    this.gap(6);
  }

  /** Document control panel: a bordered grid of label and value pairs, two pairs per row. */
  controlPanel(items: [string, string][]) {
    const perRow = 2;
    const colW = this.usable / perRow;
    const labelW = Math.min(110, colW * 0.42);
    const lineH = 10.5;
    const wrapped = items.map(([, v]) => this.wrap(v, this.font, 8.5, colW - labelW - 10).slice(0, 3));
    for (let r = 0; r * perRow < items.length; r++) {
      const cells = items.slice(r * perRow, r * perRow + perRow);
      const lines = Math.max(...cells.map((_, j) => wrapped[r * perRow + j].length));
      const rowH = 7 + lines * lineH;
      this.ensure(rowH + 8);
      const y = this.y - rowH;
      cells.forEach(([k], j) => {
        const x = this.margin + j * colW;
        this.page.drawRectangle({ x, y, width: labelW, height: rowH, color: this.tint });
        this.page.drawRectangle({ x, y, width: colW, height: rowH, borderColor: LINE, borderWidth: 0.6 });
        this.page.drawText(safe(k), { x: x + 5, y: this.y - 12, size: 7.5, font: this.bold, color: MUTED });
        wrapped[r * perRow + j].forEach((l, n) => this.page.drawText(l, { x: x + labelW + 5, y: this.y - 12 - n * lineH, size: 8.5, font: this.font, color: TEXT }));
      });
      this.y = y;
    }
    this.gap(8);
  }

  /** Summary: headline figures as tiles, followed by optional narrative points. */
  summary(items: SummaryItem[], points: string[] = [], title = "Summary") {
    this.heading(title);
    this.tiles(items);
    this.bullets(points);
    this.gap(4);
  }

  tiles(items: SummaryItem[]) {
    const perRow = this.width > 700 ? 5 : 4;
    const gapX = 8;
    const w = (this.usable - gapX * (perRow - 1)) / perRow;
    const h = 46;
    for (let i = 0; i < items.length; i += perRow) {
      this.ensure(h + 8);
      items.slice(i, i + perRow).forEach((it, j) => {
        const x = this.margin + j * (w + gapX);
        const y = this.y - h;
        this.page.drawRectangle({ x, y, width: w, height: h, color: this.tint });
        this.page.drawRectangle({ x, y, width: 3, height: h, color: TONES[it.tone ?? "default"] ?? this.primary });
        const label = safe(it.label.toUpperCase());
        this.page.drawText(label, { x: x + 9, y: y + h - 14, size: 6.5, font: this.bold, color: MUTED, maxWidth: w - 12 });
        let size = 12;
        const value = safe(it.value);
        while (size > 7 && this.bold.widthOfTextAtSize(value, size) > w - 14) size -= 0.5;
        this.page.drawText(value, { x: x + 9, y: y + 10, size, font: this.bold, color: TEXT });
      });
      this.y -= h + 8;
    }
  }

  bullets(points: string[]) {
    for (const p of points) {
      const lines = this.wrap(p, this.font, 9.5, this.usable - 12);
      this.ensure(lines.length * 13 + 2);
      this.page.drawCircle({ x: this.margin + 3, y: this.y - 6.5, size: 1.6, color: this.primary });
      lines.forEach((l, k) => this.page.drawText(l, { x: this.margin + 12, y: this.y - 9.5 - k * 13, size: 9.5, font: this.font, color: TEXT }));
      this.y -= lines.length * 13 + 2;
    }
  }

  /** Numbered notes, e.g. "Notes and definitions". */
  numberedList(items: string[]) {
    items.forEach((p, i) => {
      const lines = this.wrap(p, this.font, 8.5, this.usable - 18);
      this.ensure(lines.length * 11.5 + 2);
      this.page.drawText(`${i + 1}.`, { x: this.margin, y: this.y - 8.5, size: 8.5, font: this.bold, color: MUTED });
      lines.forEach((l, k) => this.page.drawText(l, { x: this.margin + 18, y: this.y - 8.5 - k * 11.5, size: 8.5, font: this.font, color: TEXT }));
      this.y -= lines.length * 11.5 + 3;
    });
  }

  keyValues(rows: [string, string][]) {
    const labelW = 190;
    for (const [k, v] of rows) {
      const lines = this.wrap(v, this.font, 10, this.usable - labelW);
      this.ensure(14 * lines.length);
      this.page.drawText(safe(k), { x: this.margin, y: this.y - 10, size: 9, font: this.font, color: MUTED });
      lines.forEach((l, i) => this.page.drawText(l, { x: this.margin + labelW, y: this.y - 10 - i * 13, size: 10, font: this.font, color: TEXT }));
      this.y -= 13 * lines.length + 3;
    }
  }

  private fit(s: string, w: number, f: PDFFont, size: number) {
    const full = safe(s);
    if (f.widthOfTextAtSize(full, size) <= w) return full;
    let t = full;
    while (t.length > 1 && f.widthOfTextAtSize(`${t}..`, size) > w) t = t.slice(0, -1);
    return `${t}..`;
  }

  /**
   * Data table. Column widths follow the content (headers wrap rather than truncate), the header row
   * repeats on every page, and an optional totals row closes the table.
   */
  table(headers: string[], rows: string[][], alignOrOpts: ("left" | "right")[] | TableOptions = []) {
    const o: TableOptions = Array.isArray(alignOrOpts) ? { align: alignOrOpts } : alignOrOpts;
    const align = o.align ?? [];
    const size = headers.length > 8 ? 7.2 : headers.length > 6 ? 7.8 : 8.5;
    const pad = 4;
    const sample = [...rows.slice(0, 400), ...(o.totals ? [o.totals] : [])];
    const natural = headers.map((h, i) => Math.max(
      Math.min(this.bold.widthOfTextAtSize(safe(h), size), 90),
      ...sample.map((r) => this.font.widthOfTextAtSize(safe(r[i] ?? ""), size)),
    ) + pad * 2);
    const floor = headers.map((h) => Math.min(Math.max(...safe(h).split(/\s+/).map((w) => this.bold.widthOfTextAtSize(w, size))) + pad * 2, 80));
    const widths = distribute(natural, floor, this.usable);
    const headerLines = headers.map((h, i) => this.wrap(h, this.bold, size, widths[i] - pad * 2).slice(0, 2));
    const headerH = Math.max(...headerLines.map((l) => l.length)) * (size + 2) + 6;
    const rowH = size + 6.5;

    const drawHeader = () => {
      this.ensure(headerH + rowH);
      this.page.drawRectangle({ x: this.margin, y: this.y - headerH, width: this.usable, height: headerH, color: this.primary });
      let x = this.margin;
      headerLines.forEach((lines, i) => {
        lines.forEach((l, k) => {
          const lx = align[i] === "right" ? x + widths[i] - pad - this.bold.widthOfTextAtSize(l, size) : x + pad;
          this.page.drawText(l, { x: lx, y: this.y - 4 - size - k * (size + 2), size, font: this.bold, color: rgb(1, 1, 1) });
        });
        x += widths[i];
      });
      this.y -= headerH;
    };
    const drawRow = (cells: string[], kind: "body" | "zebra" | "total") => {
      if (kind === "total") this.page.drawRectangle({ x: this.margin, y: this.y - rowH, width: this.usable, height: rowH, color: this.tint });
      else if (kind === "zebra") this.page.drawRectangle({ x: this.margin, y: this.y - rowH, width: this.usable, height: rowH, color: ZEBRA });
      const font = kind === "total" ? this.bold : this.font;
      let x = this.margin;
      cells.forEach((c, i) => {
        const t = this.fit(c ?? "", widths[i] - pad * 2, font, size);
        const tx = align[i] === "right" ? x + widths[i] - pad - font.widthOfTextAtSize(t, size) : x + pad;
        this.page.drawText(t, { x: tx, y: this.y - rowH + 4.5, size, font, color: TEXT });
        x += widths[i];
      });
      this.y -= rowH;
      this.page.drawLine({ start: { x: this.margin, y: this.y }, end: { x: this.margin + this.usable, y: this.y }, thickness: kind === "total" ? 1 : 0.4, color: kind === "total" ? this.primary : LINE });
    };

    if (!rows.length) {
      this.ensure(30);
      this.page.drawRectangle({ x: this.margin, y: this.y - 22, width: this.usable, height: 22, borderColor: LINE, borderWidth: 0.6 });
      this.page.drawText("No records for this selection.", { x: this.margin + 8, y: this.y - 14.5, size: 8.5, font: this.font, color: MUTED });
      this.y -= 30;
      return;
    }
    drawHeader();
    rows.forEach((r, idx) => {
      if (this.y - rowH < this.bottom) { this.continuationPage(); drawHeader(); }
      drawRow(r, idx % 2 === 1 ? "zebra" : "body");
    });
    if (o.totals) {
      if (this.y - rowH < this.bottom) { this.continuationPage(); drawHeader(); }
      drawRow(o.totals, "total");
    }
    this.gap(8);
  }

  /**
   * Grouped bar chart with a legend and labelled value axis. The first series is drawn in a light
   * tint of the brand colour and the second in the full brand colour, so the pair stays distinct in
   * greyscale print.
   */
  barChart(categories: string[], series: ChartSeries[], opts: { height?: number; axisLabel?: string; format?: (n: number) => string } = {}) {
    const h = opts.height ?? 150;
    const format = opts.format ?? compact;
    this.ensure(h + 46);
    const colours = [hex(shade(this.brand.primaryColour, 0.55)), this.primary];
    // Legend
    let lx = this.margin;
    series.forEach((s, i) => {
      this.page.drawRectangle({ x: lx, y: this.y - 9, width: 8, height: 8, color: colours[i % 2] });
      const name = safe(s.name);
      this.page.drawText(name, { x: lx + 12, y: this.y - 8.5, size: 8, font: this.font, color: TEXT });
      lx += 24 + this.font.widthOfTextAtSize(name, 8);
    });
    if (opts.axisLabel) {
      const al = safe(opts.axisLabel);
      this.page.drawText(al, { x: this.width - this.margin - this.font.widthOfTextAtSize(al, 7.5), y: this.y - 8.5, size: 7.5, font: this.font, color: MUTED });
    }
    this.y -= 18;
    const max = Math.max(1, ...series.flatMap((s) => s.values));
    const step = niceStep(max / 4);
    const top = Math.ceil(max / step) * step;
    const axisW = 44;
    const plotX = this.margin + axisW;
    const plotW = this.usable - axisW;
    const base = this.y - h;
    for (let v = 0; v <= top + 1e-9; v += step) {
      const y = base + (v / top) * h;
      this.page.drawLine({ start: { x: plotX, y }, end: { x: plotX + plotW, y }, thickness: v === 0 ? 0.8 : 0.4, color: v === 0 ? MUTED : LINE });
      const t = format(v);
      this.page.drawText(t, { x: plotX - 5 - this.font.widthOfTextAtSize(t, 7), y: y - 2.5, size: 7, font: this.font, color: MUTED });
    }
    const slot = plotW / Math.max(1, categories.length);
    const barW = Math.min(14, (slot * 0.7) / series.length);
    categories.forEach((c, i) => {
      const groupW = barW * series.length + 2 * (series.length - 1);
      let bx = plotX + i * slot + (slot - groupW) / 2;
      series.forEach((s, k) => {
        const bh = (Math.max(0, s.values[i] ?? 0) / top) * h;
        if (bh > 0) this.page.drawRectangle({ x: bx, y: base, width: barW, height: bh, color: colours[k % 2] });
        bx += barW + 2;
      });
      const label = safe(c);
      this.page.drawText(label, { x: plotX + i * slot + slot / 2 - this.font.widthOfTextAtSize(label, 6.8) / 2, y: base - 11, size: 6.8, font: this.font, color: MUTED });
    });
    this.y = base - 22;
  }

  /** Review and sign-off block: one box per role with name, signature and date lines. */
  signOff(roles: { role: string; name?: string; date?: string }[]) {
    const gapX = 10;
    const w = (this.usable - gapX * (roles.length - 1)) / roles.length;
    const h = 78;
    this.gap(4);
    this.ensure(h + 6);
    roles.forEach((r, i) => {
      const x = this.margin + i * (w + gapX);
      const y = this.y - h;
      this.page.drawRectangle({ x, y, width: w, height: h, borderColor: LINE, borderWidth: 0.8 });
      this.page.drawRectangle({ x, y: y + h - 16, width: w, height: 16, color: this.tint });
      this.page.drawText(safe(r.role.toUpperCase()), { x: x + 6, y: y + h - 11, size: 7, font: this.bold, color: this.primary });
      [["Name", r.name], ["Signature", undefined], ["Date", r.date]].forEach(([k, v], j) => {
        const ly = y + h - 34 - j * 18;
        this.page.drawText(`${k}:`, { x: x + 6, y: ly, size: 7.5, font: this.font, color: MUTED });
        this.page.drawLine({ start: { x: x + 48, y: ly - 2 }, end: { x: x + w - 8, y: ly - 2 }, thickness: 0.5, color: LINE });
        if (v) this.page.drawText(this.fit(v, w - 60, this.font, 8), { x: x + 50, y: ly, size: 8, font: this.font, color: TEXT });
      });
    });
    this.y -= h + 8;
  }

  signatureBlock(lines: string[]) {
    this.gap(14);
    this.ensure(20 + lines.length * 12);
    lines.forEach((l) => this.text(l, { size: 9, color: MUTED }));
  }

  private decorate() {
    const pages = this.doc.getPages();
    const marking = safe(this.brand.confidentialMarking.toUpperCase());
    const notice = safe(this.brand.footerNotice);
    const meta = safe(`Document reference ${this.reference}  |  Issued ${this.issuedAt}`);
    const owner = safe(this.brand.systemName);
    pages.forEach((p, i) => {
      const { width, height } = p.getSize();
      if (this.brand.watermark && marking) {
        const size = Math.min(110, (Math.hypot(width, height) * 0.66) / Math.max(1, this.bold.widthOfTextAtSize(marking, 1)));
        const w = this.bold.widthOfTextAtSize(marking, size);
        const th = size * 0.7;
        const a = Math.atan2(height, width);
        p.drawText(marking, {
          x: width / 2 - (w / 2) * Math.cos(a) + (th / 2) * Math.sin(a), y: height / 2 - (w / 2) * Math.sin(a) - (th / 2) * Math.cos(a),
          size, font: this.bold, color: MARK, opacity: 0.13, rotate: degrees((a * 180) / Math.PI),
        });
      }
      p.drawLine({ start: { x: this.margin, y: 50 }, end: { x: width - this.margin, y: 50 }, thickness: 0.6, color: this.primary });
      p.drawText(notice, { x: this.margin, y: 37, size: 8, font: this.bold, color: TEXT });
      const pg = `Page ${i + 1} of ${pages.length}`;
      p.drawText(pg, { x: width - this.margin - this.bold.widthOfTextAtSize(pg, 8), y: 37, size: 8, font: this.bold, color: TEXT });
      p.drawText(meta, { x: this.margin, y: 25, size: 7, font: this.font, color: MUTED });
      p.drawText(owner, { x: width - this.margin - this.font.widthOfTextAtSize(owner, 7), y: 25, size: 7, font: this.font, color: MUTED });
    });
  }

  /** Applies page furniture, serialises the document and records it in the document register. */
  async finish(db: Executor, actor: Actor | null, rec: { entityType?: string; entityId?: string; loanAccountId?: string | null; subjectUserId?: string | null } = {}): Promise<Buffer> {
    this.decorate();
    const bytes = Buffer.from(await this.doc.save());
    await db.insert(issuedDocuments).values({
      reference: this.reference, kind: this.opts.kind, title: this.opts.title.slice(0, 200), sha256: sha256Hex(bytes),
      entityType: rec.entityType ?? null, entityId: rec.entityId ?? null, loanAccountId: rec.loanAccountId ?? null,
      subjectUserId: rec.subjectUserId ?? null, issuedBy: actor?.userId ?? null,
    });
    return bytes;
  }
}

/** Shares `total` width across columns: each gets at least its floor, and wide content is capped evenly. */
function distribute(natural: number[], floor: number[], total: number): number[] {
  const want = natural.map((n, i) => Math.max(n, floor[i]));
  const sum = want.reduce((a, b) => a + b, 0);
  if (sum <= total) return want.map((w) => (w / sum) * total);
  const floorSum = floor.reduce((a, b) => a + b, 0);
  if (floorSum >= total) return floor.map((f) => (f / floorSum) * total);
  let lo = 0, hi = Math.max(...want);
  for (let k = 0; k < 40; k++) {
    const cap = (lo + hi) / 2;
    const used = want.reduce((a, w, i) => a + Math.max(floor[i], Math.min(w, cap)), 0);
    if (used > total) hi = cap; else lo = cap;
  }
  const out = want.map((w, i) => Math.max(floor[i], Math.min(w, lo)));
  const slack = total - out.reduce((a, b) => a + b, 0);
  return out.map((w) => w + slack / out.length);
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function compact(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}bn`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(0)}k`;
  return String(Math.round(n));
}
