/**
 * Logical artifact identity, independent of the display title.
 *
 * PRD / acceptance criteria / design / plan are one document per project: a new
 * title or a "v2" suffix must create a new version, not a new artifact. Other
 * kinds (contracts, diffs, reports, notes) keep a title-derived key.
 */
/** All artifacts are internal review material; product decisions use decisions. */
export function initialArtifactStatus(_kind: string): string {
  return "accepted";
}

const SINGLETON_KINDS = new Set([
  "prd",
  "acceptance_criteria",
  "design",
  "plan",
  "repo_analysis",
]);

export function canonicalArtifactKey(kind: string, title: string): string {
  if (SINGLETON_KINDS.has(kind)) return kind;

  const normalized = title
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, " ")
    .replace(/\bv\d+(?:\.\d+)?\b/g, " ")
    .replace(/\b(draft|final|revised|updated)\b/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

  return `${kind}:${normalized || title.trim().toLowerCase()}`;
}
