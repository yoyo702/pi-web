"use client";
/* eslint-disable @next/next/no-img-element -- local data-URL attachment previews do not benefit from Next Image */

import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime, useMessagePartText, type AppendMessage, type ThreadMessage } from "@assistant-ui/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CodexConversationItem } from "@/lib/agents/codex-conversation";
import { clearDraft, getDraft, setDraft, type ChatDraftImage } from "@/lib/draft-store";
import type { AgentMessage, AssistantMessage, BashExecutionMessage, ToolResultMessage, UserMessage } from "@/lib/types";
import { MarkdownBody } from "../../MarkdownBody";
import { MessageView } from "../../MessageView";
import { CodexRequestCard, type CodexRequestAnswer, type CodexServerRequest } from "./CodexRequestCard";

const messageDates = new Map<string, Date>();
type ModelOption = { id: string; label: string; provider?: string; defaultReasoningEffort?: string; reasoningEfforts?: { id: string; description?: string }[]; defaultServiceTier?: string; serviceTiers?: { id: string; label: string; description?: string }[] };
function dateFor(id: string) { let value = messageDates.get(id); if (!value) { value = new Date(); messageDates.set(id, value); } return value; }
const ChatActionsContext = createContext<{ cwd?: string; expandDetails: boolean; detailOverrides: Record<string, boolean>; onToggleDetail: (id: string, current: boolean) => void; onRetry: (text: string) => void; onQuote: (text: string) => void; onEdit: (text: string) => void; onOpenFile?: (path: string) => void; forkTargets?: Map<string, string>; onForkFrom?: (itemId: string) => void }>({ expandDetails: false, detailOverrides: {}, onToggleDetail: () => undefined, onRetry: () => undefined, onQuote: () => undefined, onEdit: () => undefined });

