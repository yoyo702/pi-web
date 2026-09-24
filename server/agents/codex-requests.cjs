"use strict";

// Requests Codex app-server sends to the client, and how a browser answer
// becomes the protocol response. Other server requests (dynamic tool calls,
// ChatGPT token refresh, attestation, legacy v1 approvals) are answered with a
// JSON-RPC error at once so a turn never waits on a card nobody can see.
const SUPPORTED = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

function invalid(message) { return Object.assign(new Error(message), { code: "invalid_request" }); }
function isSupported(method) { return SUPPORTED.has(method); }
const shortString = (value, max = 20_000) => typeof value === "string" && value.length <= max;

function decisionResponse(request, body) {
  const decision = body.decision;
  const params = request.params || {};
  if (["accept", "acceptForSession", "decline", "cancel"].includes(decision)) return { decision };
  if (request.method !== "item/commandExecution/requestApproval") throw invalid("invalid approval decision");
  // Amendments are taken from the request, never from the browser.
  if (decision === "acceptWithExecpolicyAmendment" && Array.isArray(params.proposedExecpolicyAmendment) && params.proposedExecpolicyAmendment.length) return { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } } };
  if (decision === "applyNetworkPolicyAmendment") {
    const amendment = Array.isArray(params.proposedNetworkPolicyAmendments) ? params.proposedNetworkPolicyAmendments[body.amendmentIndex ?? 0] : null;
    if (Number.isInteger(body.amendmentIndex ?? 0) && amendment) return { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } } };
  }
  throw invalid("invalid approval decision");
}

function permissionsResponse(request, body) {
  // Grant exactly what was requested, for this turn or the session; decline grants nothing.
  if (body.decision === "decline") return { permissions: {}, scope: "turn" };
  if (body.scope !== "turn" && body.scope !== "session") throw invalid("scope must be turn or session");
  const requested = request.params?.permissions || {};
  const permissions = {};
  if (requested.network) permissions.network = requested.network;
  if (requested.fileSystem) permissions.fileSystem = requested.fileSystem;
  return { permissions, scope: body.scope };
}

function userInputResponse(request, body) {
  const questions = Array.isArray(request.params?.questions) ? request.params.questions : [];
  if (!body.answers || typeof body.answers !== "object") throw invalid("answers are required");
  const answers = {};
  for (const question of questions) {
    if (!Object.hasOwn(body.answers, question.id) || body.answers[question.id] == null) continue;
    const value = body.answers[question.id];
    if (!Array.isArray(value) || value.length > 20 || !value.every((answer) => shortString(answer))) throw invalid("each answer must be a list of strings");
    answers[question.id] = { answers: value };
  }
  return { answers };
}

function elicitationResponse(request, body) {
  if (!["accept", "decline", "cancel"].includes(body.action)) throw invalid("action must be accept, decline or cancel");
  if (body.action !== "accept" || request.params?.mode === "url") return { action: body.action, content: null, _meta: null };
  const content = body.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) throw invalid("content must be an object");
  const valid = (value) => shortString(value) || typeof value === "number" || typeof value === "boolean" || (Array.isArray(value) && value.length <= 100 && value.every((item) => shortString(item)));
  if (Object.keys(content).length > 100 || !Object.values(content).every(valid)) throw invalid("invalid form content");
  return { action: "accept", content, _meta: null };
}

// `body` is the browser's answer; the result is what Codex expects for `request.method`.
function responseFor(request, body = {}) {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval": return decisionResponse(request, body);
    case "item/permissions/requestApproval": return permissionsResponse(request, body);
    case "item/tool/requestUserInput": return userInputResponse(request, body);
    case "mcpServer/elicitation/request": return elicitationResponse(request, body);
    default: throw invalid(`unsupported request ${request.method}`);
  }
}

module.exports = { isSupported, responseFor };
