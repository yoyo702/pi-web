// Code blocks are highlighted with react-syntax-highlighter's PrismAsyncLight,
// which lazy-loads one grammar per language instead of bundling all ~300. Its
// loader table only knows canonical Prism names, so map common aliases (from
// Markdown fences and file extensions) before highlighting.
const PRISM_LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript",
  py: "python", python3: "python",
  rb: "ruby", rs: "rust", kt: "kotlin", kts: "kotlin", cs: "csharp", "c#": "csharp",
  "c++": "cpp", cc: "cpp", hpp: "cpp", h: "c", golang: "go",
  sh: "bash", shell: "bash", zsh: "bash", fish: "bash", console: "bash", shellsession: "bash",
  ps1: "powershell", ps: "powershell",
  yml: "yaml", md: "markdown", mdx: "markdown",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", xhtml: "markup", vue: "markup",
  dockerfile: "docker", tf: "hcl", gql: "graphql", jsonl: "json", jsonc: "json", json5: "json5",
  make: "makefile", mk: "makefile",
  plaintext: "text", plain: "text", txt: "text", "": "text",
};

export function prismLanguage(language: string | undefined): string {
  const normalized = (language ?? "").trim().toLowerCase();
  return PRISM_LANGUAGE_ALIASES[normalized] ?? normalized;
}
