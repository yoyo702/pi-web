import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import {
  getBrowseStartDirectory,
  getParentDirectory,
  listDirectories,
  resolveDirectory,
} from "@/lib/directory-browser";
import { errorResponse } from "@/lib/http-error";

// GET /api/cwd/browse?path=...：列出文件系统中的可读子目录。
export async function GET(request: NextRequest) {
  try {
    const requested = request.nextUrl.searchParams.get("path")?.trim();
    const candidate = getBrowseStartDirectory(requested);

    let resolved: string;
    try {
      resolved = await resolveDirectory(candidate);
    } catch {
      return NextResponse.json({ error: "Directory does not exist" }, { status: 404 });
    }


    const directoryStat = await stat(resolved);
    if (!directoryStat.isDirectory()) {
      return NextResponse.json({ error: "Path is not a directory" }, { status: 400 });
    }

    const directories = await listDirectories(resolved, {
      hideHidden: request.nextUrl.searchParams.get("hideHidden") === "1",
    });

    return NextResponse.json({
      path: resolved,
      parentPath: getParentDirectory(resolved),
      directories,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
