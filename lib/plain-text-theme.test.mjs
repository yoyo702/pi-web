import assert from "node:assert/strict";
import test from "node:test";
import { createPlainTextTheme } from "./plain-text-theme.ts";

test("constructs a headless theme against the installed Pi Theme contract", () => {
  const theme = createPlainTextTheme();

  assert.equal(theme.fg("scrollbarTrack", "plain"), "plain");
  assert.equal(theme.bg("searchMatchBg", "plain"), "plain");
  assert.equal(theme.getThinkingBorderColor("max")("plain"), "plain");
  assert.equal(theme.getBashModeBorderColor()("plain"), "plain");
});
