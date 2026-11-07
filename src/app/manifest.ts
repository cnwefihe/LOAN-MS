import type { MetadataRoute } from "next";

/** Lets staff install the system as an app on a computer or phone. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Loan Management System",
    short_name: "Loan Management System",
    description: "Staff loan applications, approvals, disbursement and repayment.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#2E3A6E",
    icons: [
      { src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
