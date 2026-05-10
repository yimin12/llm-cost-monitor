// Provider catalog. Distinct from the local-detection registry in
// src/main/providers/* — that one only covers things you can detect on
// disk via CLI logs. The catalog covers the wider universe of API-based
// providers across model categories (multimodal, speech, video, image,
// embeddings) so a user can drop in an API key and start tracking usage
// without a CLI being installed.
//
// V1 stores the API key locally — encrypted via Electron safeStorage
// when available, plain in settings.json otherwise. V1 does NOT yet
// fetch usage against these keys; that's a follow-up. Today the catalog
// is the directory + key-management surface only.

export type ModelCategory =
  | 'code-cli'
  | 'multimodal'
  | 'speech'
  | 'video'
  | 'image'
  | 'embeddings'

export interface CatalogEntry {
  // Stable identifier. Distinct from src/main/providers/* ids when the
  // category isn't code-CLI — e.g. 'openai' is the CLI/Codex provider,
  // 'openai-tts' is the speech entry. Avoids accidental cross-talk
  // between detected and configured rows.
  id: string
  name: string
  category: ModelCategory
  // One-liner shown under the entry in the catalog UI.
  description: string
  // URL where the user creates/finds an API key for this provider.
  apiKeyHelpUrl: string
  // Placeholder shown in the input — gives a hint about the key shape.
  apiKeyPlaceholder: string
  // Optional product page (used for the "↗ website" link).
  websiteUrl?: string
}

