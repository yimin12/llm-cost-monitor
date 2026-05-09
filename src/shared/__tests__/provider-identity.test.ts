import { describe, expect, it } from 'vitest'
import { canonical, canonicalSegment, inferred, tags } from '../provider-identity'

describe('ProviderIdentity', () => {
  it('canonicalizes known aliases', () => {
    expect(canonical('openai-codex')).toBe('openai')
    expect(canonical('gemini')).toBe('google')
    expect(canonical('ollama')).toBe('local')
    expect(canonical('lm-studio')).toBe('local')
    expect(canonical('llama.cpp')).toBe('local')
    expect(canonical('vertex')).toBe('anthropic')
    expect(canonical('vertex_ai')).toBe('anthropic')
    expect(canonical('azure')).toBe('azure_ai')
    expect(canonical('fireworks')).toBe('fireworks_ai')
  })

  it('splits slash-separated multi-tags in stable order', () => {
    expect(tags('openrouter/google')).toEqual(['openrouter', 'google'])
    expect(tags('bedrock/anthropic.claude-sonnet-4')).toEqual(['bedrock', 'anthropic'])
  })

  it('rejects unknown digit-bearing segments as provider names', () => {
    expect(canonical('gpt-4')).toBeNull()
    expect(canonical('claude-3')).toBeNull()
    expect(canonicalSegment('gpt-4')).toBeNull()
  })

  it('mistral aliases collapse to mistralai', () => {
    expect(canonical('mistral')).toBe('mistralai')
    expect(canonical('mistralai')).toBe('mistralai')
  })

  it('ai21 (digit-bearing) preserved by explicit allowlist', () => {
    expect(canonical('ai21')).toBe('ai21')
  })

  it('empty / whitespace / "unknown" canonicalize to null', () => {
    expect(canonicalSegment('')).toBeNull()
    expect(canonicalSegment('   ')).toBeNull()
    expect(canonicalSegment('unknown')).toBeNull()
  })

  it('passes through unknown alpha-only segments unchanged', () => {
    expect(canonicalSegment('openrouter')).toBe('openrouter')
    expect(canonicalSegment('bedrock')).toBe('bedrock')
  })

  it('infers provider from common model names', () => {
    expect(inferred('claude-sonnet-4-5')).toBe('anthropic')
    expect(inferred('claude-opus-4-6')).toBe('anthropic')
    expect(inferred('gpt-5.2')).toBe('openai')
    expect(inferred('o1-preview')).toBe('openai')
    expect(inferred('o3-mini')).toBe('openai')
    expect(inferred('gemini-2.5-pro')).toBe('google')
    expect(inferred('grok-code-fast-1')).toBe('xai')
    expect(inferred('deepseek-v3')).toBe('deepseek')
    expect(inferred('qwen3-coder')).toBe('qwen')
    expect(inferred('kimi-k2')).toBe('moonshotai')
    expect(inferred('glm-4.6')).toBe('zai')
    expect(inferred('mixtral-8x7b')).toBe('mistralai')
    expect(inferred('llama-3-70b')).toBe('meta_llama')
    expect(inferred('ollama/llama3.1:8b')).toBe('local')
    expect(inferred('lm-studio/qwen2.5-coder')).toBe('local')
  })

  it('inferred provider does not false-positive on lookalikes', () => {
    expect(inferred('protocol1-fast')).toBeNull()
    expect(inferred('metadata-model')).toBeNull()
    expect(inferred('metamorphic-v1')).toBeNull()
  })
})
