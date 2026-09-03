import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { copyText } = await jiti.import("./clipboard.ts");

function installClipboardDom({ secure = true, writeText } = {}) {
  const previous = {
    window: globalThis.window,
    navigator: globalThis.navigator,
    document: globalThis.document,
  };
  let legacyValue = null;
  let legacyCalls = 0;
  const body = {
    appendChild() {},
    removeChild() {},
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { isSecureContext: secure } });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: writeText ? { writeText } : undefined },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body,
      createElement() {
        return {
          value: "",
          style: {},
          setAttribute() {},
          select() { legacyValue = this.value; },
        };
      },
      execCommand(command) {
        assert.equal(command, "copy");
        legacyCalls += 1;
        return true;
      },
    },
  });
  return {
    result: () => ({ legacyValue, legacyCalls }),
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else Object.defineProperty(globalThis, key, { configurable: true, value });
      }
    },
  };
}

test("falls back when Clipboard API exists but rejects", async () => {
  const dom = installClipboardDom({ writeText: async () => { throw new Error("denied"); } });
  try {
    await copyText("selected text");
    assert.deepEqual(dom.result(), { legacyValue: "selected text", legacyCalls: 1 });
  } finally {
    dom.restore();
  }
});

test("uses the legacy path immediately on an insecure origin", async () => {
  let apiCalls = 0;
  const dom = installClipboardDom({ secure: false, writeText: async () => { apiCalls += 1; } });
  try {
    await copyText("LAN text");
    assert.equal(apiCalls, 0);
    assert.deepEqual(dom.result(), { legacyValue: "LAN text", legacyCalls: 1 });
  } finally {
    dom.restore();
  }
});
