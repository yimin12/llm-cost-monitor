import Foundation
import Testing
@testable import LLMCostMonitor

@Suite("PricingTable")
struct PricingTableTests {
    @Test("Bundled snapshot loads with common Claude / OpenAI / Gemini models")
    func bundledLoad() throws {
        let table = try PricingTable.loadBundled()
        #expect(table.modelCount > 100,
                "expected at least 100 priced models, got \(table.modelCount)")
        #expect(!table.snapshotVersion.isEmpty)

        #expect(table.price(for: "gpt-4o") != nil)
        #expect(table.price(for: "claude-3-5-sonnet-20241022") != nil)
    }

    @Test("Cost calculation matches per-million math for a sample event")
    func sampleCost() throws {
        let table = try PricingTable.loadBundled()
        guard let p = table.price(for: "claude-3-5-sonnet-20241022") else {
            Issue.record("missing Sonnet 3.5 in pricing table")
            return
        }

        let event = UsageEvent(
            id: "test",
            provider: "anthropic",
            model: "claude-3-5-sonnet-20241022",
            timestamp: Date(),
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            computedCostUsd: 0,
            pricingSnapshotVersion: "test",
            sourceFile: "/dev/null"
        )

        let cost = table.cost(for: event)
        let expected = p.inputPerM + p.outputPerM
        #expect(cost == expected, "expected \(expected), got \(cost)")
    }

    @Test("Unknown model falls back instead of returning $0")
    func unknownModelFallback() throws {
        let table = try PricingTable.loadBundled()
        let event = UsageEvent(
            id: "test",
            provider: "anthropic",
            model: "claude-imaginary-99",
            timestamp: Date(),
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            computedCostUsd: 0,
            pricingSnapshotVersion: "test",
            sourceFile: "/dev/null"
        )
        #expect(table.cost(for: event) > 0)
    }
}
