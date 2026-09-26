/**
 * Whether a response may mean the login session ended: a 401 from one of our
 * own API routes, other than the auth routes (a wrong password is also a 401).
 * Callers confirm with GET /api/auth/session before telling the user.
 */
export function isPossibleAuthExpiry(requestUrl: string, status: number, origin: string): boolean {
  if (status !== 401) return false;
  let url: URL;
  try {
    url = new URL(requestUrl, origin);
  } catch {
    return false;
  }
  return url.origin === origin && url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/auth/");
}
