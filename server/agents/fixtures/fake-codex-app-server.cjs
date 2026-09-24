"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

// A stand-in for `codex app-server --stdio` covering the catalog methods.
// Threads live in the JSON file FAKE_CODEX_STATE ({ threads: [...] }, each
// with an `archived` flag); every request is appended to FAKE_CODEX_LOG.
// FAKE_CODEX_INIT_ERROR makes `initialize` fail.

const fs = require("node:fs");
const readline = require("node:readline");

const statePath = process.env.FAKE_CODEX_STATE;
const logPath = process.env.FAKE_CODEX_LOG;
const load = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const fail = (id, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32600, message } })}\n`);
const publicThread = (thread) => { const result = { ...thread, turns: [] }; delete result.archived; return result; };

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify({ method, params })}\n`);
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
