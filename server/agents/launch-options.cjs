"use strict";

// Launch rules for Claude/Codex terminals, shared by terminal-manager.cjs and
// task-templates.cjs so a saved template is valid exactly when it can run.
const PERMISSION_MODES = {
  codex: ["confirm", "on-request", "never", "bypass"],
  claude: ["confirm", "plan", "accept-edits", "bypass"],
};
const MAX_PROMPT_LENGTH = 8_000;

function isValidModel(model) {
  return model.length <= 120 && /^[A-Za-z0-9._:/-]+$/.test(model);
}

module.exports = { PERMISSION_MODES, MAX_PROMPT_LENGTH, isValidModel };
