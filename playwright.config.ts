import { defineConfig, devices } from "@playwright/test";

/**
 * Browser end-to-end + accessibility tests. Runs its own dev server on :3100 (or E2E_PORT) against a throwaway
 * embedded database (.data/e2e) seeded with development fixtures, with email delivered to a local
 * double of Microsoft Graph, never against real data.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
export const GRAPH_PORT = 3199;

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // Local double of Microsoft identity + Graph sendMail, so email is tested end to end.
      command: `node tests/support/fake-graph.mjs ${GRAPH_PORT}`,
      url: `http://127.0.0.1:${GRAPH_PORT}/_stats`,
      reuseExistingServer: false,
    },
    {
      command: `npx tsx e2e/prepare.ts && npx next dev -p ${PORT}`,
      url: `http://localhost:${PORT}/login`,
      timeout: 240_000,
      reuseExistingServer: false,
      env: {
        PGLITE_DIR: ".data/e2e",
        STORAGE_DIR: ".data/e2e-storage",
        AUTH_DEV_LOGIN: "true",
        APP_BASE_URL: `http://localhost:${PORT}`,
        NEXT_DIST_DIR: ".next-e2e",
        EMAIL_TRANSPORT: "graph",
        EMAIL_SENDER_ADDRESS: "loans@example.edu.ng",
        EMAIL_GRAPH_TENANT_ID: "e2e-tenant",
        EMAIL_GRAPH_CLIENT_ID: "test-client",
        EMAIL_GRAPH_CLIENT_SECRET: "test-secret",
        GRAPH_BASE_URL: `http://127.0.0.1:${GRAPH_PORT}`,
        ENTRA_AUTHORITY_HOST: `http://127.0.0.1:${GRAPH_PORT}`,
      },
    },
  ],
});
