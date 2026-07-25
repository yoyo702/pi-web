# Staying in Sync in Pi Web

Pi Web and the `pi` terminal CLI work on the **same** session files. You can start a conversation in the terminal and keep reading or continue it in the browser, or the other way around. This page explains how the two stay in sync, what refreshes automatically, and the one case you should avoid.

## One Session, Two Windows

A pi session lives in a single file:

```text
~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

Both the terminal `pi` and Pi Web read and append to that same file. Nothing is copied or duplicated — when the terminal writes a new message, it lands in the file Pi Web is already showing. Your data is never lost; it is always in the file.

Because Pi Web and the terminal are two separate programs, they do not share live memory. Pi Web keeps the on-screen conversation in the browser and refreshes it from the file on the events below.

## What Refreshes Automatically

Pi Web refreshes from disk in two situations:

- **When the tab regains focus** — switch back to the browser after working in the terminal and the view catches up immediately.
- **On a low-frequency background poll** — while the tab is visible, Pi Web checks for changes every 15–20 seconds, so an open tab still catches up on its own.

Background (hidden) tabs stay quiet to avoid wasting resources; they refresh the moment you return to them.

The refresh is cheap. Before reloading a conversation, Pi Web makes a tiny check of the file's modification time. It only does a full reload when the file actually changed, so an unchanged session does not flicker or reload needlessly.

The following views all follow this behavior:

| View | Refreshes on |
| --- | --- |
| Chat messages | Focus + ~15s poll (only reloads when the file changed) |
| Git review panel | Focus + ~20s poll, and after each agent turn |
| File Explorer tree | Focus + ~20s poll, and after each agent turn |
| Open-file diffs | Focus + ~20s poll, and after each agent turn |
| Session list (sidebar) | Focus + ~20s poll — terminal-created sessions appear here |
| Open file contents | Live — updates instantly through a file watcher |

The file **content** viewer is special: it watches the file directly and shows a small **live** indicator, so edits appear the moment they are saved, without waiting for a poll.

## Sending From the Browser After Terminal Work

When you send a message from Pi Web, it first checks whether the session file changed on disk since Pi Web last wrote to it. If the terminal appended messages in the meantime, Pi Web reloads them first, then attaches your new message to the real end of the conversation.

This prevents a subtle problem: without the check, a new browser message could attach to an old point and split the conversation into two branches, making the terminal's messages look "lost" even though they are still in the file.

## The One Case to Avoid

Pi session files are designed for **one writer at a time**. The sync behavior above covers the common workflow:

> Work on one side, then switch to the other.

It does **not** make it safe to send prompts from the terminal and the browser to the same session at the **same moment**. If both sides write within the same instant, the conversation can still split into branches. For a single session, keep one side active at a time. Switching between them is seamless; simultaneous writing is not.

## Failed Requests Are Visible

If a model or provider request fails (for example, an authentication error or a bad request), Pi Web shows a red **Request failed** banner on the turn with the error detail, instead of silently showing no response. This makes it clear that the turn failed and why, so you can fix the cause (such as an API key or model setting) and try again.

## Troubleshooting

**I made changes in the terminal but the browser still shows the old conversation.**
Click into the browser tab (focus refresh) or wait for the next background poll. If it still lags, the session may be actively running on the other side — let the current turn finish.

**The Git panel or file tree looks out of date.**
It refreshes on focus and every ~20 seconds while visible, and after each agent turn. Use the panel's manual refresh button to update immediately.

**The session list does not show a session I started in the terminal.**
The list refreshes on focus and on the background poll. Return focus to the browser or wait a moment for it to appear.

**A message I sent from the terminal seems to be missing in the browser.**
It is still in the session file. Refresh the browser tab. Avoid sending from both the terminal and the browser to the same session at the same time, which can split the conversation into branches.
