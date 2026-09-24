import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { commitChanges, getGitCommitDetail, getGitCommitFileDiff } from "@/lib/git-changes";
import { validateGitCwd } from "@/lib/git-request";
import { errorResponse } from "@/lib/http-error";

export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const hash = request.nextUrl.searchParams.get("hash")?.trim() ?? "";
    if (!hash) {
      return NextResponse.json({ error: "hash is required" }, { status: 400 });
    }

    // With `path`, return the diff for that single file within the commit.
    const filePath = request.nextUrl.searchParams.get("path")?.trim();
    if (filePath) {
      return NextResponse.json(await getGitCommitFileDiff(cwd, hash, filePath));
    }

    const detail = await getGitCommitDetail(cwd, hash);
    if (!detail) {
      return NextResponse.json({ error: "Commit not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { cwd?: string; message?: string; amend?: boolean };
    const invalid = await validateGitCwd(body.cwd);
    if (invalid) return NextResponse.json({ error: invalid.error }, { status: invalid.status });
    if (!body.message || !body.message.trim()) {
      return NextResponse.json({ error: "Commit message is required" }, { status: 400 });
    }
    return NextResponse.json(await commitChanges(body.cwd as string, body.message, { amend: body.amend === true }));
  } catch (error) {
    return errorResponse(error);
  }
}
