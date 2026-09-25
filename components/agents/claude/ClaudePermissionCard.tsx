"use client";

import { useState } from "react";
import { claudeToolDiff } from "@/lib/agents/claude-conversation";
import { MarkdownBody } from "../../MarkdownBody";

/** A `can_use_tool` prompt from Claude, waiting for the browser's answer. */
export type ClaudePermissionRequest = { request_id: string; request: { tool_name?: string; display_name?: string; description?: string; decision_reason?: string; input?: Record<string, unknown>; permission_suggestions?: unknown[] } };
export type ClaudePermissionAnswer = { decision: "allow" | "allowSession" | "deny"; updatedInput?: Record<string, unknown>; message?: string };

type Question = { question?: string; header?: string; multiSelect?: boolean; options?: { label: string; description?: string }[] };
const text = (value: unknown) => typeof value === "string" ? value : "";

// Claude reads the answers by question text; several choices are joined with ", ".
function QuestionsBody({ input, onAnswer }: { input: Record<string, unknown>; onAnswer: (answer: ClaudePermissionAnswer) => void }) {
  const questions = (Array.isArray(input.questions) ? input.questions : []) as Question[];
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const answerFor = (question: Question) => typed[text(question.question)]?.trim() || (selected[text(question.question)] ?? []).join(", ");
  const complete = questions.every((question) => answerFor(question));
  const toggle = (question: Question, label: string) => setSelected((current) => {
    const key = text(question.question);
    const values = current[key] ?? [];
    return { ...current, [key]: question.multiSelect ? values.includes(label) ? values.filter((value) => value !== label) : [...values, label] : [label] };
  });
  return <>
    {questions.map((question, index) => <fieldset key={`${index}-${question.question}`} className="codex-aui-request-field">
      <legend>{question.header || `Question ${index + 1}`}</legend>
      {question.question && <p>{question.question}</p>}
      {question.options?.map((option) => <label key={option.label} title={option.description || undefined}><input type={question.multiSelect ? "checkbox" : "radio"} name={`${index}-${question.question}`} checked={(selected[text(question.question)] ?? []).includes(option.label)} onChange={() => toggle(question, option.label)} /> {option.label}{option.description ? <small> — {option.description}</small> : null}</label>)}
      <input type="text" aria-label={question.header || `Question ${index + 1}`} placeholder="Other answer" value={typed[text(question.question)] ?? ""} onChange={(event) => setTyped((current) => ({ ...current, [text(question.question)]: event.target.value }))} />
    </fieldset>)}
    <div>
      <button type="button" className="is-primary" disabled={!complete} onClick={() => onAnswer({ decision: "allow", updatedInput: { ...input, answers: Object.fromEntries(questions.map((question) => [text(question.question), answerFor(question)])) } })}>Submit</button>
      <button type="button" className="is-danger" onClick={() => onAnswer({ decision: "deny", message: "The user declined to answer." })}>Skip</button>
    </div>
  </>;
}

function ToolInput({ tool, input }: { tool: string; input: Record<string, unknown> }) {
  if (tool === "Bash") return <><pre>{text(input.command)}</pre>{text(input.description) && <p>{text(input.description)}</p>}</>;
  if (tool === "ExitPlanMode") return <div className="claude-permission-plan"><MarkdownBody>{text(input.plan)}</MarkdownBody></div>;
  const diff = claudeToolDiff(tool, input);
  if (diff) return <pre className="claude-permission-diff">{diff.split("\n").slice(2).map((line, index) => <span key={index} className={line.startsWith("+") ? "is-added" : line.startsWith("-") ? "is-removed" : undefined}>{line}{"\n"}</span>)}</pre>;
  return <pre>{JSON.stringify(input, null, 2)}</pre>;
}

export function ClaudePermissionCard({ request, position, total, onAnswer }: { request: ClaudePermissionRequest; position: number; total: number; onAnswer: (requestId: string, answer: ClaudePermissionAnswer) => void }) {
  const tool = request.request.tool_name ?? "tool";
  const input = request.request.input ?? {};
  const answer = (value: ClaudePermissionAnswer) => onAnswer(request.request_id, value);
  const title = tool === "AskUserQuestion" ? "Claude has a question" : tool === "ExitPlanMode" ? "Ready to leave plan mode" : "Permission required";
  const path = text(input.file_path) || text(input.path) || text(input.notebook_path);
  const canAllowSession = (request.request.permission_suggestions?.length ?? 0) > 0;
  return <section className="codex-aui-approval" role="alert" aria-label={title}>
    <div className="codex-aui-approval-title"><span>!</span><strong>{title}{total > 1 ? ` · ${position}/${total}` : ""}</strong><em>{request.request.display_name || tool}</em></div>
    {tool === "AskUserQuestion" ? <QuestionsBody input={input} onAnswer={answer} /> : <>
      {path && <dl><dt>File</dt><dd>{path}</dd></dl>}
      <ToolInput tool={tool} input={input} />
      {(request.request.decision_reason || request.request.description) && <p>{request.request.decision_reason || request.request.description}</p>}
      <div>
        <button type="button" className="is-primary" onClick={() => answer({ decision: "allow" })}>{tool === "ExitPlanMode" ? "Approve plan" : "Allow"}</button>
        {canAllowSession && <button type="button" title="Also apply Claude's suggested rule for the rest of this session" onClick={() => answer({ decision: "allowSession" })}>Allow for session</button>}
        <button type="button" className="is-danger" onClick={() => answer({ decision: "deny" })}>{tool === "ExitPlanMode" ? "Keep planning" : "Deny"}</button>
      </div>
    </>}
  </section>;
}
