import Foundation

/// Loader for the vendored LiteLLM `model_prices_and_context_window.json` snapshot.
/// Refreshed by `Scripts/refresh-pricing.sh`. We deliberately do NOT decode the whole file
/// into typed structs — the LiteLLM schema is gnarly (model entries have wildly varying
/// optional keys per provider), so we keep raw JSON and pull only the fields we need.
public struct PricingTable: Sendable {
    /// Per-million-token prices for one model. All values are USD per 1M tokens.
    public struct ModelPrice: Sendable, Equatable {
        public let inputPerM: Decimal
        public let outputPerM: Decimal
        public let cacheReadPerM: Decimal?
        public let cacheCreationPerM: Decimal?
        public let cacheCreation5mPerM: Decimal?
        public let cacheCreation1hPerM: Decimal?
        public let reasoningPerM: Decimal?
        public let contextWindow: Int?
        public let provider: String?
    }

    /// SHA prefix of the source `pricing.json` — recorded on each `UsageEvent`.
    public let snapshotVersion: String

    private let entries: [String: ModelPrice]

    /// Load from the bundled `Resources/pricing.json`.
    public static func loadBundled() throws -> PricingTable {
        guard let url = Bundle.module.url(forResource: "pricing", withExtension: "json") else {
            throw PricingError.bundleResourceMissing
        }
        return try load(from: url)
    }

    public static func load(from url: URL) throws -> PricingTable {
        let data = try Data(contentsOf: url)
        return try load(from: data)
    }

    public static func load(from data: Data) throws -> PricingTable {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw PricingError.invalidRoot
        }

        var entries: [String: ModelPrice] = [:]
        entries.reserveCapacity(root.count)

        for (key, value) in root {
            guard let dict = value as? [String: Any] else { continue }
            // LiteLLM's first entry is "sample_spec" — skip non-priced entries.
            let inputCost = dict.decimalValue(forKey: "input_cost_per_token")
            let outputCost = dict.decimalValue(forKey: "output_cost_per_token")
            guard inputCost != nil || outputCost != nil else { continue }

            let cacheRead = dict.decimalValue(forKey: "cache_read_input_token_cost")
            let cacheCreation = dict.decimalValue(forKey: "cache_creation_input_token_cost")
            let cache5m = dict.decimalValue(forKey: "cache_creation_input_token_cost_above_5m")
                ?? dict.decimalValue(forKey: "cache_creation_5m_input_token_cost")
            let cache1h = dict.decimalValue(forKey: "cache_creation_input_token_cost_above_1hr")
                ?? dict.decimalValue(forKey: "cache_creation_1h_input_token_cost")
            let reasoning = dict.decimalValue(forKey: "output_reasoning_token_cost")

            let cw = (dict["max_input_tokens"] as? Int) ?? (dict["max_tokens"] as? Int)

            entries[key.lowercased()] = ModelPrice(
                inputPerM:           (inputCost ?? 0) * 1_000_000,
                outputPerM:          (outputCost ?? 0) * 1_000_000,
                cacheReadPerM:       cacheRead.map { $0 * 1_000_000 },
                cacheCreationPerM:   cacheCreation.map { $0 * 1_000_000 },
                cacheCreation5mPerM: cache5m.map { $0 * 1_000_000 },
                cacheCreation1hPerM: cache1h.map { $0 * 1_000_000 },
                reasoningPerM:       reasoning.map { $0 * 1_000_000 },
                contextWindow:       cw,
                provider:            dict["litellm_provider"] as? String
            )
        }

        // Snapshot fingerprint = SHA-256 prefix of the bytes. Cheap, stable.
        let version = ShortHash.sha256Prefix(data, length: 12)

