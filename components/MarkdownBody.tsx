"use client";

import { memo, useMemo, type MouseEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { resolveLocalFileHref } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { markdownRemarkPlugins, normalizeDisplayMath } from "@/lib/markdown";
import { useMarkdownRehypePlugins } from "@/hooks/useMarkdownRehypePlugins";
import { splitMarkdownBlocks } from "@/lib/markdown-blocks";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}

export function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile }: MarkdownBodyProps) {
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children]);
  const rehypePlugins = useMarkdownRehypePlugins(normalizedMarkdown);
  // react-markdown uses these functions as element types, so a fresh object on
  // every render would unmount and remount code/Mermaid blocks (losing their
  // local state such as Mermaid preview mode) on each streaming update.
  const components = useMemo<Components>(() => ({
          code({ className, children, ...props }) {
            const lang = className?.replace("language-", "").toLowerCase() ?? "";
            const raw = String(children);
            const isBlock = className?.includes("language-") || raw.includes("\n");
            if (isBlock) {
              if (lang === "mermaid") {
                return <MermaidBlock code={raw.replace(/\n$/, "")} isStreaming={isStreaming} />;
              }
              return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} />;
            }
            return (
              <code
                className="markdown-inline-code"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre({ children }) {
            return <>{children}</>;
          },
          a({ href, children, ...props }) {
            // `node` is react-markdown metadata, not a DOM attribute.
            delete props.node;
            const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
            const openFile = onOpenFile;
            if (!filePath || !openFile) {
              return (
                <a href={href} {...props} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            }

            const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
              if (event.defaultPrevented || event.button !== 0) return;
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              const target = event.currentTarget.getAttribute("target");
              if (target && target !== "_self") return;
              event.preventDefault();
              openFile(filePath);
            };

            return (
              <a href={href} {...props} onClick={handleClick}>
                {children}
              </a>
            );
          },
          img({ src, alt, ...props }) {
            delete props.node;
            const filePath = typeof src === "string" ? resolveLocalFileHref(src, cwd) : null;
            const imageSrc = filePath
              ? `/api/files/${encodeFilePathForApi(filePath)}?type=read`
              : src;
            // Dynamic local paths are served directly by the file API.
            // eslint-disable-next-line @next/next/no-img-element
            return <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
          },
          table({ children }) {
            return (
              <div className="markdown-table-wrap">
                <table>{children}</table>
              </div>
            );
          },
  }), [cwd, isStreaming, onOpenFile]);
  // While streaming, parse block by block: finished blocks keep identical
  // text, so their memoized chunks skip re-parsing and only the growing last
  // block is re-rendered. The final message renders as one document.
  const streamingBlocks = useMemo(
    () => (isStreaming ? splitMarkdownBlocks(normalizedMarkdown) : null),
    [isStreaming, normalizedMarkdown],
  );

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      {streamingBlocks
        ? streamingBlocks.map((block, index) => <MarkdownChunk key={index} markdown={block} components={components} rehypePlugins={rehypePlugins} />)
        : <MarkdownChunk markdown={normalizedMarkdown} components={components} rehypePlugins={rehypePlugins} />}
    </div>
  );
}

const MarkdownChunk = memo(function MarkdownChunk({ markdown, components, rehypePlugins }: {
  markdown: string;
  components: Components;
  rehypePlugins: ReturnType<typeof useMarkdownRehypePlugins>;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={markdownRemarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {markdown}
    </ReactMarkdown>
  );
});
