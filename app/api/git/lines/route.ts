import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { applyGitLineSelection } from "@/lib/git-changes";
import { validateGitCwd } from "@/lib/git-request";
import type { GitLineAction } from "@/lib/git-types";
import { errorResponse } from "@/lib/http-error";

const SCOPES = ["staged", "unstaged", "untracked"] as const;
const ACTIONS: GitLineAction[] = ["stage", "unstage", "discard"];
const MAX_LINE_IDS = 100_000;

/** Stages, unstages or discards the selected lines of one file's diff. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { cwd?: unknown; path?: unknown; scope?: unknown; action?: unknown; fingerprint?: unknown; lineIds?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const filePath = typeof body.path === "string" ? body.path.trim() : "";
    const invalid = await validateGitCwd(cwd);
    if (invalid) return NextResponse.json({ error: invalid.error }, { status: invalid.status });
    if (!filePath || (!filePath.startsWith("/") && !isWindowsAbsolutePath(filePath))) {
      return NextResponse.json({ error: "path must be an absolute path" }, { status: 400 });
    }
    const scope = SCOPES.find((value) => value === body.scope);
    const action = ACTIONS.find((value) => value === body.action);
    if (!scope || !action) return NextResponse.json({ error: "invalid scope or action" }, { status: 400 });
    if (typeof body.fingerprint !== "string" || !body.fingerprint) return NextResponse.json({ error: "fingerprint is required" }, { status: 400 });
    const lineIds = body.lineIds;
    if (!Array.isArray(lineIds) || lineIds.length === 0 || lineIds.length > MAX_LINE_IDS || !lineIds.every((id) => Number.isInteger(id) && id >= 0)) {
      return NextResponse.json({ error: "lineIds must be a non-empty list of line numbers" }, { status: 400 });
    }

    // Deleted files have no filesystem entry, so only the path is checked here.
    if (!isFilePathAllowed(filePath, await getAllowedFileRoots())) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    return NextResponse.json(await applyGitLineSelection(cwd, filePath, { scope, action, fingerprint: body.fingerprint, lineIds: lineIds as number[] }));
  } catch (error) {
    return errorResponse(error);
  }
}