        return PricingTable(snapshotVersion: version, entries: entries)
    }

    public init(snapshotVersion: String, entries: [String: ModelPrice]) {
        self.snapshotVersion = snapshotVersion
        self.entries = entries
    }

    /// Look up pricing for `model`. Tries:
    /// 1. exact (case-insensitive)
    /// 2. provider-prefixed match (`anthropic/<model>`)
    /// 3. prefix scan (`<entry>` is a prefix of `model` or vice-versa)
    /// 4. keyword fallback (`opus`/`sonnet`/`haiku`/`gpt`/`gemini`/...)
    /// 5. nil
    public func price(for model: String) -> ModelPrice? {
        let lowered = model.lowercased()
        if let direct = entries[lowered] { return direct }

        // Try common provider-prefixed forms.
        for prefix in ["anthropic/", "openai/", "google/", "vertex_ai/", "bedrock/"] {
            if let hit = entries[prefix + lowered] { return hit }
        }

        // Substring sweep — first stable match wins.
        for (key, price) in entries {
            if lowered.hasPrefix(key) || key.hasPrefix(lowered) { return price }
        }

        // Keyword fallback. Returns the *first* model entry whose key contains the keyword,
        // and where pricing is non-zero — keeps us from picking a deprecated zero-priced row.
        let keywords = ["opus", "sonnet", "haiku", "gpt", "gemini", "o1", "o3", "o4",
                        "kimi", "qwen", "deepseek", "glm", "grok", "mistral", "mixtral", "llama"]
        for kw in keywords where lowered.contains(kw) {
            if let hit = entries.first(where: { $0.key.contains(kw) && $0.value.outputPerM > 0 })?.value {
                return hit
            }
        }
        return nil
    }

    /// Compute USD cost for an event using this snapshot.
    /// Falls back to default Sonnet-equivalent pricing if model unknown (so we never silently emit $0).
    public func cost(for event: UsageEvent) -> Decimal {
        let p = price(for: event.model) ?? ModelPrice.fallback
        let perToken: (Int, Decimal) -> Decimal = { tokens, perM in
            guard tokens > 0, perM > 0 else { return 0 }
            return Decimal(tokens) * perM / 1_000_000
        }

        let cache5m = p.cacheCreation5mPerM ?? p.cacheCreationPerM ?? 0
        let cache1h = p.cacheCreation1hPerM ?? p.cacheCreationPerM ?? 0
        let cacheRead = p.cacheReadPerM ?? 0

        let input    = perToken(event.inputTokens, p.inputPerM)
        let output   = perToken(event.outputTokens, p.outputPerM)
        let crRead   = perToken(event.cacheReadTokens, cacheRead)
        let cr5      = perToken(event.cacheCreation5mTokens, cache5m)
        let cr1      = perToken(event.cacheCreation1hTokens, cache1h)
        let reason   = perToken(event.reasoningTokens ?? 0, p.reasoningPerM ?? p.outputPerM)

        return input + output + crRead + cr5 + cr1 + reason
    }

    public func contextWindow(for model: String) -> Int? {
        price(for: model)?.contextWindow
    }

    public var modelCount: Int { entries.count }
}

public enum PricingError: Error, Equatable {
    case bundleResourceMissing
    case invalidRoot
}

private extension PricingTable.ModelPrice {
    /// Sonnet-tier defaults, used only when a model is completely unknown.
    /// Better to over-estimate than to silently emit $0 and make the user think coding is free.
    static let fallback = PricingTable.ModelPrice(
        inputPerM: 3, outputPerM: 15,
        cacheReadPerM: 0.30, cacheCreationPerM: 3.75,
        cacheCreation5mPerM: 3.75, cacheCreation1hPerM: 6.00,
        reasoningPerM: nil,
        contextWindow: 200_000,
        provider: "fallback"
    )
}

private extension Dictionary where Key == String, Value == Any {
    /// LiteLLM stores numbers as either `Int`, `Double`, or string. Decode to `Decimal` losslessly.
    func decimalValue(forKey key: String) -> Decimal? {
        guard let raw = self[key] else { return nil }
        if let d = raw as? Double { return Decimal(d) }
        if let i = raw as? Int { return Decimal(i) }
        if let s = raw as? String, let d = Decimal(string: s) { return d }
        if let n = raw as? NSNumber { return n.decimalValue }
        return nil
    }
}
