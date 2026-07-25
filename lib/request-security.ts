function canonicalOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function requestOrigins(request: Request): Set<string> {
  const origins = new Set<string>();
  const urlOrigin = canonicalOrigin(request.url);
  if (urlOrigin) origins.add(urlOrigin);

  const host = request.headers.get("host") ?? request.headers.get("x-forwarded-host");
  if (host) {
    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const requestProto = canonicalOrigin(request.url)?.split(":")[0];
    const proto = forwardedProto || requestProto || "http";
    const headerOrigin = canonicalOrigin(`${proto}://${host}`);
    if (headerOrigin) origins.add(headerOrigin);
  }

  return origins;
}

/** Reject browser cross-site API requests while preserving non-browser clients. */
export function isApiRequestOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (!origin) return true;

  const normalizedOrigin = canonicalOrigin(origin);
  return normalizedOrigin !== null && requestOrigins(request).has(normalizedOrigin);
}

export function shouldCheckApiRequestOrigin(request: Request): boolean {
  return request.headers.has("origin") || request.headers.has("sec-fetch-site");
}
