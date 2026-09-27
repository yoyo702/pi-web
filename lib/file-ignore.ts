/**
 * Names that file listings, the file index and the content-search walk skip by
 * default because they are generated, dependency-heavy or OS metadata.
 * Listings/index let the Explorer's visibility toggle reveal them; the content
 * search walk always skips directories with these names (`.DS_Store` is a file,
 * so it never matches there and binary detection already skips it).
 */
export const DEFAULT_IGNORED_NAMES: ReadonlySet<string> = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store",
]);

export const DEFAULT_IGNORED_SUFFIXES: readonly string[] = [".pyc"];

export function isDefaultIgnoredName(name: string): boolean {
  return DEFAULT_IGNORED_NAMES.has(name) || DEFAULT_IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
