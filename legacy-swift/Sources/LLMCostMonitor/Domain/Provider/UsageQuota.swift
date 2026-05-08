import Foundation

/// One quota line (e.g. "Weekly 75% left, resets in 6d 23h").
public struct UsageQuota: Sendable, Equatable, Identifiable {
    public var id: String { "\(providerId)/\(quotaType.displayName)" }

    public let providerId: String
    public let quotaType: QuotaType
    public let percentRemaining: Double  // 0...100
    public let resetsAt: Date?
    public let resetText: String?

    public init(
        providerId: String,
        quotaType: QuotaType,
        percentRemaining: Double,
        resetsAt: Date? = nil,
        resetText: String? = nil
    ) {
        self.providerId = providerId
        self.quotaType = quotaType
        self.percentRemaining = max(0, min(100, percentRemaining))
        self.resetsAt = resetsAt
        self.resetText = resetText
    }

    public var status: QuotaStatus {
        QuotaStatus.fromPercentRemaining(percentRemaining)
    }
}
