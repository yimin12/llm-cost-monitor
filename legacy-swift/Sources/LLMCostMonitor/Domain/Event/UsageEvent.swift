import Foundation

/// One billable LLM API call, normalized across providers.
/// Schema rationale lives in `docs/architecture.md` D6.
public struct UsageEvent: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let provider: String
    public let providerRawTag: String?
    public let model: String
    public let timestamp: Date

    public let project: String?
    public let projectRawSlug: String?
    public let sessionId: String?
    public let messageId: String?

    public let inputTokens: Int
    public let outputTokens: Int
    public let cacheReadTokens: Int
    public let cacheCreation5mTokens: Int
    public let cacheCreation1hTokens: Int
    public let reasoningTokens: Int?
    public let toolCallCount: Int?
    public let latencyMs: Int?

    public let computedCostUsd: Decimal
    public let pricingSnapshotVersion: String

    public let sourceFile: String
    public let sourceLineOffset: Int

    public init(
        id: String,
        provider: String,
        providerRawTag: String? = nil,
        model: String,
        timestamp: Date,
        project: String? = nil,
        projectRawSlug: String? = nil,
        sessionId: String? = nil,
        messageId: String? = nil,
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        cacheReadTokens: Int = 0,
        cacheCreation5mTokens: Int = 0,
        cacheCreation1hTokens: Int = 0,
        reasoningTokens: Int? = nil,
        toolCallCount: Int? = nil,
        latencyMs: Int? = nil,
        computedCostUsd: Decimal,
        pricingSnapshotVersion: String,
        sourceFile: String,
        sourceLineOffset: Int = 0
    ) {
        self.id = id
        self.provider = provider
        self.providerRawTag = providerRawTag
        self.model = model
        self.timestamp = timestamp
        self.project = project
        self.projectRawSlug = projectRawSlug
        self.sessionId = sessionId
        self.messageId = messageId
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheCreation5mTokens = cacheCreation5mTokens
        self.cacheCreation1hTokens = cacheCreation1hTokens
        self.reasoningTokens = reasoningTokens
        self.toolCallCount = toolCallCount
        self.latencyMs = latencyMs
        self.computedCostUsd = computedCostUsd
        self.pricingSnapshotVersion = pricingSnapshotVersion
        self.sourceFile = sourceFile
        self.sourceLineOffset = sourceLineOffset
    }

    public var totalContextTokens: Int {
        inputTokens + cacheReadTokens + cacheCreation5mTokens + cacheCreation1hTokens
    }

    public var totalTokens: Int {
        inputTokens + outputTokens + cacheReadTokens + cacheCreation5mTokens + cacheCreation1hTokens
    }
}
