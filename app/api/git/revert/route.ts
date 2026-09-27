import { NextRequest, NextResponse } from "next/server";
import { validateGitCwd } from "@/lib/git-request";
import { revertCommit } from "@/lib/git-changes";
import { errorResponse } from "@/lib/http-error";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { cwd?: string; hash?: string };
    const invalid = await validateGitCwd(body.cwd);
    if (invalid) return NextResponse.json({ error: invalid.error }, { status: invalid.status });
    if (!body.hash || typeof body.hash !== "string") {
      return NextResponse.json({ error: "hash is required" }, { status: 400 });
    }
    return NextResponse.json(await revertCommit(body.cwd as string, body.hash));
  } catch (error) {
    return errorResponse(error);
  }
}
