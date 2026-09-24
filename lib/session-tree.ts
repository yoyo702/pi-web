import { isModelContextOnlyMessage } from "./model-context-messages";

interface TreeNode<T> {
  entry: { type: string; id: string; message?: unknown };
  children: T[];
  hiddenEntryIds?: string[];
}

/** Entries that are not part of the conversation: system prompt/tool messages and usage records. */
function isNonConversationEntry(entry: TreeNode<unknown>["entry"]): boolean {
  return entry.type === "usage" || (entry.type === "message" && isModelContextOnlyMessage(entry.message));
}

/**
 * Remove non-conversation entries from a session tree, lifting their
 * children into their place. A removed entry with no children (for example a
 * usage record written by idle cache warming) can be the session's current
 * leaf, so its ID is kept on the nearest visible ancestor in `hiddenEntryIds`.
 * Iterative, because session trees can be thousands of entries deep.
 */
export function withoutNonConversationEntries<T extends TreeNode<T>>(roots: T[]): T[] {
  const result: T[] = [];
  const stack: Array<{ node: T; into: T[]; ancestor: T | null }> = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) stack.push({ node: roots[index], into: result, ancestor: null });

  while (stack.length > 0) {
    const { node, into, ancestor } = stack.pop()!;
    if (isNonConversationEntry(node.entry)) {
      if (node.children.length === 0) {
        if (ancestor) ancestor.hiddenEntryIds = [...(ancestor.hiddenEntryIds ?? []), node.entry.id];
      } else {
        for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push({ node: node.children[index], into, ancestor });
      }
      continue;
    }
    const clone = { ...node, children: [] as T[] };
    into.push(clone);
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push({ node: node.children[index], into: clone.children, ancestor: clone });
  }
  return result;
}
