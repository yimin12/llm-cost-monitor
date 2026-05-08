import Foundation

/// Point-in-time snapshot of one provider's state.
/// Carries the union of "quota lines" + "today/yesterday cost" + "vendor-reported spend"
/// + a generic `extensionMetrics` escape hatch — same shape as ClaudeBar's UsageSnapshot.
public struct UsageSnapshot: Sendable, Equatable {
    public let providerId: String
    public let quotas: [UsageQuota]
    public let dailyUsageReport: DailyUsageReport?
    public let costUsage: CostUsage?
    public let extensionMetrics: [ExtensionMetric]
    public let accountEmail: String?
    public let accountTier: String?
    public let capturedAt: Date

    public init(
        providerId: String,
        quotas: [UsageQuota] = [],
        dailyUsageReport: DailyUsageReport? = nil,
        costUsage: CostUsage? = nil,
        extensionMetrics: [ExtensionMetric] = [],
        accountEmail: String? = nil,
        accountTier: String? = nil,
        capturedAt: Date = Date()
    ) {
        self.providerId = providerId
        self.quotas = quotas
        self.dailyUsageReport = dailyUsageReport
        self.costUsage = costUsage
        self.extensionMetrics = extensionMetrics
        self.accountEmail = accountEmail
        self.accountTier = accountTier
        self.capturedAt = capturedAt
    }

    public static func empty(for providerId: String) -> UsageSnapshot {
        UsageSnapshot(providerId: providerId)
    }

    public var overallStatus: QuotaStatus {
        quotas.map(\.status).max() ?? .healthy
    }

    public var lowestQuota: UsageQuota? {
        quotas.min(by: { $0.percentRemaining < $1.percentRemaining })
    }

    public var age: TimeInterval { Date().timeIntervalSince(capturedAt) }
    public var isStale: Bool { age > 300 }
}

/// Today + yesterday rollup from local-JSONL providers.
public struct DailyUsageReport: Sendable, Equatable, Codable {
    public let today: DailyStat
    public let yesterday: DailyStat

    public init(today: DailyStat, yesterday: DailyStat) {
        self.today = today
        self.yesterday = yesterday
    }
}

public struct DailyStat: Sendable, Equatable, Codable {
    public let date: Date
    public let totalCostUsd: Decimal
    public let totalTokens: Int
    public let inputTokens: Int
    public let outputTokens: Int
    public let cacheCreationTokens: Int  // 5m + 1h flattened, for display only
    public let cacheReadTokens: Int
    public let sessionCount: Int

    public init(
        date: Date,
        totalCostUsd: Decimal = 0,
        totalTokens: Int = 0,
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        cacheCreationTokens: Int = 0,
        cacheReadTokens: Int = 0,
        sessionCount: Int = 0
    ) {
        self.date = date
        self.totalCostUsd = totalCostUsd
        self.totalTokens = totalTokens
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheCreationTokens = cacheCreationTokens
        self.cacheReadTokens = cacheReadTokens
        self.sessionCount = sessionCount
    }

    public static func empty(for date: Date) -> DailyStat {
        DailyStat(date: date)
    }
}

/// Vendor-reported spend (overrides token×price math when available).
public struct CostUsage: Sendable, Equatable, Codable {
    public let usedUsd: Decimal
    public let limitUsd: Decimal?
    public let period: String?           // "Monthly", "Weekly"
    public let resetsAt: Date?
    public let nextRegenAmountUsd: Decimal?
    public let updatedAt: Date

    public init(
        usedUsd: Decimal,
        limitUsd: Decimal? = nil,
        period: String? = nil,
        resetsAt: Date? = nil,
        nextRegenAmountUsd: Decimal? = nil,
        updatedAt: Date = Date()
    ) {
        self.usedUsd = usedUsd
        self.limitUsd = limitUsd
        self.period = period
        self.resetsAt = resetsAt
        self.nextRegenAmountUsd = nextRegenAmountUsd
        self.updatedAt = updatedAt
    }
}

/// Generic key/value/unit triple — escape hatch for provider-specific metrics
/// without polluting the schema (Bedrock token credits, OpenRouter rate-limit headers, etc.).
public struct ExtensionMetric: Sendable, Equatable, Codable {
    public let key: String
    public let value: Double
    public let unit: String?
    public let display: String?

    public init(key: String, value: Double, unit: String? = nil, display: String? = nil) {
        self.key = key
        self.value = value
        self.unit = unit
        self.display = display
    }
}
