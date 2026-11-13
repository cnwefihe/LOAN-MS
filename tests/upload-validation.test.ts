/**
 * Uploads are judged by what the file is, not its name: a real PDF downloaded from a payroll system passes
 * even with bytes before its header or a missing or wrong extension, and anything else is refused.
 */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-upload-"));

import { getDb, type Database } from "@/db";
import { seedBase } from "@/server/seed";
import { validateUpload } from "@/server/services/documents";

let db: Database;
let pdf: Buffer;
const asFile = (bytes: Buffer | string, name: string, type = "application/pdf") => new File([typeof bytes === "string" ? bytes : new Uint8Array(bytes)], name, { type });

beforeAll(async () => {
  db = await getDb();
  await db.transaction((tx) => seedBase(tx));
  const doc = await PDFDocument.create();
  doc.addPage().drawText("Sample");
  pdf = Buffer.from(await doc.save());
});

describe("upload validation", () => {
  it("accepts a normal PDF and keeps its name", async () => {
    const v = await validateUpload(db, asFile(pdf, "Payslip October 2026.pdf"));
    expect(v.mime).toBe("application/pdf");
    expect(v.fileName).toBe("Payslip October 2026.pdf");
  });

  it("accepts a PDF saved with no extension, an upper-case one or a wrong one, and names it .pdf", async () => {
    expect((await validateUpload(db, asFile(pdf, "payslip_2026-10"))).fileName).toBe("payslip_2026-10.pdf");
    expect((await validateUpload(db, asFile(pdf, "PAYSLIP.PDF"))).fileName).toBe("PAYSLIP.pdf");
    expect((await validateUpload(db, asFile(pdf, "payslip.html", "text/html"))).fileName).toBe("payslip.html.pdf");
    expect((await validateUpload(db, asFile(pdf, "payslip.", ""))).fileName).toBe("payslip.pdf");
  });

  it("accepts a PDF with bytes before its header, and stores it from the header on", async () => {
    for (const lead of ["﻿", "\r\n", "   \n", "x".repeat(900)]) {
      const v = await validateUpload(db, asFile(Buffer.concat([Buffer.from(lead, "utf8"), pdf]), "payslip.pdf"));
      expect(v.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(v.buffer.length).toBe(pdf.length);
      await PDFDocument.load(new Uint8Array(v.buffer)); // still a readable PDF
    }
  });

  it("refuses anything that is not really a PDF, PNG or JPEG, whatever its name", async () => {
    for (const [body, name] of [
      ["<html><script>alert(1)</script></html>", "payslip.pdf"],
      ["MZ\x90\x00 not a document", "payslip.pdf"],
      ["PK\x03\x04 a zip file", "payslip.pdf"],
      ["just text", "payslip"],
      [`${"x".repeat(1100)}%PDF-1.7`, "payslip.pdf"], // header too far in to be a PDF
    ] as const) {
      await expect(validateUpload(db, asFile(body, name)), name).rejects.toThrow(/Only PDF, PNG and JPEG/);
    }
    await expect(validateUpload(db, asFile("", "empty.pdf"))).rejects.toThrow(/choose a file/i);
  });
});
