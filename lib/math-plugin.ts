import rehypeKatex from "rehype-katex";
import type { Options } from "react-markdown";

/** KaTeX rendering for remark-math output. Loaded on demand (see useMarkdownRehypePlugins). */
export const rehypeKatexPlugin: NonNullable<Options["rehypePlugins"]>[number] = [rehypeKatex, { throwOnError: false, strict: false }];
