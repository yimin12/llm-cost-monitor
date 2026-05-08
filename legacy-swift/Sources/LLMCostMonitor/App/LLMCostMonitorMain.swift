import Foundation

@main
struct LLMCostMonitorMain {
    static func main() throws {
        let table = try PricingTable.loadBundled()
        FileHandle.standardOutput.write(Data(
            "LLMCostMonitor — pricing snapshot \(table.snapshotVersion), \(table.modelCount) models loaded\n"
                .utf8
        ))
        // SwiftUI menubar wiring lands in slice 9 (App/MenubarApp.swift).
    }
}
