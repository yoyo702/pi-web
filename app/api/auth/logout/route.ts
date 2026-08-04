import { NextResponse } from "next/server";

export async function POST(request: Request) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const auth = require("@/server/auth.cjs") as {
    revokeSessionFromRequest(req: Request): void;
    cookieValue(token: string, expiresAt: number, secure: boolean): string;
    clearCookie(secure: boolean): string;
  };
  auth.revokeSessionFromRequest(request);
  const response = NextResponse.json({ authenticated: false }, {
    headers: { "Cache-Control": "no-store" },
  });
  response.headers.set("Set-Cookie", auth.clearCookie(new URL(request.url).protocol === "https:"));
  return response;
}
