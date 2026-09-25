"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

// A stand-in for `codex app-server --stdio` covering the catalog methods and
// a minimal chat runtime. Threads live in the JSON file FAKE_CODEX_STATE
// ({ threads: [...] }, each with an `archived` flag, and `writer: true` when
// another client holds it); every request is appended to FAKE_CODEX_LOG.
// FAKE_CODEX_INIT_ERROR makes `initialize` fail.
// Runtime: `thread/start` adds a thread to the state file (reading its turns fails until its first `turn/start`, as in Codex); `turn/start` starts a turn that runs until `turn/interrupt`; a
// prompt containing "approve" also asks for an approval, "question" asks the
// user a question, and answering either ends the turn. "tool call" sends an
// `item/tool/call` request (which pi-web refuses). `turn/steer` checks
// `expectedTurnId`, and refuses a turn whose prompt contains "review".
// `thread/fork` copies a thread under a new id, keeping its `turns` through
// `lastTurnId`; `thread/read` with `includeTurns` returns a thread's `turns`.

const fs = require("node:fs");
const readline = require("node:readline");

const statePath = process.env.FAKE_CODEX_STATE;
const logPath = process.env.FAKE_CODEX_LOG;
const load = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const fail = (id, message, data) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32600, message, ...(data ? { data } : {}) } })}\n`);
const notify = (method, params, id) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...(id == null ? {} : { id }), method, params })}\n`);
let activeTurn = null;
let reviewTurn = false;
const publicThread = (thread, withTurns = false) => { const result = { ...thread, turns: withTurns ? thread.turns ?? [] : [] }; delete result.archived; delete result.unmaterialized; return result; };

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params = {}, result, error } = JSON.parse(line);
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(method ? { method, params } : { response: id, result, error })}\n`);
  if (!method && id === 901) return undefined;
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
    case "thread/start": {
      const created = { id: require("node:crypto").randomUUID(), cwd: params.cwd, name: null, preview: "", updatedAt: Math.floor(Date.now() / 1000), archived: false, unmaterialized: true, path: `/fake/sessions/${Date.now()}.jsonl` };
      state.threads.push(created); save(state);
      return reply(id, { thread: publicThread(created) });
    }
    case "thread/resume":
      if (!thread) return fail(id, `no rollout found for thread id ${params.threadId}`);
      if (thread.writer) return fail(id, `thread ${params.threadId} already has an active writer`);
      return reply(id, { thread: publicThread(thread) });
    case "turn/start": {
      if (thread?.unmaterialized) { delete thread.unmaterialized; save(state); }
      activeTurn = `turn-${Date.now()}`;
      reply(id, { turn: { id: activeTurn } });
      notify("turn/started", { turn: { id: activeTurn } });
      const text = params.input.filter((part) => part.type === "text").map((part) => part.text).join(" ");
      reviewTurn = text.includes("review");
      if (text.includes("approve")) notify("item/commandExecution/requestApproval", { command: "npm test", proposedExecpolicyAmendment: ["npm", "test"] }, 900);
      if (text.includes("tool call")) notify("item/tool/call", { tool: "lookup" }, 901);
      if (text.includes("question")) notify("item/tool/requestUserInput", { questions: [{ id: "color", header: "Color", question: "Pick one", isOther: true, isSecret: false, options: [{ label: "Red", description: "" }] }] }, 902);
      return undefined;
    }
    case "turn/steer":
      if (!activeTurn) return fail(id, "no active turn");
      if (reviewTurn) return fail(id, "cannot add input to this turn", { codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } } });
      if (params.expectedTurnId !== activeTurn) return fail(id, `expected active turn id \`${params.expectedTurnId}\` but found \`${activeTurn}\``);
      return reply(id, { turnId: activeTurn });
    case "turn/interrupt":
      reply(id, {});
      notify("turn/completed", { turn: { id: params.turnId, status: "interrupted", error: null } });
      activeTurn = null;
      return undefined;
    case "thread/read":
      if (thread?.unmaterialized && params.includeTurns) return fail(id, `thread ${thread.id} is not materialized yet; includeTurns is unavailable before first user message`);
      return thread ? reply(id, { thread: publicThread(thread, params.includeTurns) }) : fail(id, `thread not loaded: ${params.threadId}`);
    case "thread/fork": {
      if (!thread) return fail(id, `no rollout found for thread id ${params.threadId}`);
      const turns = thread.turns ?? [];
      const end = params.lastTurnId ? turns.findIndex((turn) => turn.id === params.lastTurnId) : turns.length - 1;
      if (params.lastTurnId && end < 0) return fail(id, `turn not found: ${params.lastTurnId}`);
      const forked = { ...thread, id: require("node:crypto").randomUUID(), name: null, writer: false, updatedAt: Math.floor(Date.now() / 1000), turns: turns.slice(0, end + 1), path: `/fake/sessions/fork-${Date.now()}.jsonl` };
      state.threads.push(forked); save(state);
      return reply(id, { thread: publicThread(forked, !params.excludeTurns) });
    }
    case "thread/unsubscribe": return reply(id, { status: "unsubscribed" });
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
