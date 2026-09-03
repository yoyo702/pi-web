import { NextRequest, NextResponse } from "next/server";
import { discoverGitRepositories } from "@/lib/git-repositories";
import { validateGitCwd } from "@/lib/git-request";

export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const invalid = await validateGitCwd(cwd);
    if (invalid) return NextResponse.json({ error: invalid.error }, { status: invalid.status });

    return NextResponse.json({ repositories: await discoverGitRepositories(cwd) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
