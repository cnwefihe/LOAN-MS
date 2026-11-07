/**
 * Private document storage. Files never live under /public; they are served only through the
 * authorised /api/documents/[id] route. Every object is encrypted (AES-256-GCM) before it reaches
 * the storage backend, so the backend never holds plaintext.
 *
 * Backends (STORAGE_BACKEND):
 *   - "local" (default): encrypted files under STORAGE_DIR (./storage). Single server only.
 *   - "azure": Azure Blob Storage, private container. Authenticate with either
 *       AZURE_STORAGE_CONNECTION_STRING, or AZURE_STORAGE_ACCOUNT_URL + managed identity
 *       (DefaultAzureCredential; grant the app "Storage Blob Data Contributor" on the container).
 *     Container: AZURE_STORAGE_CONTAINER (default "loan-documents"). Recommended: enable
 *     blob versioning, soft delete and an immutability/legal-hold policy on the container.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { encryptBuffer, decryptBuffer } from "@/lib/security/crypto";

export interface DocumentStorage {
  readonly name: string;
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Lightweight connectivity check for the health endpoint. */
  ping(): Promise<void>;
  /** All object keys with last-modified time (used by the orphan sweep). */
  list(): Promise<{ key: string; modified: Date }[]>;
  /** Remove an object. Only the orphan sweep calls this; registered documents are never deleted. */
  remove(key: string): Promise<void>;
}

function assertKey(key: string) {
  if (!/^[a-z0-9/_-]+$/i.test(key) || key.includes("..")) throw new Error("Invalid storage key");
}

export class LocalEncryptedStorage implements DocumentStorage {
  readonly name = "local";
  constructor(private root: string) {}
  private resolve(key: string) {
    assertKey(key);
    return path.join(this.root, key);
  }
  async put(key: string, data: Buffer) {
    const file = this.resolve(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, encryptBuffer(data), { flag: "wx" }); // never overwrite: versions are new objects
  }
  async get(key: string) {
    return decryptBuffer(await fs.readFile(this.resolve(key)));
  }
  async ping() {
    await fs.mkdir(this.root, { recursive: true });
    await fs.access(this.root);
  }
  async list() {
    const out: { key: string; modified: Date }[] = [];
    const walk = async (dir: string) => {
      let entries: import("node:fs").Dirent[] = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push({ key: path.relative(this.root, full).split(path.sep).join("/"), modified: (await fs.stat(full)).mtime });
      }
    };
    await walk(this.root);
    return out;
  }
  async remove(key: string) {
    await fs.rm(this.resolve(key), { force: true });
  }
}

export class AzureBlobStorage implements DocumentStorage {
  readonly name = "azure";
  private container: Promise<import("@azure/storage-blob").ContainerClient> | null = null;

  constructor(private opts: { connectionString?: string; accountUrl?: string; containerName: string }) {}

  private client() {
    this.container ??= (async () => {
      const { BlobServiceClient } = await import("@azure/storage-blob");
      let service;
      if (this.opts.connectionString) service = BlobServiceClient.fromConnectionString(this.opts.connectionString);
      else if (this.opts.accountUrl) {
        const { DefaultAzureCredential } = await import("@azure/identity");
        service = new BlobServiceClient(this.opts.accountUrl, new DefaultAzureCredential());
      } else throw new Error("Azure storage requires AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT_URL");
      const c = service.getContainerClient(this.opts.containerName);
      await c.createIfNotExists(); // private by default: no public access level is set
      return c;
    })().catch((err) => {
      this.container = null;
      throw err;
    });
    return this.container;
  }

  async put(key: string, data: Buffer) {
    assertKey(key);
    const blob = (await this.client()).getBlockBlobClient(key);
    const body = encryptBuffer(data);
    // If-None-Match: * refuses to overwrite an existing object (documents are versioned as new keys).
    await blob.uploadData(body, { conditions: { ifNoneMatch: "*" }, blobHTTPHeaders: { blobContentType: "application/octet-stream" } });
  }

  async get(key: string) {
    assertKey(key);
    const blob = (await this.client()).getBlockBlobClient(key);
    return decryptBuffer(await blob.downloadToBuffer());
  }

  async ping() {
    await (await this.client()).getProperties();
  }

  async list() {
    const out: { key: string; modified: Date }[] = [];
    for await (const b of (await this.client()).listBlobsFlat()) out.push({ key: b.name, modified: b.properties.lastModified ?? new Date() });
    return out;
  }

  async remove(key: string) {
    assertKey(key);
    await (await this.client()).getBlockBlobClient(key).deleteIfExists();
  }
}

let instance: DocumentStorage | null = null;

export function createStorage(env: NodeJS.ProcessEnv = process.env): DocumentStorage {
  const backend = env.STORAGE_BACKEND ?? "local";
  if (backend === "local") return new LocalEncryptedStorage(env.STORAGE_DIR ?? path.join(process.cwd(), "storage"));
  if (backend === "azure") {
    return new AzureBlobStorage({
      connectionString: env.AZURE_STORAGE_CONNECTION_STRING,
      accountUrl: env.AZURE_STORAGE_ACCOUNT_URL,
      containerName: env.AZURE_STORAGE_CONTAINER ?? "loan-documents",
    });
  }
  throw new Error(`Unknown STORAGE_BACKEND "${backend}" (expected "local" or "azure").`);
}

export function storage(): DocumentStorage {
  instance ??= createStorage();
  return instance;
}
