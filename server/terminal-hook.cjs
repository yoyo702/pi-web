#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Run by the Claude Code hooks that terminal-manager.cjs adds to a Claude
 * terminal: `terminal-hook.cjs working|waiting|approval|idle`. Posts the state,
 * with Claude's last reply or notice as detail, to the TianForge server that
 * started the terminal. Always exits 0 and prints nothing, so a server that is
 * gone never disturbs Claude.
 */
const http = require("node:http");
const https = require("node:https");

const activity = process.argv[2];
const url = process.env.PI_WEB_TERMINAL_HOOK_URL;
const token = process.env.PI_WEB_TERMINAL_HOOK_TOKEN;

function readInput() {
  return new Promise((resolve) => {
    let input = "";
    const done = () => resolve(input);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { if (input.length < 256 * 1024) input += chunk; });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
    setTimeout(done, 1000).unref();
  });
}

function detailOf(input) {
  try {
    const event = JSON.parse(input);
    const text = activity === "waiting" ? event.last_assistant_message : activity === "approval" ? event.message : "";
    return typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  } catch {
    return "";
  }
}

function post(body) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const data = JSON.stringify(body);
    // The server's certificate names its public host, not the loopback
    // address used here; the token is what authenticates this request.
    const request = (target.protocol === "https:" ? https : http).request(target, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }, rejectUnauthorized: false, timeout: 3000 }, (response) => { response.resume(); response.on("end", resolve); });
    request.on("timeout", () => request.destroy());
    request.on("error", resolve);
    request.end(data);
  });
}

async function main() {
  const input = await readInput();
  if (!url || !token || !["working", "waiting", "approval", "idle"].includes(activity)) return;
  await post({ token, activity, detail: detailOf(input) });
}

main().catch(() => undefined).finally(() => process.exit(0));
