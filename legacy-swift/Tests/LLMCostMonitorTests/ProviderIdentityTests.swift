import Testing
@testable import LLMCostMonitor

@Suite("ProviderIdentity")
struct ProviderIdentityTests {
    @Test("Canonicalizes known aliases")
    func knownAliases() {
        #expect(ProviderIdentity.canonical("openai-codex") == "openai")
        #expect(ProviderIdentity.canonical("gemini") == "google")
        #expect(ProviderIdentity.canonical("vertex") == "anthropic")
        #expect(ProviderIdentity.canonical("vertex_ai") == "anthropic")
        #expect(ProviderIdentity.canonical("azure") == "azure_ai")
        #expect(ProviderIdentity.canonical("fireworks") == "fireworks_ai")
    }

    @Test("Splits slash-separated multi-tags in stable order")
    func slashTags() {
        #expect(ProviderIdentity.tags("openrouter/google") == ["openrouter", "google"])
        #expect(ProviderIdentity.tags("bedrock/anthropic.claude-sonnet-4") == ["bedrock", "anthropic"])
    }

    @Test("Rejects unknown digit-bearing segments as provider names")
    func rejectsModelFragments() {
        #expect(ProviderIdentity.canonical("gpt-4") == nil)
        #expect(ProviderIdentity.canonical("claude-3") == nil)
    }

    @Test("Mistral aliases collapse to mistralai")
    func mistralAlias() {
        #expect(ProviderIdentity.canonical("mistral") == "mistralai")
        #expect(ProviderIdentity.canonical("mistralai") == "mistralai")
    }

    @Test("Inferred provider from common model names")
    func inferred() {
        #expect(ProviderIdentity.inferred(fromModel: "claude-sonnet-4-5") == "anthropic")
        #expect(ProviderIdentity.inferred(fromModel: "claude-opus-4-6") == "anthropic")
        #expect(ProviderIdentity.inferred(fromModel: "gpt-5.2") == "openai")
        #expect(ProviderIdentity.inferred(fromModel: "o1-preview") == "openai")
        #expect(ProviderIdentity.inferred(fromModel: "o3-mini") == "openai")
        #expect(ProviderIdentity.inferred(fromModel: "gemini-2.5-pro") == "google")
        #expect(ProviderIdentity.inferred(fromModel: "grok-code-fast-1") == "xai")
        #expect(ProviderIdentity.inferred(fromModel: "deepseek-v3") == "deepseek")
        #expect(ProviderIdentity.inferred(fromModel: "qwen3-coder") == "qwen")
        #expect(ProviderIdentity.inferred(fromModel: "kimi-k2") == "moonshotai")
        #expect(ProviderIdentity.inferred(fromModel: "glm-4.6") == "zai")
        #expect(ProviderIdentity.inferred(fromModel: "mixtral-8x7b") == "mistralai")
        #expect(ProviderIdentity.inferred(fromModel: "llama-3-70b") == "meta_llama")
    }

    @Test("Inferred provider does not false-positive on lookalikes")
    func noFalsePositives() {
        #expect(ProviderIdentity.inferred(fromModel: "protocol1-fast") == nil)
        #expect(ProviderIdentity.inferred(fromModel: "metadata-model") == nil)
        #expect(ProviderIdentity.inferred(fromModel: "metamorphic-v1") == nil)
    }

    @Test("ai21 (digit-bearing) preserved by explicit allowlist")
    func ai21() {
        #expect(ProviderIdentity.canonical("ai21") == "ai21")
    }
}
