import { NextResponse } from "next/server";

// The custom server guards every request. This endpoint deliberately exposes
// only whether the current browser owns a valid authenticated session.
export async function GET(request: Request) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const auth = require("@/server/auth.cjs") as {
    getSessionFromRequest(req: Request): unknown;
  };
  return NextResponse.json({ authenticated: Boolean(auth.getSessionFromRequest(request)) }, {
    headers: { "Cache-Control": "no-store" },
  });
}
