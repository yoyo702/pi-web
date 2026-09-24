/**
 * Split Markdown into top-level blocks at blank lines so a streaming message
 * can re-parse only its last (growing) block. Blank lines inside fenced code
 * or `$$` display math never split, and neither does a blank line followed by
 * an indented line (list-item continuation or indented code), which would
 * change meaning if rendered on its own.
 */
export function splitMarkdownBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let pendingBlankLines = 0;
  let fence: RegExp | null = null;
  let inDisplayMath = false;

  const flush = () => {
    if (current.length > 0) blocks.push(current.join("\n"));
    current = [];
  };

  for (const line of markdown.split("\n")) {
    if (fence) {
      current.push(line);
      if (fence.test(line)) fence = null;
      continue;
    }
    if (inDisplayMath) {
      current.push(line);
      if (line.trim() === "$$") inDisplayMath = false;
      continue;
    }
    if (line.trim() === "") {
      if (current.length > 0) pendingBlankLines += 1;
      continue;
    }
    if (pendingBlankLines > 0) {
      if (/^[ \t]/.test(line)) {
        for (let index = 0; index < pendingBlankLines; index += 1) current.push("");
      } else {
        flush();
      }
      pendingBlankLines = 0;
    }
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opener) {
      // A closing fence uses the same character, at least as many times, and nothing else.
      fence = new RegExp(`^ {0,3}${opener[1][0]}{${opener[1].length},}\\s*$`);
    } else if (line.trim() === "$$") {
      inDisplayMath = true;
    }
    current.push(line);
  }
  flush();
  return blocks;
}
