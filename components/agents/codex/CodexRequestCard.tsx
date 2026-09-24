"use client";

import { Fragment, useState } from "react";

/** A request Codex app-server sent to this chat and is waiting on. */
export type CodexServerRequest = { id: string; method: string; params: Record<string, unknown> };
/** The browser's answer; the server turns it into the protocol response for `method`. */
export type CodexRequestAnswer = Record<string, unknown>;

// Keep in step with server/agents/codex-requests.cjs; other requests are declined by the server.
const CARD_METHODS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request"]);
export function isCodexCardRequest(method: string | undefined) { return Boolean(method && CARD_METHODS.has(method)); }

type Question = { id: string; header?: string; question?: string; isOther?: boolean; isSecret?: boolean; options?: { label: string; description?: string }[] | null };
type FieldSchema = { type?: string; title?: string; description?: string; enum?: string[]; enumNames?: string[]; oneOf?: { const: string; title: string }[]; items?: { enum?: string[]; anyOf?: { const: string; title: string }[] }; default?: unknown };
type Choice = { value: string; label: string };

const text = (value: unknown) => typeof value === "string" ? value : "";
const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
function choicesOf(field: FieldSchema): Choice[] | null {
  if (field.oneOf) return field.oneOf.map((option) => ({ value: option.const, label: option.title }));
  if (field.enum) return field.enum.map((value, index) => ({ value, label: field.enumNames?.[index] ?? value }));
  if (field.items?.anyOf) return field.items.anyOf.map((option) => ({ value: option.const, label: option.title }));
  if (field.items?.enum) return field.items.enum.map((value) => ({ value, label: value }));
  return null;
}

function pathLabel(path: Record<string, unknown> | undefined) {
  if (!path) return "?";
  if (path.type === "path") return text(path.path);
  if (path.type === "glob_pattern") return text(path.pattern);
  const special = (path.value ?? {}) as Record<string, unknown>;
  const kind = text(special.kind);
  return kind === "root" ? "/ (entire file system)" : [kind, text(special.path), text(special.subpath)].filter(Boolean).join(" ") || JSON.stringify(path);
}

function Details({ rows }: { rows: [string, string][] }) {
  const shown = rows.filter(([, value]) => value);
  return shown.length ? <dl>{shown.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}</dl> : null;
}

function ApprovalBody({ request, onAnswer }: { request: CodexServerRequest; onAnswer: (answer: CodexRequestAnswer) => void }) {
  const { params } = request;
  const command = Array.isArray(params.command) ? list(params.command).join(" ") : text(params.command);
  const amendment = list(params.proposedExecpolicyAmendment);
  const hosts = Array.isArray(params.proposedNetworkPolicyAmendments) ? params.proposedNetworkPolicyAmendments as { host?: string; action?: string }[] : [];
  return <>
    {command && <pre>{command}</pre>}
    <Details rows={[["Working directory", text(params.cwd)], ["Requested access", text(params.grantRoot)]]} />
    {text(params.reason) && <p>{text(params.reason)}</p>}
    <div>
      <button type="button" className="is-primary" onClick={() => onAnswer({ decision: "accept" })}>Allow once</button>
      <button type="button" onClick={() => onAnswer({ decision: "acceptForSession" })}>Allow for session</button>
      {amendment.length > 0 && <button type="button" title="Codex will not ask again for commands starting with this" onClick={() => onAnswer({ decision: "acceptWithExecpolicyAmendment" })}>Always allow `{amendment.join(" ")}`</button>}
      {hosts.map((host, index) => host.host && <button type="button" key={`${host.host}-${index}`} onClick={() => onAnswer({ decision: "applyNetworkPolicyAmendment", amendmentIndex: index })}>{host.action === "deny" ? "Always block" : "Always allow"} {host.host}</button>)}
      <button type="button" className="is-danger" onClick={() => onAnswer({ decision: "decline" })}>Deny</button>
      <button type="button" className="is-danger" title="Deny and stop this turn" onClick={() => onAnswer({ decision: "cancel" })}>Deny and stop</button>
    </div>
  </>;
}

function PermissionsBody({ request, onAnswer }: { request: CodexServerRequest; onAnswer: (answer: CodexRequestAnswer) => void }) {
  const permissions = (request.params.permissions ?? {}) as { network?: { enabled?: boolean | null } | null; fileSystem?: { read?: string[] | null; write?: string[] | null; entries?: { path?: Record<string, unknown>; access?: string }[] } | null };
  // Everything the server will grant is listed; `entries` replaces read/write in newer Codex versions.
  const entries = (permissions.fileSystem?.entries ?? []).map((entry) => `${entry.access ?? "?"}: ${pathLabel(entry.path)}`);
  return <>
    <Details rows={[["Network", permissions.network?.enabled ? "Allow network access" : ""], ["Read", (permissions.fileSystem?.read ?? []).join("\n")], ["Write", (permissions.fileSystem?.write ?? []).join("\n")], ["Paths", entries.join("\n")], ["Working directory", text(request.params.cwd)]]} />
    {text(request.params.reason) && <p>{text(request.params.reason)}</p>}
    <div>
      <button type="button" className="is-primary" onClick={() => onAnswer({ scope: "turn" })}>Allow for this turn</button>
      <button type="button" onClick={() => onAnswer({ scope: "session" })}>Allow for session</button>
      <button type="button" className="is-danger" onClick={() => onAnswer({ decision: "decline" })}>Deny</button>
    </div>
  </>;
}

