"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Options } from "react-markdown";
import { markdownRehypePlugins } from "@/lib/markdown";

type RehypePlugins = NonNullable<Options["rehypePlugins"]>;

// KaTeX (JS + CSS) is a large part of the Markdown bundle but only matters
// for messages with math, so it is loaded the first time one appears.
let mathPlugin: RehypePlugins[number] | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function loadMathRendering(): Promise<void> {
  loading ??= Promise.all([
    import("@/lib/math-plugin"),
    typeof window === "undefined" ? null : import("@/lib/katex-styles"),
  ]).then(([module]) => {
    mathPlugin = module.rehypeKatexPlugin;
    for (const listener of listeners) listener();
  });
  return loading;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getMathPlugin = () => mathPlugin;

/**
 * Rehype plugins for rendering `markdown` (already passed through
 * normalizeDisplayMath, so every math delimiter is `$`). Until KaTeX has
 * loaded, math renders as plain code for a moment.
 */
export function useMarkdownRehypePlugins(markdown: string): RehypePlugins {
  const needsMath = markdown.includes("$");
  const math = useSyncExternalStore(subscribe, getMathPlugin, getMathPlugin);
  useEffect(() => {
    if (needsMath && !math) void loadMathRendering();
  }, [math, needsMath]);
  return useMemo(() => (math ? [...markdownRehypePlugins, math] : markdownRehypePlugins), [math]);
}
