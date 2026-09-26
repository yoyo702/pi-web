import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// public/sw.js run against a fake worker scope: handlers are captured, clients are plain objects.
function loadWorker(windows) {
  const handlers = {};
  const opened = [];
  const shown = [];
  const self = {
    location: { origin: "https://pi.example.ts.net" },
    addEventListener: (type, handler) => { handlers[type] = handler; },
    skipWaiting: () => undefined,
    registration: { showNotification: async (title, options) => { shown.push({ title, ...options }); } },
    clients: {
      claim: async () => undefined,
      matchAll: async () => windows,
      openWindow: async (url) => { opened.push(url); return {}; },
    },
  };
  vm.runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), { self, URL, Date });
  const dispatch = async (type, event) => {
    let done = Promise.resolve();
    handlers[type]({ ...event, waitUntil: (promise) => { done = promise; } });
    await done;
  };
  return { dispatch, opened, shown };
}

function fakeWindow(id, url, { focused = false, visibilityState = "hidden", navigates = true } = {}) {
  return {
    id, url, focused, visibilityState, messages: [], focusedCalls: 0, navigatedTo: null,
    focus() { this.focusedCalls += 1; return Promise.resolve(this); },
    // Copied: objects from the vm realm have other prototypes.
    postMessage(message) { this.messages.push(structuredClone(message)); },
    navigate(url) { this.navigatedTo = url; return navigates ? Promise.resolve(this) : Promise.reject(new Error("not controlled")); },
  };
}

const click = (id) => ({ notification: { data: { id }, close: () => undefined } });

test("a push shows a notification that replaces the one for the same target", async () => {
  const { dispatch, shown } = loadWorker([]);
  await dispatch("push", { data: { json: () => ({ id: "n1", title: "Terminal failed", body: "Build · pi-web", tag: "terminal:t1" }) } });
  assert.deepEqual(shown.map(({ title, body, tag, renotify, data }) => ({ title, body, tag, renotify, id: data.id })), [{ title: "Terminal failed", body: "Build · pi-web", tag: "terminal:t1", renotify: true, id: "n1" }]);
});

test("a click opens a new window when none is open", async () => {
  const { dispatch, opened } = loadWorker([fakeWindow("other", "https://other.example/")]);
  await dispatch("notificationclick", click("n 1"));
  assert.deepEqual(opened, ["/?notification=n%201"]);
});

test("a click goes to the focused window, then to a visible one", async () => {
  const hidden = fakeWindow("a", "https://pi.example.ts.net/");
  const visible = fakeWindow("b", "https://pi.example.ts.net/", { visibilityState: "visible" });
  const { dispatch, opened } = loadWorker([hidden, visible]);
  await dispatch("notificationclick", click("n1"));
  assert.equal(visible.focusedCalls, 1);
  assert.deepEqual(visible.messages, [{ type: "pi-web:open-notification", id: "n1" }]);
  assert.deepEqual(hidden.messages, []);
  assert.deepEqual(opened, []);
});

test("a window on another page loads the app, or a new window opens", async () => {
  const login = fakeWindow("a", "https://pi.example.ts.net/login");
  const first = loadWorker([login]);
  await first.dispatch("notificationclick", click("n1"));
  assert.equal(login.navigatedTo, "/?notification=n1");
  assert.deepEqual(first.opened, []);

  const uncontrolled = fakeWindow("b", "https://pi.example.ts.net/login", { navigates: false });
  const second = loadWorker([uncontrolled]);
  await second.dispatch("notificationclick", click("n1"));
  assert.deepEqual(second.opened, ["/?notification=n1"]);
});

test("a window that was still loading gets the entry again when it reports ready, once", async () => {
  const loading = fakeWindow("a", "https://pi.example.ts.net/");
  const { dispatch } = loadWorker([loading]);
  await dispatch("notificationclick", click("n1"));
  await dispatch("message", { data: { type: "pi-web:ready" }, source: { id: "other", postMessage: () => assert.fail("wrong window") } });
  await dispatch("message", { data: { type: "pi-web:ready" }, source: loading });
  await dispatch("message", { data: { type: "pi-web:ready" }, source: loading });
  assert.deepEqual(loading.messages, [{ type: "pi-web:open-notification", id: "n1" }, { type: "pi-web:open-notification", id: "n1" }]);

  // Received the first time: nothing is sent again.
  await dispatch("notificationclick", click("n2"));
  await dispatch("message", { data: { type: "pi-web:notification-received", id: "n2" }, source: loading });
  await dispatch("message", { data: { type: "pi-web:ready" }, source: loading });
  assert.equal(loading.messages.filter((message) => message.id === "n2").length, 1);
});