function UserInputBody({ request, onAnswer }: { request: CodexServerRequest; onAnswer: (answer: CodexRequestAnswer) => void }) {
  const questions = (Array.isArray(request.params.questions) ? request.params.questions : []) as Question[];
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  // A typed answer wins over a chosen option.
  const answerFor = (question: Question) => typed[question.id]?.trim() || selected[question.id] || "";
  const complete = questions.every((question) => answerFor(question));
  return <>
    {questions.map((question) => <fieldset key={question.id} className="codex-aui-request-field">
      <legend>{question.header || question.id}</legend>
      {question.question && <p>{question.question}</p>}
      {question.options?.map((option) => <label key={option.label} title={option.description || undefined}><input type="radio" name={`${request.id}-${question.id}`} checked={selected[question.id] === option.label} onChange={() => setSelected((current) => ({ ...current, [question.id]: option.label }))} /> {option.label}{option.description ? <small> — {option.description}</small> : null}</label>)}
      {(question.isOther || !question.options?.length) && <input type={question.isSecret ? "password" : "text"} aria-label={question.header || question.id} placeholder={question.options?.length ? "Other answer" : "Your answer"} value={typed[question.id] ?? ""} onChange={(event) => setTyped((current) => ({ ...current, [question.id]: event.target.value }))} />}
    </fieldset>)}
    <div>
      <button type="button" className="is-primary" disabled={!complete} onClick={() => onAnswer({ answers: Object.fromEntries(questions.map((question) => [question.id, [answerFor(question)]])) })}>Submit</button>
    </div>
  </>;
}

function ElicitationBody({ request, onAnswer }: { request: CodexServerRequest; onAnswer: (answer: CodexRequestAnswer) => void }) {
  const { params } = request;
  const schema = (params.requestedSchema ?? {}) as { properties?: Record<string, FieldSchema>; required?: string[] };
  const fields = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.flatMap(([name, field]) => field.default !== undefined ? [[name, field.default]] : field.type === "boolean" ? [[name, false]] : [])));
  const set = (name: string, value: unknown) => setValues((current) => ({ ...current, [name]: value }));
  const filled = (value: unknown) => value !== undefined && value !== "" && !(Array.isArray(value) && !value.length);
  const complete = [...required].every((name) => filled(values[name]));
  // Only web links are opened; anything else is shown as text.
  const url = params.mode === "url" ? text(params.url) || "(no link)" : "";
  const link = /^https?:\/\//i.test(url);
  return <>
    <Details rows={[["MCP server", text(params.serverName)]]} />
    {text(params.message) && <p>{text(params.message)}</p>}
    {url ? <p>{link ? <a href={url} target="_blank" rel="noreferrer noopener">{url}</a> : url}</p> : fields.map(([name, field]) => {
      const label = `${field.title || name}${required.has(name) ? " *" : ""}`;
      const choices = choicesOf(field);
      return <fieldset key={name} className="codex-aui-request-field">
        <legend>{label}</legend>
        {field.description && <p>{field.description}</p>}
        {field.type === "boolean" ? <label><input type="checkbox" checked={values[name] === true} onChange={(event) => set(name, event.target.checked)} /> {field.title || name}</label>
          : field.type === "array" && choices ? choices.map((choice) => <label key={choice.value}><input type="checkbox" checked={list(values[name]).includes(choice.value)} onChange={(event) => set(name, event.target.checked ? [...list(values[name]), choice.value] : list(values[name]).filter((value) => value !== choice.value))} /> {choice.label}</label>)
          : choices ? <select aria-label={field.title || name} value={text(values[name])} onChange={(event) => set(name, event.target.value || undefined)}><option value="">Choose…</option>{choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>
          : <input aria-label={field.title || name} type={field.type === "number" || field.type === "integer" ? "number" : "text"} value={values[name] === undefined ? "" : String(values[name])} onChange={(event) => set(name, event.target.value === "" ? undefined : field.type === "number" || field.type === "integer" ? Number(event.target.value) : event.target.value)} />}
      </fieldset>;
    })}
    <div>
      <button type="button" className="is-primary" disabled={!url && !complete} onClick={() => onAnswer(url ? { action: "accept" } : { action: "accept", content: Object.fromEntries(Object.entries(values).filter(([, value]) => filled(value))) })}>{url ? "Done" : "Submit"}</button>
      <button type="button" className="is-danger" onClick={() => onAnswer({ action: "decline" })}>Decline</button>
      <button type="button" onClick={() => onAnswer({ action: "cancel" })}>Cancel</button>
    </div>
  </>;
}

const TITLES: Record<string, [string, string]> = {
  "item/commandExecution/requestApproval": ["Permission required", "Command execution"],
  "item/fileChange/requestApproval": ["Permission required", "File changes"],
  "item/permissions/requestApproval": ["Permission required", "More access"],
  "item/tool/requestUserInput": ["Codex has a question", "Your input"],
  "mcpServer/elicitation/request": ["Input requested", "MCP server"],
};

export function CodexRequestCard({ request, position, total, onAnswer }: { request: CodexServerRequest; position: number; total: number; onAnswer?: (requestId: string, answer: CodexRequestAnswer) => void }) {
  const [title, kind] = TITLES[request.method] ?? ["Request", request.method];
  const answer = (value: CodexRequestAnswer) => onAnswer?.(request.id, value);
  const body = request.method === "item/permissions/requestApproval" ? <PermissionsBody request={request} onAnswer={answer} />
    : request.method === "item/tool/requestUserInput" ? <UserInputBody request={request} onAnswer={answer} />
      : request.method === "mcpServer/elicitation/request" ? <ElicitationBody request={request} onAnswer={answer} />
        : <ApprovalBody request={request} onAnswer={answer} />;
  return <section className="codex-aui-approval" role="alert" aria-label={title}><div className="codex-aui-approval-title"><span>!</span><strong>{title}{total > 1 ? ` · ${position}/${total}` : ""}</strong><em>{kind}</em></div>{body}</section>;
}
