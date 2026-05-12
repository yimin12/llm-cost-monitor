// Static catalog of LLM providers devbar can show in the onboarding flow.
//
// This is the source of truth for the "Provider catalog" section of the
// web dashboard. Each entry describes:
//
//   - identity: id, display name, blurb, vendor URL, dashboard URL
//   - branding: hex (we color the chip with it; the SVG comes from
//     `simple-icons` keyed by `brandIconKey`)
//   - capabilities: which model categories this vendor offers, used to
//     filter / group the catalog ("show me only multimodal vendors")
//   - auth methods: how a user can authenticate (`oauth`, `apiKey`, or
//     both). Drives the onboarding form per provider.
//
// IDs match `src/shared/provider-identity.ts` canonical names where they
// already exist (anthropic / openai / google / moonshotai / deepseek /
// xai / zai / alibaba). New ones added here use the same lowercase
// dotless convention.
//
// We deliberately keep this ts-only — no IPC, no DB. The desktop's
// runtime detection (`getPlanInfo()`) is independent. Catalog only
// describes what's *possible*; detection describes what's *configured*.

export type Capability =
  | 'text' // general-purpose chat / completion
  | 'reasoning' // o1 / R1 style thinking modes
  | 'code' // codex / coder variants
  | 'multimodal' // vision-capable
  | 'image' // image generation (DALL·E / SDXL / etc.)
  | 'video' // video generation (Sora / Veo / etc.)
  | 'audio' // STT / TTS / voice
  | 'long-context' // 1M+ context windows

export type AuthMethod = 'apiKey' | 'oauth'

export interface CatalogProvider {
  id: string
  name: string
  blurb: string
  homepage: string
  // Where the user manages billing / API keys on the vendor's site.
  consoleUrl: string
  // Hex without leading `#`. Used for chip background tint + glow.
  brandHex: string
  // Lookup key into our `ProviderIcon` component. `null` falls back to
  // the first letter of `name`.
  brandIconKey: string | null
  capabilities: Capability[]
  auth: AuthMethod[]
  // Where the user fetches their API key (deep link). Surfaced as a
  // helper link next to the input field.
  apiKeyHelpUrl: string | null
  // Whether devbar's runtime probe can already detect this provider's
  // local CLI footprint. False = catalog-only entry; the user can save
  // an API key but devbar won't track usage events for it yet.
  trackedByDevbar: boolean
}

