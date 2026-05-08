import Foundation

/// What kind of cap a `UsageQuota` represents.
public enum QuotaType: Sendable, Equatable, Hashable {
    case session            // 5-hour rolling block (Claude), per-session
    case daily
    case weekly
    case monthly
    case modelSpecific(String)

    public var displayName: String {
        switch self {
        case .session:                return "Session"
        case .daily:                  return "Daily"
        case .weekly:                 return "Weekly"
        case .monthly:                return "Monthly"
        case .modelSpecific(let m):   return m
        }
    }
}
