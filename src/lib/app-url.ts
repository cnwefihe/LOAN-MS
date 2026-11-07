/**
 * Absolute address for a redirect. Behind the reverse proxy the request's own URL holds the
 * container's internal address, so the public address in APP_BASE_URL comes first.
 */
export function appUrl(path: string, req: { url: string }): URL {
  return new URL(path, process.env.APP_BASE_URL || req.url);
}