// Curated, intentionally small. Covers the categories the user asked
// about plus a few of the most common providers per category. Extend
// here in follow-up PRs as new providers gain steam.
export const PROVIDER_CATALOG: readonly CatalogEntry[] = [
  // ── code-CLI (already supported via on-disk parsers) ─────────────
  {
    id: 'anthropic',
    name: 'Claude Code',
    category: 'code-cli',
    description: 'Anthropic Claude CLI — usage parsed from ~/.claude/.',
    apiKeyHelpUrl: 'https://console.anthropic.com/settings/keys',
    apiKeyPlaceholder: 'sk-ant-…',
    websiteUrl: 'https://claude.com/claude-code',
  },
  {
    id: 'openai',
    name: 'Codex CLI',
    category: 'code-cli',
    description: 'OpenAI Codex CLI — usage parsed from ~/.codex/.',
    apiKeyHelpUrl: 'https://platform.openai.com/api-keys',
    apiKeyPlaceholder: 'sk-…',
    websiteUrl: 'https://platform.openai.com',
  },
  {
    id: 'google',
    name: 'Gemini CLI',
    category: 'code-cli',
    description: 'Google Gemini CLI — usage parsed from ~/.gemini/.',
    apiKeyHelpUrl: 'https://aistudio.google.com/app/apikey',
    apiKeyPlaceholder: 'AIza…',
    websiteUrl: 'https://aistudio.google.com',
  },

  // ── 多模态大模型 (multimodal) ───────────────────────────────────
  {
    id: 'openai-gpt4o',
    name: 'OpenAI GPT-4o',
    category: 'multimodal',
    description: 'Text + vision + audio across one model. Direct API.',
    apiKeyHelpUrl: 'https://platform.openai.com/api-keys',
    apiKeyPlaceholder: 'sk-…',
    websiteUrl: 'https://platform.openai.com/docs/models/gpt-4o',
  },
  {
    id: 'anthropic-direct',
    name: 'Anthropic Claude (API)',
    category: 'multimodal',
    description: 'Claude 3.5/3.7 Sonnet, Opus, Haiku via the Messages API.',
    apiKeyHelpUrl: 'https://console.anthropic.com/settings/keys',
    apiKeyPlaceholder: 'sk-ant-…',
    websiteUrl: 'https://docs.anthropic.com',
  },
  {
    id: 'gemini-direct',
    name: 'Google Gemini (API)',
    category: 'multimodal',
    description: 'Gemini 2.0/1.5 Pro/Flash with native multimodal input.',
    apiKeyHelpUrl: 'https://aistudio.google.com/app/apikey',
    apiKeyPlaceholder: 'AIza…',
    websiteUrl: 'https://ai.google.dev',
  },
  {
    id: 'mistral',
    name: 'Mistral Pixtral',
    category: 'multimodal',
    description: 'Pixtral 12B / Large — vision-enabled Mistral.',
    apiKeyHelpUrl: 'https://console.mistral.ai/api-keys/',
    apiKeyPlaceholder: 'mistral-…',
    websiteUrl: 'https://mistral.ai',
  },
  {
    id: 'qwen-vl',
    name: 'Qwen-VL Max',
    category: 'multimodal',
    description: 'Alibaba Qwen vision-language model. DashScope API.',
    apiKeyHelpUrl: 'https://help.aliyun.com/zh/model-studio/getting-started/get-api-key',
    apiKeyPlaceholder: 'sk-…',
    websiteUrl: 'https://qwen.aliyun.com',
  },
  {
    id: 'glm-4v',
    name: 'GLM-4V (智谱)',
    category: 'multimodal',
    description: 'Zhipu GLM-4V multimodal. BigModel API.',
    apiKeyHelpUrl: 'https://bigmodel.cn/usercenter/apikeys',
    apiKeyPlaceholder: '<zhipu-api-key>',
    websiteUrl: 'https://bigmodel.cn',
  },

  // ── 语音模型 (speech: TTS + STT) ────────────────────────────────
  {
    id: 'openai-whisper',
    name: 'OpenAI Whisper',
    category: 'speech',
    description: 'Whisper-1 STT + GPT-4o transcribe. Same OpenAI key.',
    apiKeyHelpUrl: 'https://platform.openai.com/api-keys',
    apiKeyPlaceholder: 'sk-…',
    websiteUrl: 'https://platform.openai.com/docs/guides/speech-to-text',
  },
  {
    id: 'openai-tts',
    name: 'OpenAI TTS',
    category: 'speech',
    description: 'tts-1 / tts-1-hd / gpt-4o-tts text-to-speech.',
    apiKeyHelpUrl: 'https://platform.openai.com/api-keys',
    apiKeyPlaceholder: 'sk-…',
    websiteUrl: 'https://platform.openai.com/docs/guides/text-to-speech',
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    category: 'speech',
    description: 'Voice cloning + multilingual TTS. Studio + Conversational AI.',
    apiKeyHelpUrl: 'https://elevenlabs.io/app/settings/api-keys',
    apiKeyPlaceholder: 'xi-api-key',
    websiteUrl: 'https://elevenlabs.io',
  },
  {
    id: 'deepgram',
    name: 'Deepgram',
    category: 'speech',
    description: 'Nova-3 STT, Aura-2 TTS, real-time streaming.',
    apiKeyHelpUrl: 'https://console.deepgram.com/project/_/keys',
    apiKeyPlaceholder: '<deepgram-api-key>',
    websiteUrl: 'https://deepgram.com',
  },
  {
    id: 'cartesia',
    name: 'Cartesia Sonic',
    category: 'speech',
    description: 'Low-latency real-time TTS + voice cloning.',
    apiKeyHelpUrl: 'https://play.cartesia.ai/keys',
    apiKeyPlaceholder: '<cartesia-api-key>',
    websiteUrl: 'https://cartesia.ai',
  },
  {
    id: 'assemblyai',
    name: 'AssemblyAI',
    category: 'speech',
    description: 'Universal-1 ASR with diarization, summaries, sentiment.',
    apiKeyHelpUrl: 'https://www.assemblyai.com/app/account',
    apiKeyPlaceholder: '<assemblyai-api-key>',
    websiteUrl: 'https://www.assemblyai.com',
  },

  // ── 视频模型 (video generation) ─────────────────────────────────
  {
    id: 'openai-sora',
    name: 'OpenAI Sora',
    category: 'video',
    description: 'Text-to-video + storyboard. Same OpenAI key.',
    apiKeyHelpUrl: 'https://platform.openai.com/api-keys',
    apiKeyPlaceholder: 'sk-…',
    websiteUrl: 'https://openai.com/sora',
  },
  {
    id: 'google-veo',
    name: 'Google Veo',
    category: 'video',
    description: 'Veo 2/3 high-fidelity video. Vertex AI / Gemini API.',
    apiKeyHelpUrl: 'https://aistudio.google.com/app/apikey',
    apiKeyPlaceholder: 'AIza…',
    websiteUrl: 'https://deepmind.google/technologies/veo',
  },
  {
    id: 'runway',
    name: 'Runway Gen-3',
    category: 'video',
    description: 'Gen-3 Alpha / Turbo. Image-to-video, video-to-video.',
    apiKeyHelpUrl: 'https://app.runwayml.com/account/api-keys',
    apiKeyPlaceholder: 'rw-…',
    websiteUrl: 'https://runwayml.com',
  },
  {
    id: 'pika',
    name: 'Pika 2.0',
    category: 'video',
    description: 'Text/image-to-video with Scene Ingredients.',
    apiKeyHelpUrl: 'https://pika.art/',
    apiKeyPlaceholder: '<pika-api-key>',
    websiteUrl: 'https://pika.art',
  },
  {
    id: 'luma',
    name: 'Luma Dream Machine',
    category: 'video',
    description: 'Ray2 / Dream Machine video gen. Lumalabs API.',
    apiKeyHelpUrl: 'https://lumalabs.ai/dream-machine/api',
    apiKeyPlaceholder: 'luma-…',
    websiteUrl: 'https://lumalabs.ai/dream-machine',
  },
  {
    id: 'kling',
    name: 'Kling AI (可灵)',
    category: 'video',
    description: 'Kuaishou Kling 1.6 / 2.0 video model.',
    apiKeyHelpUrl: 'https://klingai.com/dev/console',
    apiKeyPlaceholder: '<kling-api-key>',
    websiteUrl: 'https://klingai.com',
  },

  // ── 图像生成 (image generation) ─────────────────────────────────
  {
    id: 'openai-dalle',
    name: 'OpenAI DALL·E 3',
    category: 'image',
    description: 'DALL-E 3 + gpt-image-1. Same OpenAI key.',
    apiKeyHelpUrl: 'https://platform.openai.com/api-keys',
    apiKeyPlaceholder: 'sk-…',
    websiteUrl: 'https://platform.openai.com/docs/guides/images',
  },
  {
    id: 'stability',
    name: 'Stability SD 3.5',
    category: 'image',
    description: 'Stable Diffusion 3.5 + Stable Image Core/Ultra.',
    apiKeyHelpUrl: 'https://platform.stability.ai/account/keys',
    apiKeyPlaceholder: 'sk-…',
    websiteUrl: 'https://platform.stability.ai',
  },
  {
    id: 'flux',
    name: 'Black Forest FLUX',
    category: 'image',
    description: 'FLUX.1 [pro/dev/schnell]. BFL API.',
    apiKeyHelpUrl: 'https://docs.bfl.ml/quick_start/create_account/',
    apiKeyPlaceholder: '<bfl-api-key>',
    websiteUrl: 'https://blackforestlabs.ai',
  },
  {
    id: 'midjourney',
    name: 'Midjourney',
    category: 'image',
    description: 'V7 + Niji. No public REST API yet — discord-based.',
    apiKeyHelpUrl: 'https://www.midjourney.com/account',
    apiKeyPlaceholder: '<unofficial-api-key>',
    websiteUrl: 'https://www.midjourney.com',
  },
  {
    id: 'ideogram',
    name: 'Ideogram',
    category: 'image',
    description: 'Ideogram 2.0 — strong typography + photoreal.',
    apiKeyHelpUrl: 'https://developer.ideogram.ai/api-reference/api-reference/generate',
    apiKeyPlaceholder: '<ideogram-api-key>',
    websiteUrl: 'https://ideogram.ai',
  },
  {
    id: 'doubao-image',
    name: 'Doubao Image (字节)',
    category: 'image',
    description: 'Bytedance Doubao image generation. Volcano Engine API.',
    apiKeyHelpUrl: 'https://www.volcengine.com/docs/82379',
    apiKeyPlaceholder: '<volcengine-api-key>',
    websiteUrl: 'https://www.volcengine.com',
  },

  // ── embeddings ─────────────────────────────────────────────────
  {
    id: 'openai-embed',
    name: 'OpenAI Embeddings',
    category: 'embeddings',
    description: 'text-embedding-3-small / -large. Same OpenAI key.',
    apiKeyHelpUrl: 'https://platform.openai.com/api-keys',
    apiKeyPlaceholder: 'sk-…',
    websiteUrl: 'https://platform.openai.com/docs/guides/embeddings',
  },
  {
    id: 'cohere',
    name: 'Cohere Embed',
    category: 'embeddings',
    description: 'embed-multilingual-v3 + reranker. RAG-friendly.',
    apiKeyHelpUrl: 'https://dashboard.cohere.com/api-keys',
    apiKeyPlaceholder: '<cohere-api-key>',
    websiteUrl: 'https://cohere.com',
  },
  {
    id: 'voyage',
    name: 'Voyage AI',
    category: 'embeddings',
    description: 'voyage-3-large / -code-3. Domain-tuned embeddings.',
    apiKeyHelpUrl: 'https://dash.voyageai.com/api-keys',
    apiKeyPlaceholder: 'pa-…',
    websiteUrl: 'https://www.voyageai.com',
  },
  {
    id: 'jina',
    name: 'Jina Embeddings',
    category: 'embeddings',
    description: 'jina-embeddings-v3. Long-context (8k tokens).',
    apiKeyHelpUrl: 'https://jina.ai/?sui=apikey',
    apiKeyPlaceholder: 'jina_…',
    websiteUrl: 'https://jina.ai',
  },
]

export const CATEGORY_LABELS: Record<ModelCategory, string> = {
  'code-cli': 'Code CLIs',
  multimodal: 'Multimodal LLMs',
  speech: 'Speech',
  video: 'Video',
  image: 'Image',
  embeddings: 'Embeddings',
}

// Stable category order for the UI — code-cli first since those are
// the auto-detected ones, then large -> niche.
export const CATEGORY_ORDER: readonly ModelCategory[] = [
  'code-cli',
  'multimodal',
  'speech',
  'video',
  'image',
  'embeddings',
]

export function entriesByCategory(): Record<ModelCategory, CatalogEntry[]> {
  const out: Record<ModelCategory, CatalogEntry[]> = {
    'code-cli': [],
    multimodal: [],
    speech: [],
    video: [],
    image: [],
    embeddings: [],
  }
  for (const e of PROVIDER_CATALOG) out[e.category].push(e)
  return out
}
