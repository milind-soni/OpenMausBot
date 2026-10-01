import CompanionCore
import SwiftUI

/// What a turn's digest opens onto: the tools, files and memory it
/// touched, read down a list rather than across one run-on line.
struct DigestSheet: View {
    let summary: DigestSummary
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(Array(summary.lines.enumerated()), id: \.offset) { _, line in
                    if let label = line.label {
                        Section(label) {
                            ForEach(Array(line.items.enumerated()), id: \.offset) { _, item in
                                Text(verbatim: item)
                                    .font(.system(size: 14, design: label == "Tools" ? .monospaced : .default))
                                    .textSelection(.enabled)
                            }
                        }
                    } else {
                        Section {
                            Text(verbatim: line.value)
                                .font(.system(size: 14))
                                .textSelection(.enabled)
                        }
                    }
                }
            }
            .navigationTitle("What I did")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Copy", systemImage: "doc.on.doc") {
                        PlatformBridge.copyToPasteboard(summary.plainText)
                        Haptics.selection()
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
