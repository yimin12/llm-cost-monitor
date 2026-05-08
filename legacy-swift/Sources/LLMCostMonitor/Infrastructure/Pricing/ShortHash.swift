import CryptoKit
import Foundation

enum ShortHash {
    /// First `length` hex chars of SHA-256(`data`). Used as a stable, short version stamp
    /// for the bundled `pricing.json` so each `UsageEvent` records *which* snapshot priced it.
    static func sha256Prefix(_ data: Data, length: Int = 12) -> String {
        let digest = SHA256.hash(data: data)
        var hex = ""
        hex.reserveCapacity(length)
        for byte in digest {
            hex += String(format: "%02x", byte)
            if hex.count >= length { break }
        }
        return String(hex.prefix(length))
    }
}
