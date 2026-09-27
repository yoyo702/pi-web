import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { AuthExpiredNotice } = await jiti.import("./AuthExpiryGuard.tsx");

test("AuthExpiredNotice renders the sign-in prompt when open", () => {
  const html = renderToStaticMarkup(React.createElement(AuthExpiredNotice, { open: true }));

  assert.match(html, /Signed out/);
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /href="\/login"[^>]*target="_blank"/);
});

test("AuthExpiredNotice renders nothing when closed", () => {
  assert.equal(renderToStaticMarkup(React.createElement(AuthExpiredNotice, { open: false })), "");
});
