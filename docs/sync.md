# Staying in Sync in TianForge pi

TianForge pi and the `pi` terminal CLI work on the **same** session files. You can start a conversation in the terminal and keep reading or continue it in the browser, or the other way around. This page explains background task updates, fast project switching, long-session loading, and the one concurrent-write case to avoid.

## One Session, Two Windows

A pi session lives in a single file:

```text
~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

Both the terminal `pi` and TianForge pi read and append to that same file. Nothing is copied or duplicated — when the terminal writes a new message, it lands in the file TianForge pi is already showing. Your data is never lost; it is always in the file.

Because TianForge pi and the terminal are two separate programs, they do not share live memory. TianForge pi keeps an on-screen view and a bounded browser snapshot, then reconciles them with the session file.

## What Refreshes Automatically

TianForge pi refreshes from disk in two situations:

- **When the tab regains focus** — switch back to the browser after working in the terminal and the view catches up immediately.
- **On a low-frequency background poll** — while the tab is visible, TianForge pi checks for changes every 15–20 seconds, so an open tab still catches up on its own.

Background (hidden) tabs stay quiet to avoid wasting resources; they refresh the moment you return to them.

The refresh is cheap. Before reloading a conversation, TianForge pi makes a tiny check of the file's modification time. It only does a full reload when the file actually changed, so an unchanged session does not flicker or reload needlessly.

Runs started in another project also stay observable. An app-wide event stream carries running-state changes and bounded completion-level events into the browser session cache. It deliberately does not forward token-by-token updates for every background conversation: those updates contain the full accumulated message and previously caused quadratic serialization, slow clients, and Node.js heap growth. Opening the conversation reconnects its dedicated live stream and reconciles the final state from disk.

The following views all follow this behavior:

| View | Refreshes on |
| --- | --- |
| Selected chat | Dedicated live stream + focus + ~15s disk probe |
| Background chats | Running-state and completed-message events; final disk reconciliation |
| Git review panel | Focus + ~20s poll, and after each agent turn |
| File Explorer tree | Focus + ~20s poll, and after each agent turn |
| Open-file diffs | Focus + ~20s poll, and after each agent turn |
| Session list (sidebar) | Focus + ~20s poll — terminal-created sessions appear here |
| Open file contents | Live — updates instantly through a file watcher |

The file **content** viewer is special: it watches the file directly and shows a small **live** indicator, so edits appear the moment they are saved, without waiting for a poll.

## Fast Switching and Long Sessions

TianForge pi keeps a small least-recently-used session cache in memory and IndexedDB. Desktop browsers retain up to five recent sessions and mobile browsers up to three. Cached snapshots are intentionally bounded to recent messages, so switching projects can paint useful content immediately without retaining every conversation in memory. The app then verifies the live state and session file in the background.

Session APIs also return context in pages instead of parsing and sending the entire visible history on every switch. The initial page is 80 messages on desktop and 40 on mobile. Scrolling to the top loads older pages while preserving the scroll position. Aggregate statistics still describe the complete session, not just the rendered page.

The selected session's token stream is throttled to roughly 13 visual updates per second and respects stream backpressure. Completion and tool transitions are never dropped; only superseded visual progress frames are coalesced. These bounds prevent very long model responses or slow/background browsers from growing the server heap without limit.

## Sending From the Browser After Terminal Work

When you send a message from TianForge pi, it first checks whether the session file changed on disk since TianForge pi last wrote to it. If the terminal appended messages in the meantime, TianForge pi reloads them first, then attaches your new message to the real end of the conversation.

This prevents a subtle problem: without the check, a new browser message could attach to an old point and split the conversation into two branches, making the terminal's messages look "lost" even though they are still in the file.

## The One Case to Avoid

Pi session files are designed for **one writer at a time**. The sync behavior above covers the common workflow:

> Work on one side, then switch to the other.

It does **not** make it safe to send prompts from the terminal and the browser to the same session at the **same moment**. If both sides write within the same instant, the conversation can still split into branches. For a single session, keep one side active at a time. Switching between them is seamless; simultaneous writing is not.

## Failed Requests Are Visible

If a model or provider request fails (for example, an authentication error or a bad request), TianForge pi shows a red **Request failed** banner on the turn with the error detail, instead of silently showing no response. This makes it clear that the turn failed and why, so you can fix the cause (such as an API key or model setting) and try again.

## Troubleshooting

**I made changes in the terminal but the browser still shows the old conversation.**
Switch to the conversation: its cached snapshot should appear immediately, followed by live-state and disk reconciliation. If content still lags, use the browser focus refresh or let the current terminal-side turn finish.

**The Git panel or file tree looks out of date.**
It refreshes on focus and every ~20 seconds while visible, and after each agent turn. Use the panel's manual refresh button to update immediately.

**The session list does not show a session I started in the terminal.**
The list refreshes on focus and on the background poll. Return focus to the browser or wait a moment for it to appear.

**A message I sent from the terminal seems to be missing in the browser.**
It is still in the session file. Refresh the browser tab. Avoid sending from both the terminal and the browser to the same session at the same time, which can split the conversation into branches.
