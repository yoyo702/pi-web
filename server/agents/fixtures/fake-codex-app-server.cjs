"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

// A stand-in for `codex app-server --stdio` covering the catalog methods and
// a minimal chat runtime. Threads live in the JSON file FAKE_CODEX_STATE
// ({ threads: [...] }, each with an `archived` flag, and `writer: true` when
// another client holds it); every request is appended to FAKE_CODEX_LOG.
// FAKE_CODEX_INIT_ERROR makes `initialize` fail.
// Runtime: `turn/start` starts a turn that runs until `turn/interrupt`; a
// prompt containing "approve" also asks for an approval, and answering it
// ends the turn.

const fs = require("node:fs");
const readline = require("node:readline");

const statePath = process.env.FAKE_CODEX_STATE;
const logPath = process.env.FAKE_CODEX_LOG;
const load = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const fail = (id, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32600, message } })}\n`);
const notify = (method, params, id) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...(id == null ? {} : { id }), method, params })}\n`);
let activeTurn = null;
const publicThread = (thread) => { const result = { ...thread, turns: [] }; delete result.archived; return result; };

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params = {}, result } = JSON.parse(line);
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(method ? { method, params } : { response: id, result })}\n`);
  if (!method) {
    notify("serverRequest/resolved", { requestId: id });
    notify("turn/completed", { turn: { id: activeTurn, status: "completed", error: null } });
    activeTurn = null;
    return undefined;
  }
  const state = load();
  const thread = state.threads.find((item) => item.id === params.threadId);
  switch (method) {
    case "initialize": return process.env.FAKE_CODEX_INIT_ERROR ? fail(id, "bad config") : reply(id, {});
    case "test/crash": return process.exit(1);
    case "test/hang": return undefined;
    case "thread/list": {
      const matching = state.threads
        .filter((item) => item.archived === (params.archived === true))
        .filter((item) => !params.cwd || item.cwd === params.cwd)
        .filter((item) => !params.searchTerm || String(item.name || "").includes(params.searchTerm))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const start = Number(params.cursor || 0);
      const end = start + params.limit;
      return reply(id, { data: matching.slice(start, end).map(publicThread), nextCursor: end < matching.length ? String(end) : null });
    }
    case "thread/resume":
      if (!thread) return fail(id, `no rollout found for thread id ${params.threadId}`);
      if (thread.writer) return fail(id, `thread ${params.threadId} already has an active writer`);
      return reply(id, { thread: publicThread(thread) });
    case "turn/start": {
      activeTurn = `turn-${Date.now()}`;
      reply(id, { turn: { id: activeTurn } });
      notify("turn/started", { turn: { id: activeTurn } });
      if (params.input.some((part) => part.type === "text" && part.text.includes("approve"))) notify("item/commandExecution/requestApproval", { command: "npm test" }, 900);
      return undefined;
    }
    case "turn/interrupt":
      reply(id, {});
      notify("turn/completed", { turn: { id: params.turnId, status: "interrupted", error: null } });
      activeTurn = null;
      return undefined;
    case "thread/read": return thread ? reply(id, { thread: publicThread(thread) }) : fail(id, `thread not loaded: ${params.threadId}`);
    case "thread/name/set":
      if (!thread) return fail(id, `no rollout found for thread id ${params.threadId}`);
      thread.name = params.name; save(state); return reply(id, {});
    case "thread/archive":
    case "thread/unarchive": {
      const archive = method === "thread/archive";
      if (!thread || thread.archived === archive) return fail(id, `no ${archive ? "" : "archived "}rollout found for thread id ${params.threadId}`);
      thread.archived = archive;
      thread.path = archive ? thread.path.replace("/sessions/", "/archived_sessions/") : thread.path.replace("/archived_sessions/", "/sessions/");
      save(state); return reply(id, archive ? {} : { thread: publicThread(thread) });
    }
    case "thread/delete":
      if (!thread) return fail(id, `no rollout found for thread id ${params.threadId}`);
      state.threads = state.threads.filter((item) => item !== thread); save(state); return reply(id, {});
    default: return fail(id, `unknown method ${method}`);
  }
});
