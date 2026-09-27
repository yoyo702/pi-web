import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

// SessionSidebar.tsx (components/SessionSidebar.tsx) renders its own clear
// (X) button next to the <input type="search"> session search box; without
// this rule the browser's native WebKit/Blink search-cancel control would
// also render, showing two clear affordances side by side. Chromium doesn't
// support querying `getComputedStyle(el, "::-webkit-search-cancel-button")`
// (see e2e/navigation.spec.ts's "session search filters the sidebar by
// title" test, which explains why that check can't live there instead), so
// this is asserted directly against the stylesheet source.
const globalsCssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "globals.css");

test("globals.css hides the native search input cancel/decoration controls", () => {
  const css = readFileSync(globalsCssPath, "utf8");
  assert.match(css, /input\[type="search"\]::-webkit-search-cancel-button\s*,?\s*\n?\s*input\[type="search"\]::-webkit-search-decoration\s*\{[^}]*appearance:\s*none/);
});
