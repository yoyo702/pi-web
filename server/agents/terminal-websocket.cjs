/* eslint-disable @typescript-eslint/no-require-imports */
"use strict"; // WebSocket transport for external agent terminals.

const { WebSocketServer } = require("ws");
const manager = require("./terminal-manager.cjs");
const codexAppServer = require("./codex-app-server.cjs");

const state = global.__piWebTerminalWebSocketState || { server: new WebSocketServer({ noServer: true }) };
global.__piWebTerminalWebSocketState = state;

function reject(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function acceptTerminalWebSocket(req, socket, head, id) {
  try { manager.getTerminal(id); } catch {
    reject(socket, 404, "Not Found");
    return;
  }
  state.server.handleUpgrade(req, socket, head, (ws) => {
    const { snapshot: buffer, unsubscribe } = manager.snapshotAndSubscribeTerminal(id, (chunk) => {
      if (chunk === null) {
        ws.close(1001, "terminal ended");
        return;
      }
      if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
    });
    ws.send(JSON.stringify({ type: "terminal-snapshot-reset" }));
    if (buffer.data.length) ws.send(buffer.data, { binary: true });
    if (buffer.state !== "running") {
      unsubscribe();
      ws.close(1001, "terminal ended");
      return;
    }
    ws.on("message", (data) => {
      try { const terminal = manager.getTerminal(id); if (terminal.sourceSessionId && codexAppServer.isClaimed(terminal.sourceSessionId)) throw new Error("Codex Chat owns input"); manager.inputTerminal(id, data); } catch { ws.close(1011, "terminal input rejected"); }
    });
    ws.on("close", unsubscribe);
    ws.on("error", unsubscribe);
  });
}

module.exports = { acceptTerminalWebSocket };
