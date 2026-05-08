import Foundation

// Reads `<app data>/statusline.json` (atomically updated by the menubar app)
// and prints a one-line summary for Claude Code's `statusline` hook.
// Schema: see docs/architecture.md D12.

@main
struct StatuslineMain {
    static func main() {
        let appDataDir = ProcessInfo.processInfo.environment["LLM_COST_MONITOR_HOME"]
            .flatMap { $0.isEmpty ? nil : $0 }
            ?? (NSHomeDirectory() as NSString)
                .appendingPathComponent("Library/Application Support/llm-cost-monitor")

        let statusURL = URL(fileURLWithPath: appDataDir)
            .appendingPathComponent("statusline.json")

        guard let data = try? Data(contentsOf: statusURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            print("$0.00 (no data)")
            return
        }

        let today  = (json["today_usd"]   as? Double) ?? 0
        let session = (json["session_usd"] as? Double) ?? 0
        let model   = (json["model"]       as? String) ?? "—"
        let used    = (json["context_used"]   as? Int) ?? 0
        let total   = (json["context_window"] as? Int) ?? 0
        let pct     = total > 0 ? (Double(total - used) / Double(total)) * 100 : 0

        print(String(
            format: "$%.2f today  $%.2f session  %@  %d%% ctx",
            today, session, model, Int(pct.rounded())
        ))
    }
}
