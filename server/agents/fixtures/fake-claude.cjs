#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";
// A fake `claude --print --input-format stream-json` for Claude Chat tests. It
// replays the protocol recorded from Claude Code 2.1: stream events, one
// `assistant` record per content block, `can_use_tool` permission prompts,
// interrupts and a `result` per turn. Transcripts go to
// $CLAUDE_CONFIG_DIR/projects/<encoded cwd>/<session>.jsonl.
// The prompt picks the scenario: "write" asks for permission, "long" runs
// until interrupted, "crash" exits mid-turn; anything else answers at once.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const flag = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const sessionId = flag("--resume") || flag("--session-id");
let model = flag("--model") || "claude-default";
let permissionMode = flag("--permission-mode") || "default";
const log = process.env.FAKE_CLAUDE_LOG;
const record = (entry) => { if (log) fs.appendFileSync(log, `${JSON.stringify(entry)}\n`); };
record({ argv });

const transcript = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
function persist(entry) {
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.appendFileSync(transcript, `${JSON.stringify({ ...entry, sessionId, cwd: process.cwd(), timestamp: new Date().toISOString() })}\n`);
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
function message() { const id = `msg_${crypto.randomUUID().slice(0, 8)}`; out({ type: "stream_event", event: { type: "message_start", message: { id } } }); return id; }

function turn(text) {
  running = { text };
  out({ type: "system", subtype: "init", model, permissionMode, cwd: process.cwd() });
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
      turn(typeof input.message.content === "string" ? input.message.content : "");
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
      } else if (subtype === "set_model") { model = input.request.model; out({ type: "control_response", response: { subtype: "success", request_id: input.request_id } }); }
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
