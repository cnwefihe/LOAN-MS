/**
 * Integration adapters tested against real local stand-ins:
 *  - Azure Blob storage adapter against Azurite (Microsoft's official storage emulator)
 *  - Payroll HTTP adapter against a local mock implementing the documented contract
 * These verify OUR side of each integration; they are not tests of PAU's real systems.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AzureBlobStorage, LocalEncryptedStorage } from "@/server/storage";
import { HttpPayrollProvider, parseDeductionCsv } from "@/server/integrations/payroll";

const AZURITE_PORT = 10099;
const AZURITE_CONN = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:${AZURITE_PORT}/devstoreaccount1;`;

describe("document storage adapters", () => {
  it("local adapter encrypts at rest, round-trips and refuses overwrite", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pau-store-"));
    const s = new LocalEncryptedStorage(dir);
    const data = Buffer.from("%PDF-1.4 confidential payslip");
    await s.put("2026/10/abc", data);
    expect((await s.get("2026/10/abc")).equals(data)).toBe(true);
    const raw = fs.readFileSync(path.join(dir, "2026/10/abc"));
    expect(raw.includes(Buffer.from("confidential"))).toBe(false);
    await expect(s.put("2026/10/abc", data)).rejects.toThrow();
    await expect(s.put("../escape", data)).rejects.toThrow(/Invalid storage key/);
    expect((await s.list()).map((o) => o.key)).toEqual(["2026/10/abc"]);
    await s.remove("2026/10/abc");
    expect(await s.list()).toEqual([]);
  });

  describe("Azure Blob adapter (Azurite)", () => {
    let azurite: ChildProcess;
    beforeAll(async () => {
      const main = path.join(process.cwd(), "node_modules", "azurite", "dist", "src", "blob", "main.js");
      azurite = spawn(process.execPath, [main, "--inMemoryPersistence", "--blobPort", String(AZURITE_PORT), "--blobHost", "127.0.0.1", "--skipApiVersionCheck", "--silent", "--loose"], { stdio: "ignore" });
      for (let i = 0; i < 50; i++) {
        try { await fetch(`http://127.0.0.1:${AZURITE_PORT}/`); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
      }
    });
    afterAll(() => { azurite?.kill(); });

    it("creates a private container, round-trips encrypted blobs and refuses overwrite", async () => {
      const s = new AzureBlobStorage({ connectionString: AZURITE_CONN, containerName: "loan-documents-test" });
      await s.ping();
      const data = Buffer.from("%PDF-1.4 guarantor agreement");
      await s.put("2026/10/blob1", data);
      expect((await s.get("2026/10/blob1")).equals(data)).toBe(true);
      await expect(s.put("2026/10/blob1", data)).rejects.toThrow();

      const { BlobServiceClient } = await import("@azure/storage-blob");
      const c = BlobServiceClient.fromConnectionString(AZURITE_CONN).getContainerClient("loan-documents-test");
      const raw = await c.getBlockBlobClient("2026/10/blob1").downloadToBuffer();
      expect(raw.includes(Buffer.from("guarantor"))).toBe(false); // ciphertext only
      const props = await c.getAccessPolicy();
      expect(props.blobPublicAccess).toBeUndefined(); // private container
      expect((await s.list()).map((o) => o.key)).toContain("2026/10/blob1");
      await s.remove("2026/10/blob1");
      expect((await s.list()).map((o) => o.key)).not.toContain("2026/10/blob1");
    });
  });
});

describe("payroll HTTP adapter (mock server)", () => {
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.headers.authorization !== "Bearer test-key") { res.writeHead(401).end(); return; }
      const url = new URL(req.url!, "http://x");
      if (url.pathname === "/deductions" && url.searchParams.get("month") === "2026-10") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([
          { staffNumber: "DEV-1001", amount: "87500", reference: "PR-2026-10-1001", valueDate: "2026-10-25" },
          { staff_number: "DEV-1002", amount: "1,000.50", reference: "PR-2026-10-1002" },
        ]));
      } else if (url.pathname === "/staff/DEV-1001/salary") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ monthlyBasic: "300000", monthlyGross: "450000", monthlyNet: "380000", asOf: "2026-10-01" }));
      } else if (url.pathname === "/deductions") {
        res.writeHead(500).end();
      } else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); });

  it("maps deductions and salary from the documented contract", async () => {
    const p = new HttpPayrollProvider(base, "test-key", "LOAN");
    const rows = await p.fetchDeductions("2026-10");
    expect(rows).toEqual([
      { staffNumber: "DEV-1001", amount: "87500.00", reference: "PR-2026-10-1001", valueDate: "2026-10-25" },
      { staffNumber: "DEV-1002", amount: "1000.50", reference: "PR-2026-10-1002", valueDate: "2026-10-25" },
    ]);
    expect(await p.fetchSalary("DEV-1001")).toMatchObject({ monthlyNet: "380000.00", asOf: "2026-10-01" });
    expect(await p.fetchSalary("UNKNOWN")).toBeNull();
  });

  it("surfaces auth and server errors as safe messages", async () => {
    await expect(new HttpPayrollProvider(base, "wrong").fetchDeductions("2026-10")).rejects.toThrow(/responded 401/);
    await expect(new HttpPayrollProvider(base, "test-key").fetchDeductions("2026-09")).rejects.toThrow(/responded 500/);
    await expect(new HttpPayrollProvider(base, "test-key").fetchDeductions("October")).rejects.toThrow(/YYYY-MM/);
  });

  it("parses the payroll CSV with per-row errors", () => {
    const { rows, errors } = parseDeductionCsv("﻿staff_number,amount,reference,value_date\nDEV-1,87500,R1,\nDEV-2,abc,R2,2026-10-25\n,100,R3,\n", "2026-10-25");
    expect(rows).toEqual([{ staffNumber: "DEV-1", amount: "87500.00", reference: "R1", valueDate: "2026-10-25" }]);
    expect(errors).toHaveLength(2);
    expect(() => parseDeductionCsv("name,amount\nx,1", "2026-10-25")).toThrow(/header must include/);
  });
});
