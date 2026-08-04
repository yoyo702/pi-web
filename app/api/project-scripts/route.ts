import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { resolveTerminalCwd, TerminalRequestError } from "@/lib/agents/terminal";

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

export async function GET(request: Request) {
  try {
    const requestedCwd = new URL(request.url).searchParams.get("cwd");
    if (!requestedCwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    const cwd = await resolveTerminalCwd(requestedCwd);
    const packagePath = join(cwd, "package.json");
    const packageStat = await stat(packagePath);
    if (!packageStat.isFile() || packageStat.size > MAX_PACKAGE_JSON_BYTES) {
      return NextResponse.json({ error: "package.json is unavailable or too large" }, { status: 400 });
    }
    const manifest = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: unknown; packageManager?: unknown };
    const scripts = manifest.scripts && typeof manifest.scripts === "object" && !Array.isArray(manifest.scripts)
      ? Object.entries(manifest.scripts).flatMap(([name, command]) => typeof command === "string" ? [{ name, command }] : []).sort((a, b) => a.name.localeCompare(b.name))
      : [];
    const packageManager = typeof manifest.packageManager === "string" ? manifest.packageManager.split("@")[0] : "npm";
    const runner = ["npm", "pnpm", "yarn", "bun"].includes(packageManager) ? packageManager : "npm";
    return NextResponse.json({ scripts, runner }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof TerminalRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.code === "forbidden_cwd" ? 403 : 400 });
    }
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return NextResponse.json({ scripts: [], runner: "npm" }, { headers: { "Cache-Control": "no-store" } });
    }
    if (error instanceof SyntaxError) return NextResponse.json({ error: "package.json contains invalid JSON" }, { status: 400 });
    return NextResponse.json({ error: "Unable to read project scripts" }, { status: 500 });
  }
}