function messagesFrom(items: CodexConversationItem[]): readonly ThreadMessage[] {
  const seenReasoning = new Set<string>();
  const deduplicated = [...items].reverse().filter((item) => {
    if (item.kind !== "reasoning") return true;
    const key = (item.summary || item.content).replace(/\s+/g, " ").trim();
    if (!key || [...seenReasoning].some((newer) => newer === key || newer.startsWith(key))) return false;
    seenReasoning.add(key);
    return true;
  }).reverse();
  const seenAssistantText = new Set<string>();
  const turnDeduplicated = deduplicated.filter((item) => {
    if (item.kind === "message" && item.role === "user") { seenAssistantText.clear(); return true; }
    if (item.kind !== "message" || item.role !== "assistant") return true;
    const key = item.text.replace(/\s+/g, " ").trim();
    if (!key || seenAssistantText.has(key)) return false;
    seenAssistantText.add(key);
    return true;
  });
  const visibleItems = turnDeduplicated.filter((item, index, all) => {
    if (index === 0 || item.kind === "command" || item.kind === "fileChange" || item.kind === "tool" || item.kind === "toolCall" || item.kind === "notice" || item.kind === "review" || item.kind === "message" && item.role === "user") return true;
    const previous = all[index - 1];
    if (item.kind !== previous.kind) return true;
    if (item.kind === "reasoning" && previous.kind === "reasoning") return (item.summary || item.content).trim() !== (previous.summary || previous.content).trim();
    if (item.kind === "plan" && previous.kind === "plan") return item.text.trim() !== previous.text.trim();
    if (item.kind === "message" && previous.kind === "message") return item.role !== previous.role || item.text.trim() !== previous.text.trim();
    return true;
  });
  return visibleItems.map((item) => {
    if (item.kind === "message" && item.role === "user") return { id: item.id, createdAt: dateFor(item.id), role: "user" as const, content: [{ type: "text" as const, text: item.text }], attachments: [], metadata: { custom: { codexItem: item } } };
    const text = item.kind === "message" ? item.text : item.kind === "command" ? item.command : item.kind === "fileChange" ? item.files.join("\n") : item.kind === "reasoning" ? item.summary || item.content : item.kind === "plan" ? item.text : item.kind === "tool" ? item.title : item.kind === "toolCall" ? item.toolName : item.kind === "todo" ? item.steps.map((step) => step.text).join("\n") : item.text;
    return { id: item.id, createdAt: dateFor(item.id), role: "assistant" as const, content: [{ type: "text" as const, text }], status: { type: "complete" as const, reason: "stop" as const }, metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: { codexItem: item } } };
  });
}
function StyledText() {
  const role = useAuiState((state) => state.message.role);
  const custom = useAuiState((state) => state.message.metadata.custom) as { codexItem?: CodexConversationItem };
  const part = useMessagePartText();
  const item = custom.codexItem;
  const { cwd, expandDetails, detailOverrides, onToggleDetail, onEdit, onOpenFile, forkTargets, onForkFrom } = useContext(ChatActionsContext);
  if (item?.kind === "command") {
    const message: BashExecutionMessage = { role: "bashExecution", command: item.command, output: item.output ?? "", exitCode: item.exitCode ?? undefined, cancelled: item.status === "cancelled" };
    return <div className="codex-aui-pi-message"><MessageView message={message} cwd={cwd} onOpenFile={onOpenFile} /></div>;
  }
  if (item?.kind === "reasoning") {
    const thinking = item.summary || item.content;
    if (!thinking.trim()) return null;
    const isExpanded = detailOverrides[item.id] ?? expandDetails;
    return <CodexThinking text={thinking} expanded={isExpanded} onToggle={() => onToggleDetail(item.id, isExpanded)} />;
  }
  if (item?.kind === "plan" || item?.kind === "review") {
    const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: item.text }], model: "", provider: "" };
    return <div className="codex-aui-pi-message"><MessageView message={message} isStreaming={item.kind === "plan" && item.streaming} cwd={cwd} onOpenFile={onOpenFile} /></div>;
  }
  if (item?.kind === "tool") {
    const message: AssistantMessage = { role: "assistant", content: [{ type: "toolCall", toolCallId: item.id, toolName: item.title || "tool", input: {} }], model: "", provider: "" };
    const result: ToolResultMessage = { role: "toolResult", toolCallId: item.id, toolName: item.title || "tool", content: [{ type: "text", text: item.output ?? (item.done ? "(no output)" : "Running…") }] };
    return <div className="codex-aui-pi-message"><MessageView message={message} isStreaming={!item.done} toolResults={new Map([[item.id, result]])} cwd={cwd} onOpenFile={onOpenFile} /></div>;
  }
  if (item?.kind === "toolCall") {
    const message: AssistantMessage = { role: "assistant", content: [{ type: "toolCall", toolCallId: item.id, toolName: item.toolName, input: item.input }], model: "", provider: "" };
    const result = { role: "toolResult", toolCallId: item.id, toolName: item.toolName, isError: item.isError, content: [{ type: "text", text: item.output || "(no output)" }], ...(item.diff ? { details: { diff: item.diff } } : {}) } as ToolResultMessage;
    return <div className="codex-aui-pi-message"><MessageView message={message} isStreaming={!item.done} toolResults={item.done ? new Map([[item.id, result]]) : undefined} cwd={cwd} onOpenFile={onOpenFile} /></div>;
  }
  if (item?.kind === "todo") return <TodoList item={item} />;
  if (item?.kind === "notice") return <div className={`codex-aui-item-notice${item.tone === "error" ? " is-error" : ""}`} role={item.tone === "error" ? "alert" : undefined}>{item.text}</div>;
  if (item?.kind === "fileChange") {
    const path = item.files.length === 1 ? item.files[0] : `${item.files.length} files`;
    const message: AssistantMessage = { role: "assistant", content: [{ type: "toolCall", toolCallId: item.id, toolName: "edit", input: { path } }], model: "", provider: "" };
    const result = { role: "toolResult", toolCallId: item.id, toolName: "edit", content: [{ type: "text", text: item.files.length ? item.files.join("\n") : "(no files reported)" }], ...(item.diff ? { details: { diff: item.diff } } : {}) } as ToolResultMessage;
    return <div className="codex-aui-pi-message"><MessageView message={message} isStreaming={!item.done} toolResults={item.done ? new Map([[item.id, result]]) : undefined} cwd={cwd} onOpenFile={onOpenFile} />{expandDetails && item.files.length > 0 && <div className="codex-aui-file-links">{item.files.map((file) => <button type="button" key={file} onClick={() => onOpenFile?.(file)}>{file}</button>)}</div>}</div>;
  }
  if (item && item.kind !== "message") return null;
  if (!part.text.trim()) return null;
  const message: AgentMessage = role === "user"
    ? { role: "user", content: part.text } satisfies UserMessage
    : { role: "assistant", content: [{ type: "text", text: part.text }], model: "", provider: "" } satisfies AssistantMessage;
  // Forking from a user message keeps the turns before it; the fork's entry id is this item's id.
  const canFork = role === "user" && item && forkTargets?.has(item.id) && onForkFrom;
  return <div className="codex-aui-pi-message"><MessageView message={message} isStreaming={item?.kind === "message" && item.streaming} cwd={cwd} onOpenFile={onOpenFile} onEditContent={role === "user" ? onEdit : undefined} entryId={canFork ? item?.id : undefined} onFork={canFork ? onForkFrom : undefined} /></div>;
}
const TODO_MARKS = { pending: "○", inProgress: "◐", completed: "●" } as const;
const TODO_LABELS = { pending: "pending", inProgress: "in progress", completed: "done" } as const;
function TodoList({ item }: { item: Extract<CodexConversationItem, { kind: "todo" }> }) {
  const done = item.steps.filter((step) => step.status === "completed").length;
  return <section className="codex-aui-todo" aria-label="Tasks">
    <header><strong>Tasks</strong><span>{done}/{item.steps.length} done</span></header>
    {item.explanation && <p>{item.explanation}</p>}
    <ol>{item.steps.map((step, index) => <li key={index} className={`is-${step.status}`} aria-label={`${step.text} (${TODO_LABELS[step.status]})`}><span aria-hidden="true">{TODO_MARKS[step.status]}</span><span>{step.text}</span></li>)}</ol>
  </section>;
}
function StyledMessage() {
  return <MessagePrimitive.Root className="codex-aui-message"><MessagePrimitive.Parts components={{ Text: StyledText }} /></MessagePrimitive.Root>;
}
function CodexThinking({ text, expanded, onToggle }: { text: string; expanded: boolean; onToggle: () => void }) {
  return <div className="codex-aui-pi-thinking"><button type="button" className="codex-aui-pi-thinking-title" aria-expanded={expanded} onClick={onToggle}><span>Thinking</span><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="2 3.5 5 6.5 8 3.5" /></svg></button>{expanded && <div className="codex-aui-pi-thinking-body"><MarkdownBody>{text}</MarkdownBody></div>}</div>;
}
const CODEX_SLASH_COMMANDS = ["/model", "/review", "/compact"];
const NO_FORK_TARGETS = new Map<string, string>();
export type PermissionOption = { value: string; label: string };
const CODEX_PERMISSION_OPTIONS: PermissionOption[] = [{ value: "untrusted", label: "Restricted" }, { value: "on-request", label: "Ask when needed" }, { value: "never", label: "Full access" }];
function DraftComposer({ draftKey, running, canSteer, slashCommands, permissionOptions, sentHistory, modelLabel, modelValue, modelOptions, modelMenuRequest, reasoningEffort, serviceTier, approvalPolicy, approvalLabel, statusLabel, activityLabel, noticeLabel, contextLabel, expandDetails, forkDisabled, onModelToggle, onModelChange, onReasoningEffortChange, onServiceTierChange, onApprovalPolicyChange, onExpandDetails, onFork, onSend, onSteer, onQueue, onStop }: { draftKey: string; running: boolean; canSteer: boolean; slashCommands: string[]; permissionOptions: PermissionOption[]; sentHistory: string[]; modelLabel: string; modelValue: string; modelOptions: ModelOption[]; modelMenuRequest: number; reasoningEffort: string; serviceTier: string; approvalPolicy: string; approvalLabel: string; statusLabel: string; activityLabel?: string; noticeLabel?: string; contextLabel?: string; expandDetails: boolean; forkDisabled: boolean; onModelToggle: () => void; onModelChange: (model: string) => void; onReasoningEffortChange: (effort: string) => void; onServiceTierChange: (tier: string) => void; onApprovalPolicyChange: (policy: string) => void; onExpandDetails: () => void; onFork?: () => void; onSend: (text: string, images?: ChatDraftImage[]) => Promise<boolean>; onSteer: (text: string, images: ChatDraftImage[]) => Promise<"steered" | "queue" | "failed">; onQueue: (message: { text: string; images: ChatDraftImage[] }) => void; onStop: () => Promise<void> }) {
  const initialDraft = getDraft(draftKey);
  const [value, setValue] = useState(() => initialDraft?.value ?? "");
  const [images, setImages] = useState<ChatDraftImage[]>(() => initialDraft?.images ?? []);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [configMenuOpen, setConfigMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const configMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const draft = getDraft(draftKey); setValue(draft?.value ?? ""); setImages(draft?.images ?? []); }, [draftKey]);
  useEffect(() => { const receive = (event: Event) => { const detail = (event as CustomEvent<{ key: string; text: string; replace?: boolean }>).detail; if (detail?.key !== draftKey) return; setValue((current) => { const next = detail.replace ? detail.text : current ? `${current}\n\n> ${detail.text.replaceAll("\n", "\n> ")}\n` : `> ${detail.text.replaceAll("\n", "\n> ")}\n`; setDraft(draftKey, { value: next, images: getDraft(draftKey)?.images ?? [] }); return next; }); }; window.addEventListener("codex-draft-insert", receive); return () => window.removeEventListener("codex-draft-insert", receive); }, [draftKey]);
  useEffect(() => { if (!modelMenuOpen) return; const close = (event: MouseEvent) => { if (!modelMenuRef.current?.contains(event.target as Node)) setModelMenuOpen(false); }; const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setModelMenuOpen(false); }; document.addEventListener("mousedown", close); document.addEventListener("keydown", closeOnEscape); return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", closeOnEscape); }; }, [modelMenuOpen]);
  useEffect(() => { if (modelMenuRequest > 0) setModelMenuOpen(true); }, [modelMenuRequest]);
  useEffect(() => { if (!configMenuOpen) return; const close = (event: MouseEvent) => { if (!configMenuRef.current?.contains(event.target as Node)) setConfigMenuOpen(false); }; const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setConfigMenuOpen(false); }; document.addEventListener("mousedown", close); document.addEventListener("keydown", closeOnEscape); return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", closeOnEscape); }; }, [configMenuOpen]);
  const updateDraft = useCallback((nextValue: string, nextImages: ChatDraftImage[]) => { setValue(nextValue); setImages(nextImages); setDraft(draftKey, { value: nextValue, images: nextImages }); }, [draftKey]);
  const updateValue = useCallback((next: string) => updateDraft(next, images), [images, updateDraft]);
  // While Codex runs, Send adds the message to the current turn (steer); "queue" (or a
  // slash command, or a turn that can no longer take input) waits for the next turn.
  // Without `canSteer` (Claude) every message sent during a turn is queued.
  const submit = useCallback(async (mode: "send" | "queue" = "send") => {
    const text = value.trim();
    if (!text && !images.length) return;
    if (running) {
      // Clear first so typing during the request is kept; a failed steer puts the message back.
      setValue(""); setImages([]); clearDraft(draftKey); setHistoryIndex(-1);
      const result = mode === "queue" || !canSteer || text.startsWith("/") ? "queue" : await onSteer(text, images);
      if (result === "queue") onQueue({ text, images });
      if (result === "failed") { const current = getDraft(draftKey); updateDraft([value, current?.value].filter(Boolean).join("\n\n"), [...images, ...(current?.images ?? [])].slice(0, 5)); }
      return;
    }
    const sent = await onSend(text, images);
    if (!sent) return;
    setValue("");
    setImages([]); clearDraft(draftKey);
    setHistoryIndex(-1);
  }, [canSteer, draftKey, images, onQueue, onSend, onSteer, running, updateDraft, value]);
  const matchingCommands = value.startsWith("/") && !value.includes(" ") ? slashCommands.filter((command) => command.startsWith(value)) : [];
  const updateComposerValue = useCallback((next: string) => {
    updateValue(next);
    setSlashMenuOpen(next.startsWith("/") && !next.includes(" "));
    setSlashActiveIndex(0);
  }, [updateValue]);
  const applySlashCommand = useCallback((command: string) => {
    updateValue(command);
    setSlashMenuOpen(false);
  }, [updateValue]);
  const attachFiles = useCallback(async (files: FileList | null) => { if (!files) return; const blocks: string[] = []; const nextImages = [...images]; for (const file of Array.from(files)) { if (file.type.startsWith("image/")) { if (nextImages.length >= 5 || file.size > 5 * 1024 * 1024) { blocks.push(`[Skipped ${file.name}: image limit exceeded]`); continue; } const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); nextImages.push({ mimeType: file.type, data: url.split(",", 2)[1] ?? "" }); continue; } if (file.size > 1024 * 1024) { blocks.push(`[Skipped ${file.name}: larger than 1 MiB]`); continue; } try { blocks.push(`<file name="${file.name}">\n${await file.text()}\n</file>`); } catch { blocks.push(`[Unable to read ${file.name}]`); } } updateDraft([value, ...blocks].filter(Boolean).join("\n\n"), nextImages); }, [images, updateDraft, value]);
  return <form className="codex-aui-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={(event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); void attachFiles(event.dataTransfer.files); }}>
    {activityLabel && <div className="codex-aui-activity" title={activityLabel}><span className="codex-aui-activity-pulse" /> <span>{activityLabel}</span></div>}
    {noticeLabel && <div className="codex-aui-notice" role="status">{noticeLabel}</div>}
    {slashMenuOpen && matchingCommands.length > 0 && <div className="codex-aui-commands">{matchingCommands.map((command, index) => <button type="button" className={index === slashActiveIndex ? "is-active" : ""} key={command} onMouseEnter={() => setSlashActiveIndex(index)} onClick={() => applySlashCommand(command)}>{command}</button>)}</div>}
    <div className="codex-aui-compose-box">
      {images.length > 0 && <div className="codex-aui-images">{images.map((image, index) => <span key={`${image.mimeType}-${index}`}><img src={`data:${image.mimeType};base64,${image.data}`} alt={`Attachment ${index + 1}`} /><button type="button" title="Remove image" onClick={() => updateDraft(value, images.filter((_, imageIndex) => imageIndex !== index))}>×</button></span>)}</div>}
      <div className="codex-aui-compose-row">
        <textarea value={value} placeholder={running ? canSteer ? "Add to this turn, or queue for the next…" : "Queue a message for the next turn…" : slashCommands.length ? "Message… Type / for commands" : "Message…"} rows={1} onChange={(event) => updateComposerValue(event.target.value)} onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); void attachFiles(event.clipboardData.files); } }} onKeyDown={(event) => { if (slashMenuOpen && matchingCommands.length > 0 && !event.nativeEvent.isComposing) { if (event.key === "Escape") { event.preventDefault(); setSlashMenuOpen(false); return; } if (event.key === "ArrowDown") { event.preventDefault(); setSlashActiveIndex((index) => (index + 1) % matchingCommands.length); return; } if (event.key === "ArrowUp") { event.preventDefault(); setSlashActiveIndex((index) => (index - 1 + matchingCommands.length) % matchingCommands.length); return; } if ((event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) && matchingCommands[slashActiveIndex]) { event.preventDefault(); applySlashCommand(matchingCommands[slashActiveIndex]); return; } } if (event.key === "Escape" && running && !event.nativeEvent.isComposing && !event.repeat) { event.preventDefault(); void onStop(); return; } if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); return; } if (event.key === "ArrowUp" && !value && sentHistory.length) { event.preventDefault(); const nextIndex = Math.min(historyIndex + 1, sentHistory.length - 1); setHistoryIndex(nextIndex); updateValue(sentHistory[sentHistory.length - 1 - nextIndex]); } else if (event.key === "ArrowDown" && historyIndex >= 0) { event.preventDefault(); const nextIndex = historyIndex - 1; setHistoryIndex(nextIndex); updateValue(nextIndex < 0 ? "" : sentHistory[sentHistory.length - 1 - nextIndex]); } }} />
        <button type="submit" className="codex-aui-send" disabled={!value.trim() && !images.length}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="2" y1="7" x2="11" y2="7" /><polyline points="7.5 3 12 7 7.5 11" /></svg>{running ? canSteer ? "Steer" : "Queue" : "Send"}</button>
        {running && canSteer && <button type="button" className="codex-aui-send-secondary" title="Send after the current turn finishes" disabled={!value.trim() && !images.length} onClick={() => void submit("queue")}>Queue</button>}
      </div>
    </div>
    <div className="codex-aui-compose-toolbar">
      <label className="codex-aui-attach" title="Attach images, text, or code files"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m21 15-5-5L5 20" /></svg><span>Attach</span><input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,text/*,.md,.json,.js,.ts,.tsx,.jsx,.css,.html,.yaml,.yml" onChange={(event) => { void attachFiles(event.target.files); event.target.value = ""; }} /></label>
      <div className="codex-aui-model-control" ref={modelMenuRef}>
        <button type="button" className="codex-aui-toolbar-button" title={`Model: ${modelLabel}`} aria-haspopup="listbox" aria-expanded={modelMenuOpen} onClick={() => { onModelToggle(); setModelMenuOpen((open) => !open); }}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" /><line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" /><line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" /><line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" /></svg><span>{modelLabel}</span></button>
        {modelMenuOpen && <div className="codex-aui-model-menu" role="listbox"><button type="button" role="option" aria-selected={!modelValue} className={!modelValue ? "is-active" : ""} onClick={() => { onModelChange(""); setModelMenuOpen(false); }}><span className="codex-aui-model-check">{!modelValue ? "✓" : ""}</span><span>Continue with current/default</span></button>{modelOptions.map((model, index) => <div className="codex-aui-model-option" key={model.id}>{model.provider && (index === 0 || modelOptions[index - 1]?.provider !== model.provider) && <small>{model.provider}</small>}<button type="button" role="option" aria-selected={model.id === modelValue} className={model.id === modelValue ? "is-active" : ""} onClick={() => { onModelChange(model.id); setModelMenuOpen(false); }}><span className="codex-aui-model-check">{model.id === modelValue ? "✓" : ""}</span><span>{model.label}</span></button></div>)}</div>}
      </div>
      <span className={`codex-aui-compose-state ${running ? "is-running" : ""}`}><i />{statusLabel}</span>
      <div className="codex-aui-config-control" ref={configMenuRef}>
        <button type="button" className="codex-aui-compose-status" title="Chat configuration" aria-haspopup="dialog" aria-expanded={configMenuOpen} onClick={() => setConfigMenuOpen((open) => !open)}>{approvalLabel}</button>
        {configMenuOpen && <div className="codex-aui-config-menu">
          <strong>Next turn settings</strong>
          <label>Permissions<select value={approvalPolicy} disabled={running} onChange={(event) => onApprovalPolicyChange(event.target.value)}>{permissionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          {(modelOptions.find((option) => option.id === modelValue)?.reasoningEfforts?.length ?? 0) > 0 && <label>Reasoning<select value={reasoningEffort} disabled={running} onChange={(event) => onReasoningEffortChange(event.target.value)}>{modelOptions.find((option) => option.id === modelValue)?.reasoningEfforts?.map((option) => <option key={option.id} value={option.id}>{option.id}</option>)}</select></label>}
          {(modelOptions.find((option) => option.id === modelValue)?.serviceTiers?.length ?? 0) > 0 && <label>Service tier<select value={serviceTier} disabled={running} onChange={(event) => onServiceTierChange(event.target.value)}><option value="">Standard</option>{modelOptions.find((option) => option.id === modelValue)?.serviceTiers?.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>}
          {running && <small>Settings can be changed when the current turn finishes.</small>}
        </div>}
      </div>
      {contextLabel && <span className="codex-aui-compose-state" title="Current context usage">{contextLabel}</span>}
      <button type="button" className="codex-aui-view-toggle codex-aui-details-toggle" aria-pressed={expandDetails} onClick={onExpandDetails}>Details</button>
      {onFork && <details className="codex-aui-more"><summary>More</summary><div><button type="button" className="codex-aui-view-toggle" disabled={forkDisabled} onClick={onFork}>Fork chat</button></div></details>}
      {running && <button type="button" className="codex-aui-stop" onClick={() => void onStop()}><span aria-hidden="true">■</span> Stop</button>}
    </div>
  </form>;
}
export function CodexAssistantThread({ items, running, approvals, requestCards, canSteer = true, slashCommands = CODEX_SLASH_COMMANDS, permissionOptions = CODEX_PERMISSION_OPTIONS, cwd, draftKey, modelLabel, modelValue, modelOptions, modelMenuRequest, reasoningEffort, serviceTier, approvalPolicy, approvalLabel, statusLabel, activityLabel, noticeLabel, contextLabel, forkDisabled, turnOrder, onModelToggle, onModelChange, onReasoningEffortChange, onServiceTierChange, onApprovalPolicyChange, onFork, onForkFrom, onSend, onSteer, onStop, onApproval, onOpenFile }: { items: CodexConversationItem[]; running: boolean; approvals?: CodexServerRequest[]; /** Rendered after the messages, like `approvals`. */ requestCards?: ReactNode; canSteer?: boolean; slashCommands?: string[]; permissionOptions?: PermissionOption[]; cwd?: string; draftKey: string; modelLabel: string; modelValue: string; modelOptions: ModelOption[]; modelMenuRequest: number; reasoningEffort: string; serviceTier: string; approvalPolicy: string; approvalLabel: string; statusLabel: string; activityLabel?: string; noticeLabel?: string; contextLabel?: string; forkDisabled: boolean; /** The thread's turn ids in order; a user message that starts a later turn can be forked from. */ turnOrder?: string[]; onModelToggle: () => void; onModelChange: (model: string) => void; onReasoningEffortChange: (effort: string) => void; onServiceTierChange: (tier: string) => void; onApprovalPolicyChange: (policy: string) => void; onFork?: () => void; /** Forks the turns through `lastTurnId`; `text` is the message forked from. */ onForkFrom?: (lastTurnId: string, text: string) => void; onSend: (text: string, images?: ChatDraftImage[]) => Promise<boolean>; onSteer: (text: string, images: ChatDraftImage[]) => Promise<"steered" | "queue" | "failed">; onStop: () => Promise<void>; onApproval?: (requestId: string, answer: CodexRequestAnswer) => void; onOpenFile?: (path: string) => void }) {
  const [visibleCount, setVisibleCount] = useState(300);
  const [expandDetails, setExpandDetails] = useState(false);
  const [detailOverrides, setDetailOverrides] = useState<Record<string, boolean>>({});
  const visibleItems = useMemo(() => items.slice(-visibleCount), [items, visibleCount]);
  const sourceMessages = useMemo(() => messagesFrom(visibleItems), [visibleItems]);
  const [messages, setMessages] = useState<readonly ThreadMessage[]>(sourceMessages);
  const [queue, setQueue] = useState<{ text: string; images: ChatDraftImage[] }[]>([]);
  const queueSendingRef = useRef(false);
  useEffect(() => setMessages(sourceMessages), [sourceMessages]);
  useEffect(() => { setExpandDetails(localStorage.getItem("pi-codex-expand-details") === "1"); }, []);
  const onNew = useCallback(async (message: AppendMessage) => { const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim(); if (text) await onSend(text); }, [onSend]);
  const runtime = useExternalStoreRuntime<ThreadMessage>({ messages, isRunning: running, onNew, setMessages });
  const viewportRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => { const viewport = viewportRef.current; if (!viewport) return; viewport.scrollTo({ top: viewport.scrollHeight, behavior }); followRef.current = true; setShowJump(false); }, []);
  useEffect(() => { if (!followRef.current) { setShowJump(true); return; } const frame = requestAnimationFrame(() => scrollToBottom(items.length ? "smooth" : "auto")); return () => cancelAnimationFrame(frame); }, [approvals, items, requestCards, running, scrollToBottom]);
  useEffect(() => { if (running || !queue.length || queueSendingRef.current) return; queueSendingRef.current = true; void onSend(queue[0].text, queue[0].images).then((sent) => { if (sent) setQueue((current) => current.slice(1)); }).finally(() => { queueSendingRef.current = false; }); }, [onSend, queue, running]);
  // The first user message of each turn after the first maps to the turn before it.
  const forkTargets = useMemo(() => {
    if (!turnOrder?.length || !onForkFrom || running || forkDisabled) return NO_FORK_TARGETS;
    const targets = new Map<string, string>();
    const seen = new Set<string>();
    for (const item of items) {
      if (item.kind !== "message" || item.role !== "user" || !item.turnId || seen.has(item.turnId)) continue;
      seen.add(item.turnId);
      const index = turnOrder.indexOf(item.turnId);
      if (index > 0) targets.set(item.id, turnOrder[index - 1]);
    }
    return targets;
  }, [forkDisabled, items, onForkFrom, running, turnOrder]);
  // Stable, so memoized messages don't re-render on every streamed delta.
  const forkRef = useRef({ forkTargets, items, onForkFrom });
  useEffect(() => { forkRef.current = { forkTargets, items, onForkFrom }; });
  const onForkItem = useCallback((itemId: string) => {
    const { forkTargets: targets, items: current, onForkFrom: fork } = forkRef.current;
    const lastTurnId = targets.get(itemId);
    const item = current.find((candidate) => candidate.id === itemId);
    if (lastTurnId && item?.kind === "message") fork?.(lastTurnId, item.text);
  }, []);
  const actions = useMemo(() => ({ cwd, expandDetails, detailOverrides, onToggleDetail: (id: string, current: boolean) => setDetailOverrides((overrides) => ({ ...overrides, [id]: !current })), onRetry: (text: string) => { if (running) setQueue((current) => [...current, { text, images: [] }]); else void onSend(text); }, onQuote: (text: string) => window.dispatchEvent(new CustomEvent("codex-draft-insert", { detail: { key: draftKey, text } })), onEdit: (text: string) => window.dispatchEvent(new CustomEvent("codex-draft-insert", { detail: { key: draftKey, text, replace: true } })), onOpenFile, forkTargets, onForkFrom: onForkItem }), [cwd, detailOverrides, draftKey, expandDetails, forkTargets, onForkItem, onOpenFile, onSend, running]);
  const sentHistory = useMemo(() => items.flatMap((item) => item.kind === "message" && item.role === "user" && !item.pending ? [item.text] : []), [items]);
  return <ChatActionsContext.Provider value={actions}><AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="codex-aui-thread"><ThreadPrimitive.Viewport ref={viewportRef} className="codex-aui-viewport" onScroll={() => { const viewport = viewportRef.current; if (!viewport) return; const nearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 96; followRef.current = nearBottom; setShowJump(!nearBottom); }}>{items.length > visibleCount && <button type="button" className="codex-aui-earlier" onClick={() => setVisibleCount((count) => count + 300)}>Show {Math.min(300, items.length - visibleCount)} earlier items</button>}<ThreadPrimitive.Messages>{() => <StyledMessage />}</ThreadPrimitive.Messages>{approvals?.map((approval, index) => <CodexRequestCard key={approval.id} request={approval} position={index + 1} total={approvals.length} onAnswer={onApproval} />)}{requestCards}</ThreadPrimitive.Viewport>{showJump && <button type="button" className="codex-aui-jump" onClick={() => scrollToBottom()}>↓ Latest</button>}{queue.length > 0 && <div className="codex-aui-queue">{queue.length} queued <button type="button" onClick={() => setQueue([])}>Clear</button></div>}<DraftComposer draftKey={draftKey} running={running} canSteer={canSteer} slashCommands={slashCommands} permissionOptions={permissionOptions} sentHistory={sentHistory} modelLabel={modelLabel} modelValue={modelValue} modelOptions={modelOptions} modelMenuRequest={modelMenuRequest} reasoningEffort={reasoningEffort} serviceTier={serviceTier} approvalPolicy={approvalPolicy} approvalLabel={approvalLabel} statusLabel={statusLabel} activityLabel={activityLabel} noticeLabel={noticeLabel} contextLabel={contextLabel} expandDetails={expandDetails} forkDisabled={forkDisabled} onModelToggle={onModelToggle} onModelChange={onModelChange} onReasoningEffortChange={onReasoningEffortChange} onServiceTierChange={onServiceTierChange} onApprovalPolicyChange={onApprovalPolicyChange} onExpandDetails={() => { setDetailOverrides({}); setExpandDetails((value) => { const next = !value; localStorage.setItem("pi-codex-expand-details", next ? "1" : "0"); return next; }); }} onFork={onFork} onSend={onSend} onSteer={onSteer} onQueue={(text) => setQueue((current) => [...current, text])} onStop={onStop} /></ThreadPrimitive.Root></AssistantRuntimeProvider></ChatActionsContext.Provider>;
}