export const CATALOG: ReadonlyArray<CatalogProvider> = [
  {
    id: 'anthropic',
    name: 'Claude',
    blurb: 'Anthropic Claude — chat, reasoning, code, vision (Opus / Sonnet / Haiku).',
    homepage: 'https://www.anthropic.com',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    brandHex: 'D97757',
    brandIconKey: 'anthropic',
    capabilities: ['text', 'reasoning', 'code', 'multimodal', 'long-context'],
    auth: ['oauth', 'apiKey'],
    apiKeyHelpUrl: 'https://console.anthropic.com/settings/keys',
    trackedByDevbar: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    blurb: 'GPT family + Codex CLI — chat, reasoning (o-series), images (DALL·E), TTS / Whisper, video (Sora).',
    homepage: 'https://openai.com',
    consoleUrl: 'https://platform.openai.com/api-keys',
    brandHex: '74AA9C',
    brandIconKey: 'openai',
    capabilities: ['text', 'reasoning', 'code', 'multimodal', 'image', 'video', 'audio'],
    auth: ['oauth', 'apiKey'],
    apiKeyHelpUrl: 'https://platform.openai.com/api-keys',
    trackedByDevbar: true,
  },
  {
    id: 'google',
    name: 'Gemini',
    blurb: 'Google Gemini — multimodal flagship, 1M-token context, Veo (video), Imagen (image).',
    homepage: 'https://ai.google.dev',
    consoleUrl: 'https://aistudio.google.com/app/apikey',
    brandHex: '8E75B2',
    brandIconKey: 'google',
    capabilities: ['text', 'reasoning', 'code', 'multimodal', 'image', 'video', 'long-context'],
    auth: ['oauth', 'apiKey'],
    apiKeyHelpUrl: 'https://aistudio.google.com/app/apikey',
    trackedByDevbar: true,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    blurb: 'Cursor IDE + cursor-agent CLI — aggregator over Claude, GPT, Gemini with request-based pricing.',
    homepage: 'https://cursor.com',
    consoleUrl: 'https://cursor.com/dashboard',
    brandHex: '000000',
    brandIconKey: 'cursor',
    capabilities: ['text', 'reasoning', 'code', 'multimodal'],
    auth: ['oauth', 'apiKey'],
    apiKeyHelpUrl: 'https://cursor.com/settings',
    trackedByDevbar: true,
  },
  {
    id: 'xai',
    name: 'Grok',
    blurb: 'xAI Grok — chat, reasoning, vision; native X / 𝕏 integration.',
    homepage: 'https://x.ai',
    consoleUrl: 'https://console.x.ai',
    brandHex: '000000',
    brandIconKey: 'xai',
    capabilities: ['text', 'reasoning', 'multimodal'],
    auth: ['apiKey'],
    apiKeyHelpUrl: 'https://console.x.ai/team/default/api-keys',
    trackedByDevbar: false,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    blurb: 'DeepSeek-V3 + R1 — strong code + reasoning, very low cost per token.',
    homepage: 'https://deepseek.com',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    brandHex: '5786FE',
    brandIconKey: 'deepseek',
    capabilities: ['text', 'reasoning', 'code'],
    auth: ['apiKey'],
    apiKeyHelpUrl: 'https://platform.deepseek.com/api_keys',
    trackedByDevbar: false,
  },
  {
    id: 'doubao',
    name: 'Doubao',
    blurb: 'ByteDance Doubao (豆包) — multimodal, video understanding, Chinese-first.',
    homepage: 'https://www.doubao.com',
    consoleUrl: 'https://console.volcengine.com/ark',
    brandHex: '3C8CFF',
    brandIconKey: 'bytedance',
    capabilities: ['text', 'multimodal', 'video', 'image'],
    auth: ['apiKey'],
    apiKeyHelpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    trackedByDevbar: false,
  },
  {
    id: 'moonshotai',
    name: 'Kimi',
    blurb: 'Moonshot AI Kimi — long-context champion, 200k+ tokens, vision.',
    homepage: 'https://www.moonshot.cn',
    consoleUrl: 'https://platform.moonshot.cn/console/api-keys',
    brandHex: '141414',
    brandIconKey: 'moonshotai',
    capabilities: ['text', 'multimodal', 'long-context'],
    auth: ['apiKey'],
    apiKeyHelpUrl: 'https://platform.moonshot.cn/console/api-keys',
    trackedByDevbar: false,
  },
  {
    id: 'alibaba',
    name: 'Qwen',
    blurb: 'Alibaba Qwen2.5 / QwQ — multimodal, code, math reasoning.',
    homepage: 'https://qwen.ai',
    consoleUrl: 'https://dashscope.aliyuncs.com',
    brandHex: 'FF6A00',
    brandIconKey: 'alibaba',
    capabilities: ['text', 'reasoning', 'code', 'multimodal'],
    auth: ['apiKey'],
    apiKeyHelpUrl: 'https://dashscope.console.aliyun.com/apiKey',
    trackedByDevbar: false,
  },
  {
    id: 'zai',
    name: 'GLM',
    blurb: 'Zhipu AI GLM-4.x — multimodal, code, video understanding.',
    homepage: 'https://www.zhipuai.cn',
    consoleUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    brandHex: '4264FA',
    brandIconKey: null,
    capabilities: ['text', 'multimodal', 'video', 'image'],
    auth: ['apiKey'],
    apiKeyHelpUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    trackedByDevbar: false,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    blurb: 'Mistral Large / Codestral / Pixtral — open-weight family + hosted API.',
    homepage: 'https://mistral.ai',
    consoleUrl: 'https://console.mistral.ai/api-keys',
    brandHex: 'FA520F',
    brandIconKey: 'mistral',
    capabilities: ['text', 'code', 'multimodal'],
    auth: ['apiKey'],
    apiKeyHelpUrl: 'https://console.mistral.ai/api-keys',
    trackedByDevbar: false,
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    blurb: 'HF Inference API — proxy to thousands of OSS models, image / audio / text.',
    homepage: 'https://huggingface.co',
    consoleUrl: 'https://huggingface.co/settings/tokens',
    brandHex: 'FFD21E',
    brandIconKey: 'huggingface',
    capabilities: ['text', 'code', 'multimodal', 'image', 'audio'],
    auth: ['apiKey'],
    apiKeyHelpUrl: 'https://huggingface.co/settings/tokens',
    trackedByDevbar: false,
  },
] as const

// Display order for the capability filter chips. Mirrors how the user
// reading the catalog tends to think — start broad, narrow to niche.
export const CAPABILITY_ORDER: ReadonlyArray<Capability> = [
  'text',
  'reasoning',
  'code',
  'multimodal',
  'image',
  'video',
  'audio',
  'long-context',
]

export const CAPABILITY_LABEL: Record<Capability, string> = {
  text: 'Text',
  reasoning: 'Reasoning',
  code: 'Code',
  multimodal: 'Multimodal',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  'long-context': 'Long context',
}
