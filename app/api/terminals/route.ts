import { NextResponse } from "next/server";
import { clearEndedTerminals, createTerminal, getTerminalStats, listTerminals, TerminalRequestError, type TerminalLaunchMode, type TerminalPermissionMode, type TerminalProvider } from "@/lib/agents/terminal";

function failure(error: unknown) {
  if (error instanceof TerminalRequestError) {
    const status = error.code === "not_found" ? 404
      : error.code === "not_running" ? 409
      : error.code === "terminal_limit" || error.code === "terminal_record_limit" ? 429
      : error.code === "forbidden_cwd" ? 403
      : error.code === "cli_missing" || error.code === "runtime_unavailable" ? 503
      : 400;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  return NextResponse.json({ error: "terminal request failed" }, { status: 500 });
}

export async function GET(request: Request) {
  const cwd = new URL(request.url).searchParams.get("cwd") ?? undefined;
  try {
    return NextResponse.json({ terminals: listTerminals(cwd), stats: getTerminalStats(cwd) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { provider?: unknown; cwd?: unknown; cols?: unknown; rows?: unknown; permissionMode?: unknown; launchMode?: unknown; noAltScreen?: unknown; sourceSessionId?: unknown; model?: unknown; webSearch?: unknown; initialPrompt?: unknown; chatMode?: unknown };
    if (body.provider !== "shell" && body.provider !== "codex" && body.provider !== "claude") throw new TerminalRequestError("invalid_provider", "provider must be shell, codex, or claude");
    if (typeof body.cwd !== "string" || !body.cwd) throw new TerminalRequestError("invalid_cwd", "cwd is required");
    if (body.permissionMode !== undefined && !["confirm", "on-request", "never", "bypass"].includes(body.permissionMode as string)) {
      throw new TerminalRequestError("invalid_permission_mode", "permissionMode is invalid");
    }
    if (body.launchMode !== undefined && !["new", "resume-last", "resume", "fork"].includes(body.launchMode as string)) {
      throw new TerminalRequestError("invalid_launch_mode", "launchMode is invalid");
    }
    if (body.sourceSessionId !== undefined && typeof body.sourceSessionId !== "string") {
      throw new TerminalRequestError("invalid_session", "sourceSessionId must be a string");
    }
    if (body.model !== undefined && typeof body.model !== "string") throw new TerminalRequestError("invalid_model", "model must be a string");
    if (body.webSearch !== undefined && typeof body.webSearch !== "boolean") throw new TerminalRequestError("invalid_web_search", "webSearch must be a boolean");
    if (body.initialPrompt !== undefined && typeof body.initialPrompt !== "string") throw new TerminalRequestError("invalid_prompt", "initialPrompt must be a string");
    if (body.chatMode !== undefined && typeof body.chatMode !== "boolean") throw new TerminalRequestError("invalid_chat_mode", "chatMode must be a boolean");
    const terminal = await createTerminal({
      provider: body.provider as TerminalProvider,
      cwd: body.cwd,
      cols: typeof body.cols === "number" ? body.cols : undefined,
      rows: typeof body.rows === "number" ? body.rows : undefined,
      permissionMode: body.permissionMode as TerminalPermissionMode | undefined,
      launchMode: body.launchMode as TerminalLaunchMode | undefined,
      noAltScreen: typeof body.noAltScreen === "boolean" ? body.noAltScreen : undefined,
      sourceSessionId: body.sourceSessionId as string | undefined,
      model: body.model as string | undefined,
      webSearch: body.webSearch as boolean | undefined,
      initialPrompt: body.initialPrompt as string | undefined,
      chatMode: body.chatMode as boolean | undefined,
    });
    return NextResponse.json({ terminal }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const provider = params.get("provider");
    if (provider && provider !== "shell" && provider !== "codex" && provider !== "claude") throw new TerminalRequestError("invalid_provider", "provider must be shell, codex, or claude");
    return NextResponse.json({ removedIds: clearEndedTerminals({ cwd: params.get("cwd") ?? undefined, provider: provider as TerminalProvider | undefined }) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
