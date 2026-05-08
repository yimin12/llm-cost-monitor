import Foundation

/// Internal data fetcher. Providers may compose multiple probes
/// (e.g. a `LocalSessionProbe` for JSONL + an `APIProbe` for vendor-reported spend
/// + a `CLIQuotaProbe` for live quota lines).
public protocol UsageProbe: Sendable {
    /// Fetch a fresh snapshot. Throws on hard failure.
    func probe() async throws -> UsageSnapshot

    /// Cheap pre-flight check: does this probe have everything it needs to succeed?
    func isAvailable() async -> Bool
}

/// Errors that probes can raise. Kept narrow on purpose — UI should treat the
/// generic `failed` case as the default.
public enum ProbeError: Error, Sendable, Equatable {
    case cliNotFound(String)
    case credentialMissing(String)
    case parseFailed(String)
    case executionFailed(String)
    case timeout
    case unsupportedFormat(String)
}
