/** Redirects must use the public address, not the container's internal one. */
import { afterEach, describe, expect, it } from "vitest";
import { appUrl } from "@/lib/app-url";

const internal = { url: "https://0.0.0.0:3000/api/auth/callback?code=x" };

describe("appUrl", () => {
  const saved = process.env.APP_BASE_URL;
  afterEach(() => { process.env.APP_BASE_URL = saved; });

  it("uses the public address behind the reverse proxy", () => {
    process.env.APP_BASE_URL = "https://loans.example.edu.ng";
    expect(appUrl("/login?error=sso_failed", internal).href).toBe("https://loans.example.edu.ng/login?error=sso_failed");
  });

  it("copes with a slash at the end of the address", () => {
    process.env.APP_BASE_URL = "https://loans.example.edu.ng/";
    expect(appUrl("/home", internal).href).toBe("https://loans.example.edu.ng/home");
  });

  it("falls back to the request address in development", () => {
    delete process.env.APP_BASE_URL;
    expect(appUrl("/home", { url: "http://localhost:3000/x" }).href).toBe("http://localhost:3000/home");
  });
});
