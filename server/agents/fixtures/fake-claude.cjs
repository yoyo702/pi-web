#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";
// A fake `claude --print --input-format stream-json` for Claude Chat tests. It
// replays the protocol recorded from Claude Code 2.1: stream events, one
// `assistant` record per content block, `can_use_tool` permission prompts,
// interrupts and a `result` per turn. Transcripts go to
// $CLAUDE_CONFIG_DIR/projects/<encoded cwd>/<session>.jsonl.
// The prompt picks the scenario: "write" asks for permission, "long" runs
// until interrupted, "crash" exits mid-turn, "switch" moves to a new session, "delegate" runs a sub-agent,
// "/context" and "/compact" run those commands; anything else answers at
// once, counting the prompt's images. `--fork-session` copies the `--resume`
// transcript (through `--resume-session-at`) to the `--session-id` one.
// `initialize` lists a few slash commands.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const flag = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const forking = argv.includes("--fork-session");
const sessionId = forking ? flag("--session-id") : flag("--resume") || flag("--session-id");
let model = flag("--model") || "claude-default";
let permissionMode = flag("--permission-mode") || "default";
const log = process.env.FAKE_CLAUDE_LOG;
const record = (entry) => { if (log) fs.appendFileSync(log, `${JSON.stringify(entry)}\n`); };
record({ argv });

const transcript = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
if (forking) {
  const source = path.join(path.dirname(transcript), `${flag("--resume")}.jsonl`);
  const at = flag("--resume-session-at");
  const kept = [];
  for (const line of fs.readFileSync(source, "utf8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    kept.push(JSON.stringify({ ...entry, sessionId }));
    if (at && entry.uuid === at) break;
  }
  // As Claude does, a fork point that is not a message in the chain fails.
  if (at && !kept.some((line) => JSON.parse(line).uuid === at)) { process.stderr.write(`No message found with message.uuid of: ${at}\n`); process.exit(1); }
  fs.writeFileSync(transcript, `${kept.join("\n")}\n`);
}
// Entries chain through `parentUuid`, as in Claude's transcripts.
let lastUuid = fs.existsSync(transcript) ? fs.readFileSync(transcript, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).uuid).filter(Boolean).pop() ?? null : null;
function persist(entry) {
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.appendFileSync(transcript, `${JSON.stringify({ parentUuid: lastUuid, ...entry, sessionId, cwd: process.cwd(), timestamp: new Date().toISOString() })}\n`);
  lastUuid = entry.uuid;
}
const out = (message) => process.stdout.write(`${JSON.stringify({ ...message, session_id: sessionId })}\n`);
let pendingPermission = null;
let running = null;

