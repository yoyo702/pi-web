import { NextResponse } from "next/server";

export async function POST(request: Request) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const auth = require("@/server/auth.cjs") as {
    configured(): boolean;
    isRateLimited(key: string): boolean;
    recordFailure(key: string): void;
    clearFailures(key: string): void;
    verifyPassword(password: unknown): boolean;
    createSession(): { token: string; expiresAt: number };
    cookieValue(token: string, expiresAt: number, secure: boolean): string;
  };
  if (!auth.configured()) {
    return NextResponse.json({ authenticated: true, passwordRequired: false }, {
      headers: { "Cache-Control": "no-store" },
    });
  }
  // The custom server handles /api/auth/login before Next; this fallback has
  // no socket access, so all attempts share one rate-limit bucket.
  const key = "local";
  if (auth.isRateLimited(key)) {
    return NextResponse.json({ error: "too many failed login attempts; try again later" }, { status: 429 });
  }

  let password: unknown;
  try {
    password = (await request.json() as { password?: unknown }).password;
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  if (!auth.verifyPassword(password)) {
    auth.recordFailure(key);
    return NextResponse.json({ error: "invalid password" }, { status: 401 });
  }

  auth.clearFailures(key);
  const { token, expiresAt } = auth.createSession();
  const response = NextResponse.json({ authenticated: true, passwordRequired: true }, {
    headers: { "Cache-Control": "no-store" },
  });
  const secure = new URL(request.url).protocol === "https:";
  response.headers.set("Set-Cookie", auth.cookieValue(token, expiresAt, secure));
  return response;
}
