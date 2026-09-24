import type { TerminalSession } from "./terminal";

// Set by server/pi-web-server.js; kept off process.env so agent shells cannot read it.
function internalToken(): string | undefined {
  return (globalThis as { __piWebInternalTerminalToken?: string }).__piWebInternalTerminalToken;
}

function bridgeUrl(path: string): string {
  const port = process.env.PI_WEB_INTERNAL_PORT;
  if (!port || !internalToken()) throw new Error("TianForge pi terminal bridge is unavailable outside the TianForge pi server");
  return `http://127.0.0.1:${port}${path}`;
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(bridgeUrl(path), {
    ...init,
    headers: { "X-Pi-Web-Internal": internalToken()!, ...(init.headers ?? {}) },
    cache: "no-store",
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `terminal bridge returned ${response.status}`);
  }
  return response;
}

export async function bridgeListTerminals(cwd: string): Promise<TerminalSession[]> {
  const response = await request(`/api/terminals?${new URLSearchParams({ cwd })}`);
  return (await response.json() as { terminals: TerminalSession[] }).terminals;
}
export async function bridgeTerminal(id: string): Promise<TerminalSession> {
  const response = await request(`/api/terminals/${encodeURIComponent(id)}`);
  return (await response.json() as { terminal: TerminalSession }).terminal;
}
export async function bridgeBuffer(id: string): Promise<{ data: Uint8Array; truncated: boolean; state: string }> {
  const response = await request(`/api/terminals/${encodeURIComponent(id)}/buffer`);
  return { data: new Uint8Array(await response.arrayBuffer()), truncated: response.headers.get("X-Pi-Terminal-Truncated") === "1", state: response.headers.get("X-Pi-Terminal-State") ?? "unknown" };
}
export async function bridgeSend(id: string, data: string): Promise<void> {
  await request(`/api/terminals/${encodeURIComponent(id)}/input`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) });
}
export async function bridgeStop(id: string): Promise<TerminalSession> {
  const response = await request(`/api/terminals/${encodeURIComponent(id)}/stop`, { method: "POST" });
  return (await response.json() as { terminal: TerminalSession }).terminal;
}