function assistantBlock(messageId, index, block) {
  const entry = { type: "assistant", uuid: crypto.randomUUID(), message: { id: messageId, role: "assistant", model, content: [block] } };
  out({ type: "stream_event", event: { type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : block } });
  if (block.type === "text") for (const part of block.text.match(/.{1,6}/g) ?? []) out({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "text_delta", text: part } } });
  out({ ...entry, parent_tool_use_id: null });
  persist({ ...entry, apiBlockIndex: index });
  out({ type: "stream_event", event: { type: "content_block_stop", index } });
}
function toolResult(toolUseId, content, isError = false) {
  const entry = { type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] } };
  out({ ...entry, parent_tool_use_id: null });
  persist(entry);
}
function finish(extra = {}) {
  running = null;
  out({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: "done", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, ...extra });
}
const COMMANDS = [
  { name: "superpowers:brainstorming", description: "(superpowers) Explore an idea first", argumentHint: "", aliases: ["brainstorming"] },
  { name: "__internal", description: "hidden", argumentHint: "" },
  { name: "clear", description: "Clear conversation history", argumentHint: "", aliases: ["reset", "new"] },
  { name: "compact", description: "Clear conversation history but keep a summary", argumentHint: "<optional custom summarization instructions>" },
  { name: "context", description: "Show current context usage", argumentHint: "" },
  { name: "doctor", description: "Diagnose the installation", argumentHint: "" },
  { name: "context", description: "A project command of the same name", argumentHint: "" },
];
// A sub-agent: Claude's output tags its messages with the Agent tool call;
// its transcript goes to <session>/subagents/agent-<id>.jsonl.
function delegate() {
  const toolUseId = `toolu_${crypto.randomUUID().slice(0, 8)}`;
  assistantBlock(message(), 0, { type: "tool_use", id: toolUseId, name: "Agent", input: { description: "List files", subagent_type: "general-purpose", prompt: "List the files" } });
  const agentId = `a${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const directory = path.join(path.dirname(transcript), sessionId, "subagents");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", description: "List files", toolUseId }));
  let parentUuid = null;
  const sub = (entry, saved = entry) => {
    out({ ...entry, parent_tool_use_id: toolUseId });
    fs.appendFileSync(path.join(directory, `agent-${agentId}.jsonl`), `${JSON.stringify({ parentUuid, isSidechain: true, agentId, ...saved, sessionId })}\n`);
    parentUuid = entry.uuid;
  };
  out({ type: "system", subtype: "task_started", task_id: agentId, tool_use_id: toolUseId, description: "List files", subagent_type: "general-purpose" });
  const prompt = { type: "user", uuid: crypto.randomUUID() };
  sub({ ...prompt, message: { role: "user", content: [{ type: "text", text: "List the files" }] } }, { ...prompt, message: { role: "user", content: "List the files" } });
  const bash = `toolu_${crypto.randomUUID().slice(0, 8)}`;
  out({ type: "stream_event", parent_tool_use_id: toolUseId, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  sub({ type: "assistant", uuid: crypto.randomUUID(), message: { id: "msg_sub", role: "assistant", model, content: [{ type: "tool_use", id: bash, name: "Bash", input: { command: "ls" } }] } });
  out({ type: "system", subtype: "task_progress", task_id: agentId, tool_use_id: toolUseId, description: "Running ls", last_tool_name: "Bash", usage: { total_tokens: 100, tool_uses: 1, duration_ms: 5 } });
  sub({ type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: bash, content: "a.txt", is_error: false }] } });
  sub({ type: "assistant", uuid: crypto.randomUUID(), message: { id: "msg_sub2", role: "assistant", model, content: [{ type: "text", text: "Found a.txt" }] } });
  out({ type: "system", subtype: "task_notification", task_id: agentId, tool_use_id: toolUseId, status: "completed", summary: "Found a.txt", usage: { total_tokens: 120, tool_uses: 1, duration_ms: 9 } });
  toolResult(toolUseId, [{ type: "text", text: "Found a.txt" }]);
  assistantBlock(message(), 0, { type: "text", text: "The agent found a.txt." });
  finish();
}
// Local commands: Claude sends their output as a synthetic assistant message
// and saves it as a `system` record with the same uuid.
function localCommand(text) {
  if (text.startsWith("/context")) {
    const uuid = crypto.randomUUID();
    out({ type: "assistant", uuid, parent_tool_use_id: null, message: { id: crypto.randomUUID(), role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "## Context Usage" }] } });
    persist({ type: "system", subtype: "local_command", uuid, content: "<local-command-stdout>## Context Usage</local-command-stdout>" });
    finish({ result: "## Context Usage" });
    return;
  }
  out({ type: "system", subtype: "status", status: "compacting" });
  const boundary = crypto.randomUUID();
  out({ type: "system", subtype: "compact_boundary", uuid: boundary, compact_metadata: { trigger: "manual" } });
  persist({ type: "system", subtype: "compact_boundary", uuid: boundary, content: "Conversation compacted" });
  const summary = { type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: "This session is being continued…" } };
  out({ ...summary, parent_tool_use_id: null, isSynthetic: true });
  persist({ ...summary, isCompactSummary: true });
  const done = { type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" } };
  out({ ...done, parent_tool_use_id: null, isReplay: true });
  persist(done);
  out({ type: "system", subtype: "status", status: null, compact_result: "success" });
  finish({ result: "" });
}
function message() { const id = `msg_${crypto.randomUUID().slice(0, 8)}`; out({ type: "stream_event", event: { type: "message_start", message: { id } } }); return id; }

function turn(text) {
  running = { text };
  // As `/clear` does: Claude carries on in a new session.
  if (text.includes("switch")) { process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", model, permissionMode, cwd: process.cwd(), session_id: crypto.randomUUID() })}\n`); return; }
  out({ type: "system", subtype: "init", model, permissionMode, cwd: process.cwd(), terminal_slash_commands: ["doctor"] });
  if (/^\/(context|compact)\b/.test(text)) { localCommand(text); return; }
  if (text.includes("delegate")) { delegate(); return; }
  if (text.includes("crash")) { process.stderr.write(`boom in ${process.cwd()}\n`); process.exit(1); }
  if (text.includes("long")) { message(); return; }
  if (text.includes("write")) {
    const id = message();
    const toolUseId = `toolu_${crypto.randomUUID().slice(0, 8)}`;
    const input = { file_path: path.join(process.cwd(), "a.txt"), content: "hi" };
    assistantBlock(id, 0, { type: "tool_use", id: toolUseId, name: "Write", input });
    if (permissionMode === "acceptEdits" || permissionMode === "bypassPermissions") { toolResult(toolUseId, "File created successfully"); assistantBlock(message(), 0, { type: "text", text: "Wrote it." }); finish(); return; }
    pendingPermission = { requestId: crypto.randomUUID(), toolUseId };
    out({ type: "control_request", request_id: pendingPermission.requestId, request: { subtype: "can_use_tool", tool_name: "Write", display_name: "Write", input, description: "a.txt", permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }], tool_use_id: toolUseId } });
    return;
  }
  assistantBlock(message(), 0, { type: "text", text: `Echo: ${text}` });
  finish();
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const input = JSON.parse(line);
    record({ stdin: input });
    if (input.type === "user") {
      persist({ type: "user", uuid: input.uuid || crypto.randomUUID(), message: input.message });
      const content = input.message.content;
      const images = Array.isArray(content) ? content.filter((block) => block.type === "image" && block.source?.type === "base64").length : 0;
      const text = typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      turn(images ? `${text} [${images} image${images === 1 ? "" : "s"}]` : text);
    } else if (input.type === "control_request") {
      const subtype = input.request?.subtype;
      if (subtype === "interrupt") {
        out({ type: "control_response", response: { subtype: "success", request_id: input.request_id, response: { still_queued: [] } } });
        if (pendingPermission) { out({ type: "control_cancel_request", request_id: pendingPermission.requestId }); pendingPermission = null; }
        if (running) {
          const entry = { type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } };
          out({ ...entry, parent_tool_use_id: null });
          persist(entry);
          finish({ stop_reason: null });
        }
      } else if (subtype === "initialize") out({ type: "control_response", response: { subtype: "success", request_id: input.request_id, response: { commands: COMMANDS, models: [], agents: [] } } });
      else if (subtype === "set_model") { model = input.request.model; out({ type: "control_response", response: { subtype: "success", request_id: input.request_id } }); }
      else out({ type: "control_response", response: { subtype: "error", request_id: input.request_id, error: `unsupported ${subtype}` } });
    } else if (input.type === "control_response" && pendingPermission && input.response?.request_id === pendingPermission.requestId) {
      const { toolUseId } = pendingPermission;
      pendingPermission = null;
      const answer = input.response.response;
      if (answer.behavior === "allow") {
        const mode = answer.updatedPermissions?.find((rule) => rule.type === "setMode")?.mode;
        if (mode) { permissionMode = mode; out({ type: "system", subtype: "status", status: null, permissionMode }); }
        toolResult(toolUseId, "File created successfully");
        assistantBlock(message(), 0, { type: "text", text: "Wrote it." });
      } else {
        toolResult(toolUseId, answer.message || "denied", true);
      }
      finish();
    }
  }
});
process.stdin.on("end", () => process.exit(0));
