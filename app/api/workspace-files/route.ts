import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { HttpError, errorResponse } from "@/lib/http-error";

export const dynamic = "force-dynamic";

type Action = "create-file" | "create-folder" | "rename" | "delete" | "copy" | "move";

class RequestError extends HttpError {
  constructor(message: string, status = 400) { super(status, message); }
}

function isWithin(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function relativePath(value: unknown, allowRoot = false) {
  if (typeof value !== "string") throw new RequestError("path required");
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized && allowRoot) return "";
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new RequestError("Invalid path");
  if (normalized.split("/").includes(".git")) throw new RequestError("Git metadata cannot be changed here");
  return normalized;
}

function entryName(value: unknown) {
  if (typeof value !== "string") throw new RequestError("name required");
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[\\/]/.test(name) || name === ".git") throw new RequestError("Invalid name");
  return name;
}

function nestedEntryName(value: unknown) {
  return relativePath(value);
}

function workspacePath(cwd: string, relative: string, allowedRoots: Set<string>) {
  const target = path.resolve(cwd, relative);
  if (!isWithin(cwd, target) || !isFilePathAllowed(target, allowedRoots)) throw new RequestError("Access denied", 403);
  return target;
}

function requireRealParentInsideWorkspace(cwd: string, target: string) {
  const realRoot = fs.realpathSync(cwd);
  const realParent = fs.realpathSync(path.dirname(target));
  if (!isWithin(realRoot, realParent)) throw new RequestError("Symlink escapes the workspace", 403);
}

function invalidateFileIndex(cwd: string) {
  const shared = globalThis as typeof globalThis & { __piFileIndexCache?: Map<string, unknown> };
  shared.__piFileIndexCache?.delete(cwd);
}

/** Map filesystem error codes to user-facing statuses before the shared handler. */
function workspaceErrorResponse(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = String(error.code);
    if (code === "EEXIST") return NextResponse.json({ error: "A file with that name already exists" }, { status: 409 });
    if (code === "ENOENT") return NextResponse.json({ error: "File not found" }, { status: 404 });
    if (code === "ENOTEMPTY") return NextResponse.json({ error: "Folder is not empty" }, { status: 409 });
  }
  return errorResponse(error);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { action?: Action; cwd?: string; path?: string; name?: string; destination?: string };
    if (!body.action || !["create-file", "create-folder", "rename", "delete", "copy", "move"].includes(body.action)) throw new RequestError("Invalid action");
    if (!body.cwd?.trim()) throw new RequestError("cwd required");
    const cwd = path.resolve(body.cwd);
    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots)) throw new RequestError("Access denied", 403);
    if (!fs.statSync(cwd).isDirectory()) throw new RequestError("Workspace not found", 404);

    if (body.action === "create-file" || body.action === "create-folder") {
      const parent = relativePath(body.path, true);
      const nestedName = nestedEntryName(body.name);
      const target = workspacePath(cwd, parent ? `${parent}/${nestedName}` : nestedName, allowedRoots);
      const targetParent = path.dirname(target);
      const existingAncestor = (() => { let current = targetParent; while (!fs.existsSync(current) && current !== cwd) current = path.dirname(current); return current; })();
      if (!isWithin(fs.realpathSync(cwd), fs.realpathSync(existingAncestor))) throw new RequestError("Symlink escapes the workspace", 403);
      fs.mkdirSync(targetParent, { recursive: true });
      if (body.action === "create-file") fs.writeFileSync(target, "", { flag: "wx" });
      else fs.mkdirSync(target);
      invalidateFileIndex(cwd);
      return NextResponse.json({ path: path.relative(cwd, target).replace(/\\/g, "/") });
    }

    const sourceRelative = relativePath(body.path);
    const source = workspacePath(cwd, sourceRelative, allowedRoots);
    requireRealParentInsideWorkspace(cwd, source);
    const stat = fs.lstatSync(source);
    if (body.action === "copy" || body.action === "move") {
      const destinationRelative = relativePath(body.destination, true);
      const destinationDir = workspacePath(cwd, destinationRelative, allowedRoots);
      if (!fs.statSync(destinationDir).isDirectory()) throw new RequestError("Destination is not a folder");
      const target = workspacePath(cwd, path.posix.join(destinationRelative, path.basename(sourceRelative)), allowedRoots);
      requireRealParentInsideWorkspace(cwd, target);
      if (stat.isDirectory() && isWithin(source, target)) throw new RequestError("A folder cannot be placed inside itself");
      if (body.action === "copy") fs.cpSync(source, target, { recursive: stat.isDirectory(), errorOnExist: true, force: false, dereference: false });
      else fs.renameSync(source, target);
      invalidateFileIndex(cwd);
      return NextResponse.json({ path: path.relative(cwd, target).replace(/\\/g, "/") });
    }
    if (body.action === "rename") {
      const target = workspacePath(cwd, path.posix.join(path.posix.dirname(sourceRelative), entryName(body.name)), allowedRoots);
      requireRealParentInsideWorkspace(cwd, target);
      fs.renameSync(source, target);
      invalidateFileIndex(cwd);
      return NextResponse.json({ path: path.relative(cwd, target).replace(/\\/g, "/") });
    }
    fs.rmSync(source, { recursive: stat.isDirectory() && !stat.isSymbolicLink() });
    invalidateFileIndex(cwd);
    return NextResponse.json({ path: sourceRelative });
  } catch (error) {
    return workspaceErrorResponse(error);
  }
}
