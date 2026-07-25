import { NextRequest, NextResponse } from "next/server";
import { validateGitCwd } from "@/lib/git-request";
import { unstageFiles } from "@/lib/git-changes";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { cwd?: string; paths?: string[] };
    const invalid = await validateGitCwd(body.cwd);
    if (invalid) return NextResponse.json({ error: invalid.error }, { status: invalid.status });
    if (!Array.isArray(body.paths) || body.paths.length === 0) {
      return NextResponse.json({ error: "paths is required" }, { status: 400 });
    }
    return NextResponse.json(await unstageFiles(body.cwd as string, body.paths));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
