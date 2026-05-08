import Foundation

/// Health bucket derived from a quota's percent-remaining or burn rate.
/// `Comparable` so `[QuotaStatus].max()` returns the *worst* status.
public enum QuotaStatus: Int, Sendable, Equatable, Comparable, Hashable {
    case healthy = 0
    case warning = 1
    case critical = 2
    case exhausted = 3

    public static func < (lhs: QuotaStatus, rhs: QuotaStatus) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    public static func fromPercentRemaining(_ percent: Double) -> QuotaStatus {
        switch percent {
        case ..<5:    return .exhausted
        case 5..<20:  return .critical
        case 20..<50: return .warning
        default:      return .healthy
        }
    }
}
