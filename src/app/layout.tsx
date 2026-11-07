import type { Metadata, Viewport } from "next";
import { getDb } from "@/db";
import { getBranding } from "@/server/branding";
import { shade } from "@/lib/colour";
import { PwaRegister } from "@/components/pwa-register";
import "./globals.css";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const b = await getBranding(await getDb());
  return {
    title: { default: b.systemName, template: b.systemName },
    description: `${b.institutionName} ${b.systemName}: staff loan applications, approvals, disbursement and repayment.`,
    applicationName: b.systemName,
    robots: { index: false, follow: false },
    appleWebApp: { capable: true, title: "Loan Management System", statusBarStyle: "default" },
  };
}

// White matches the top bar, including where the installed app draws the window buttons.
export const viewport: Viewport = { themeColor: "#ffffff", width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { primaryColour: c } = await getBranding(await getDb());
  // Brand colour is administrator-configurable; derive the interface shades from it.
  const theme = `:root{--color-navy:${c};--color-navy-800:${shade(c, 0.08)};--color-navy-700:${shade(c, 0.16)};--color-brand:${c};--color-brand-600:${shade(c, -0.2)};--color-brand-50:${shade(c, 0.93)};--color-brand-100:${shade(c, 0.85)};--color-brand-200:${shade(c, 0.7)};--color-brand-300:${shade(c, 0.5)}}`;
  return (
    <html lang="en-GB">
      <head>
        <style dangerouslySetInnerHTML={{ __html: theme }} />
      </head>
      <body className="min-h-screen bg-canvas text-ink">{children}<PwaRegister /></body>
    </html>
  );
}
