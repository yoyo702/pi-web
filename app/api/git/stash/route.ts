import { NextRequest, NextResponse } from "next/server";
import { changeGitStash, getGitStashes, type GitStashAction } from "@/lib/git-changes";
import { validateGitCwd } from "@/lib/git-request";

const STASH_ACTIONS = new Set<GitStashAction>(["save", "apply", "pop", "drop"]);

export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const invalid = await validateGitCwd(cwd);
    if (invalid) return NextResponse.json({ error: invalid.error }, { status: invalid.status });
    return NextResponse.json({ stashes: await getGitStashes(cwd) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as {
      cwd?: string;
      action?: GitStashAction;
      index?: number;
      message?: string;
    };
    const invalid = await validateGitCwd(body.cwd);
    if (invalid) return NextResponse.json({ error: invalid.error }, { status: invalid.status });
    if (!body.action || !STASH_ACTIONS.has(body.action)) {
      return NextResponse.json({ error: "action must be save, apply, pop, or drop" }, { status: 400 });
    }
    return NextResponse.json(await changeGitStash(body.cwd as string, body.action, {
      index: body.index,
      message: body.message,
    }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
