/** Load .env.local / .env for CLI scripts, mirroring Next.js (real environment variables win). */
for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(f);
  } catch {
    // file absent: fine
  }
}
