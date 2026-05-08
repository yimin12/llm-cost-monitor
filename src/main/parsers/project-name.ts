// Slug encoding (`-Volumes-Portal-SSD-pojo-llm-cost-monitor`) is lossy — we
// don't know which dashes were filesystem separators and which were part of
// directory names. Take the last 3 segments as a readable label; users who
// want something different can add a mapping in settings later.
export function simplifyProjectName(rawSlug: string): string {
  const cleaned = rawSlug.replace(/^-+/, '')
  const segs = cleaned.split('-').filter((s) => s.length > 0)
  if (segs.length === 0) return rawSlug
  if (segs.length <= 3) return segs.join('-')
  return segs.slice(-3).join('-')
}
