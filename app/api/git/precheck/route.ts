import { NextRequest, NextResponse } from "next/server";
import { getGitPrecheck } from "@/lib/git-precheck";
import { validateGitCwd } from "@/lib/git-request";
import { errorResponse } from "@/lib/http-error";

export const dynamic = "force-dynamic";

/** Local hints about the staged changes (conflict markers, debug code, secrets…). */
export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const invalid = await validateGitCwd(cwd);
    if (invalid) return NextResponse.json({ error: invalid.error }, { status: invalid.status });
    return NextResponse.json(await getGitPrecheck(cwd), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
