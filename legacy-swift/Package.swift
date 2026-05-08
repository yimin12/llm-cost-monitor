// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LLMCostMonitor",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "LLMCostMonitor", targets: ["LLMCostMonitor"]),
        .executable(name: "llm-cost-monitor-statusline", targets: ["LLMCostMonitorStatusline"]),
    ],
    targets: [
        .executableTarget(
            name: "LLMCostMonitor",
            path: "Sources/LLMCostMonitor",
            resources: [.copy("Resources/pricing.json")],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .executableTarget(
            name: "LLMCostMonitorStatusline",
            path: "Sources/LLMCostMonitorStatusline",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "LLMCostMonitorTests",
            dependencies: ["LLMCostMonitor"],
            path: "Tests/LLMCostMonitorTests",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
