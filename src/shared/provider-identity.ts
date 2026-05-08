// Ported from junhoyeo/tokscale `crates/tokscale-core/src/provider_identity.rs`
// (via the Swift reference at legacy-swift/Sources/.../ProviderIdentity.swift).
// Carry both `provider` (canonical) and `providerRawTag` (raw) on every
// UsageEvent so re-canonicalization stays local — no JSONL re-scan ever needed.

const KNOWN_ALIASES: Record<string, string> = {
  x_ai: 'xai',
  xai: 'xai',
  z_ai: 'zai',
  zai: 'zai',
  moonshot: 'moonshotai',
  moonshotai: 'moonshotai',
  meta: 'meta_llama',
  meta_llama: 'meta_llama',
  azure: 'azure_ai',
  azure_ai: 'azure_ai',
  anthropic: 'anthropic',
  vertex: 'anthropic',
  vertex_ai: 'anthropic',
  together: 'together_ai',
  together_ai: 'together_ai',
  fireworks: 'fireworks_ai',
  fireworks_ai: 'fireworks_ai',
  google: 'google',
  gemini: 'google',
  openai: 'openai',
  openai_codex: 'openai',
  mistral: 'mistralai',
  mistralai: 'mistralai',
  ai21: 'ai21',
}

function normalize(segment: string): string {
  return segment
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
    .replace(/-/g, '_')
}

function containsDigit(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0x30 && c <= 0x39) return true
  }
  return false
}

function isAlphanumericAscii(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  )
}

// "o1" matches "o1-preview" but not "protocol1-fast";
// "meta" matches "meta-llama-3" but not "metadata-model".
function containsDelimited(haystack: string, needle: string): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false
  const limit = haystack.length - needle.length
  for (let start = 0; start <= limit; start++) {
    if (haystack.slice(start, start + needle.length) !== needle) continue
    const beforeOk = start === 0 || !isAlphanumericAscii(haystack.charCodeAt(start - 1))
    const afterPos = start + needle.length
    const afterOk =
      afterPos === haystack.length || !isAlphanumericAscii(haystack.charCodeAt(afterPos))
    if (beforeOk && afterOk) return true
  }
  return false
}

export function canonicalSegment(segment: string): string | null {
  const n = normalize(segment)
  if (n === '' || n === 'unknown') return null
  const alias = KNOWN_ALIASES[n]
  if (alias !== undefined) return alias
  // Reject digit-bearing unknown segments — almost certainly model fragments.
  if (containsDigit(n)) return null
  return n
}

export function tags(raw: string): string[] {
  const collected: string[] = []
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '')

  const push = (segment: string): void => {
    const tag = canonicalSegment(segment)
    if (tag !== null && !collected.includes(tag)) collected.push(tag)
  }

  for (const segment of trimmed.split('/')) {
    if (segment === '') continue
    push(segment)
    if (segment.includes('.')) {
      for (const dotted of segment.split('.')) {
        if (dotted !== '') push(dotted)
      }
    }
  }
  return collected
}

export function canonical(raw: string): string | null {
  const t = tags(raw)
  return t.length > 0 ? (t[0] ?? null) : null
}

export function inferred(fromModel: string): string | null {
  const lower = fromModel.toLowerCase()

  if (
    lower.includes('claude') ||
    lower.includes('anthropic') ||
    containsDelimited(lower, 'opus') ||
    containsDelimited(lower, 'sonnet') ||
    containsDelimited(lower, 'haiku')
  ) {
    return 'anthropic'
  }
  if (
    lower.includes('gpt') ||
    lower.includes('openai') ||
    containsDelimited(lower, 'o1') ||
    containsDelimited(lower, 'o3') ||
    containsDelimited(lower, 'o4')
  ) {
    return 'openai'
  }
  if (lower.includes('gemini') || lower.includes('google')) return 'google'
  if (lower.includes('grok')) return 'xai'
  if (lower.includes('deepseek')) return 'deepseek'
  if (lower.includes('mistral') || lower.includes('mixtral')) return 'mistralai'
  if (lower.includes('llama') || containsDelimited(lower, 'meta')) return 'meta_llama'
  if (lower.includes('qwen')) return 'qwen'
  if (lower.includes('kimi') || lower.includes('moonshot')) return 'moonshotai'
  if (lower.includes('glm')) return 'zai'
  return null
}
