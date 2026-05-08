import Foundation

/// Canonical provider identity helpers.
///
/// Ported from junhoyeo/tokscale `crates/tokscale-core/src/provider_identity.rs` —
/// the only candidate with a thoughtful normalization layer. We carry both the
/// canonical id and the raw source tag on `UsageEvent` so future re-canonicalization
/// is local (we never need to re-scan JSONL to fix a renamed provider).
public enum ProviderIdentity {
    /// Canonicalize a single provider segment.
    /// Returns nil for empty/unknown segments and for segments that look like
    /// model names (containing digits — "gpt-4", "claude-3").
    public static func canonicalSegment(_ segment: String) -> String? {
        let normalized = segment
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .lowercased()
            .replacingOccurrences(of: "-", with: "_")

        switch normalized {
        case "", "unknown":
            return nil
        case "x_ai", "xai":
            return "xai"
        case "z_ai", "zai":
            return "zai"
        case "moonshot", "moonshotai":
            return "moonshotai"
        case "meta", "meta_llama":
            return "meta_llama"
        case "azure", "azure_ai":
            return "azure_ai"
        case "anthropic", "vertex", "vertex_ai":
            return "anthropic"
        case "together", "together_ai":
            return "together_ai"
        case "fireworks", "fireworks_ai":
            return "fireworks_ai"
        case "google", "gemini":
            return "google"
        case "openai", "openai_codex":
            return "openai"
        case "mistral", "mistralai":
            return "mistralai"
        case "ai21":
            return "ai21"
        default:
            // Reject segments containing digits — almost certainly model fragments
            // ("gpt-4", "claude-3"), not provider identifiers.
            if normalized.contains(where: \.isNumber) { return nil }
            return normalized
        }
    }

    /// All canonical tags found in a slash- and dot-separated raw provider string.
    /// Examples:
    /// - "openrouter/google" → ["openrouter", "google"]
    /// - "bedrock/anthropic.claude-sonnet-4" → ["bedrock", "anthropic"]
    public static func tags(_ raw: String) -> [String] {
        var collected: [String] = []
        let trimmed = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        func push(_ segment: String) {
            if let tag = canonicalSegment(segment), !collected.contains(tag) {
                collected.append(tag)
            }
        }

        for segment in trimmed.split(separator: "/", omittingEmptySubsequences: true) {
            push(String(segment))
            if segment.contains(".") {
                for dotted in segment.split(separator: ".", omittingEmptySubsequences: true) {
                    push(String(dotted))
                }
            }
        }
        return collected
    }

    /// First canonical tag, or nil if none recognized.
    public static func canonical(_ raw: String) -> String? {
        tags(raw).first
    }

    /// Infer a provider from a model name when no provider tag is available.
    /// Conservative: requires word-boundary matching for short tokens (o1/o3/o4/opus/sonnet/haiku/meta)
    /// to avoid false positives like "metadata-model" matching "meta".
    public static func inferred(fromModel model: String) -> String? {
        let lower = model.lowercased()

        if lower.contains("claude") || lower.contains("anthropic")
            || containsDelimited(lower, "opus")
            || containsDelimited(lower, "sonnet")
            || containsDelimited(lower, "haiku") {
            return "anthropic"
        }
        if lower.contains("gpt") || lower.contains("openai")
            || containsDelimited(lower, "o1")
            || containsDelimited(lower, "o3")
            || containsDelimited(lower, "o4") {
            return "openai"
        }
        if lower.contains("gemini") || lower.contains("google") {
            return "google"
        }
        if lower.contains("grok") {
            return "xai"
        }
        if lower.contains("deepseek") {
            return "deepseek"
        }
        if lower.contains("mistral") || lower.contains("mixtral") {
            return "mistralai"
        }
        if lower.contains("llama") || containsDelimited(lower, "meta") {
            return "meta_llama"
        }
        if lower.contains("qwen") {
            return "qwen"
        }
        if lower.contains("kimi") || lower.contains("moonshot") {
            return "moonshotai"
        }
        if lower.contains("glm") {
            return "zai"
        }
        return nil
    }

    /// Whether `needle` appears in `haystack` with non-alphanumeric (or boundary) neighbors.
    /// "o1" matches "o1-preview" but not "protocol1-fast"; "meta" matches "meta-llama-3" but
    /// not "metadata-model".
    static func containsDelimited(_ haystack: String, _ needle: String) -> Bool {
        let chars = Array(haystack)
        let needleChars = Array(needle)
        guard !needleChars.isEmpty, chars.count >= needleChars.count else { return false }

        for start in 0...(chars.count - needleChars.count) {
            if Array(chars[start..<(start + needleChars.count)]) != needleChars { continue }
            let beforeOK = start == 0 || !chars[start - 1].isAlphanumericASCII
            let afterPos = start + needleChars.count
            let afterOK = afterPos == chars.count || !chars[afterPos].isAlphanumericASCII
            if beforeOK && afterOK { return true }
        }
        return false
    }
}

private extension Character {
    var isAlphanumericASCII: Bool {
        guard let scalar = unicodeScalars.first else { return false }
        return scalar.isASCII && (("a"..."z").contains(self) || ("A"..."Z").contains(self) || isNumber)
    }
}
