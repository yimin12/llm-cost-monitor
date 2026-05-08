import Foundation

/// User-facing observable provider — what the menubar UI binds to.
/// Shape ported from tddworks/ClaudeBar's AIProvider; concurrency-friendly.
public protocol AIProvider: AnyObject, Sendable, Identifiable where ID == String {
    /// Canonical provider id ("anthropic", "openai", "google", "moonshotai", ...).
    /// Source the canonical form from `ProviderIdentity.canonical(_:)`.
    var id: String { get }
    var name: String { get }

    /// CLI command users would invoke to use this provider directly (for "Open in Terminal" etc.).
    var cliCommand: String? { get }

    /// Vendor's billing/usage dashboard URL (deep link from the menubar).
    var dashboardURL: URL? { get }

    var isEnabled: Bool { get set }

    /// Most recent successful refresh; nil before first refresh.
    var snapshot: UsageSnapshot? { get async }
    var lastError: (any Error)? { get async }
    var isSyncing: Bool { get async }

    /// Cheap availability probe (binary present, credentials configured, etc.).
    func isAvailable() async -> Bool

    /// Drives the underlying probes. Throws on hard failure; idempotent if data hasn't changed.
    @discardableResult
    func refresh() async throws -> UsageSnapshot
}
