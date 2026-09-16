import SwiftUI

struct ShareRootView: View {
    @ObservedObject var model: ShareViewModel

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    sharedContent
                    if !model.computers.isEmpty { computerPicker }
                    if !model.destinations.isEmpty { destinationPicker }
                    if model.phase == .ready || model.phase == .sending {
                        instructionField
                    }
                    if let error = model.errorMessage { errorCard(error) }
                    if let warning = model.imageCompatibilityMessage,
                       warning != model.errorMessage {
                        compatibilityCard(warning)
                    }
                    if let warning = model.instructionValidationMessage,
                       warning != model.errorMessage {
                        compatibilityCard(warning)
                    }
                }
                .padding(20)
            }
            Divider()
            footer
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .task { await model.start() }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Button(action: model.cancel) {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .semibold))
                    .frame(width: 32, height: 32)
                    .background(.thinMaterial, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(!model.canCancel)
            .opacity(model.canCancel ? 1 : 0.35)
            .accessibilityLabel(model.phase == .sending ? "Cancel sending" : "Cancel")

            VStack(alignment: .leading, spacing: 2) {
                Text("Send to Astra")
                    .font(.headline)
                Text(headerSubtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if model.phase == .sending {
                ProgressView().controlSize(.small)
            } else if model.phase == .sent {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.title3)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
    }

    private var headerSubtitle: String {
        switch model.phase {
        case .idle, .loading: return "Preparing your share…"
        case .ready: return "Choose where this should go"
        case .sending: return "Sending securely…"
        case .sent: return "Sent"
        case .failed: return "Needs your attention"
        }
    }

    @ViewBuilder
    private var sharedContent: some View {
        if model.preview.isEmpty && model.phase == .loading {
            HStack(spacing: 12) {
                ProgressView()
                Text("Reading shared content")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .cardStyle()
        } else if !model.preview.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Label("Sharing", systemImage: "square.and.arrow.up")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                FlowLayout(spacing: 8) {
                    if model.preview.linkCount > 0 {
                        previewChip(
                            model.preview.linkCount == 1 ? "Link" : "\(model.preview.linkCount) links",
                            icon: "link"
                        )
                    }
                    if model.preview.textCount > 0 {
                        previewChip(
                            model.preview.textCount == 1 ? "Text" : "\(model.preview.textCount) text items",
                            icon: "text.alignleft"
                        )
                    }
                    ForEach(Array(model.preview.attachmentNames.enumerated()), id: \.offset) { _, name in
                        previewChip(name, icon: icon(for: name))
                    }
                }
                if model.preview.ignoredCount > 0 {
                    Text(model.preview.ignoredCount == 1
                         ? "1 unsupported item was left out."
                         : "\(model.preview.ignoredCount) unsupported items were left out.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
            .padding(16)
            .cardStyle()
        }
    }

    private var computerPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Computer")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            Menu {
                ForEach(model.computers) { computer in
                    Button {
                        Task { await model.chooseComputer(computer.id) }
                    } label: {
                        if computer.id == model.selectedComputerID {
                            Label(computer.name, systemImage: "checkmark")
                        } else {
                            Text(computer.name)
                        }
                    }
                }
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "laptopcomputer")
                        .font(.title3)
                        .foregroundStyle(.tint)
                        .frame(width: 30)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.selectedComputer?.name ?? "Choose a computer")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(.primary)
                        if let routeLabel = model.selectedComputer?.routeLabel {
                            Text(routeLabel)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer()
                    if model.phase == .loading {
                        ProgressView().controlSize(.small)
                    } else if model.computers.count > 1 {
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(14)
                .cardStyle()
            }
            .buttonStyle(.plain)
            .disabled(
                (model.phase != .ready && model.phase != .failed)
                    || model.computers.count < 2
            )
        }
    }

    private var destinationPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Send to")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            Menu {
                let bots = model.destinations.filter { $0.kind == .bot }
                let channels = model.destinations.filter { $0.kind == .channel }
                if !bots.isEmpty {
                    Section("Bots") { destinationButtons(bots) }
                }
                if !channels.isEmpty {
                    Section("Channels") { destinationButtons(channels) }
                }
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: destinationIcon)
                        .font(.title3)
                        .foregroundStyle(.tint)
                        .frame(width: 30)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 7) {
                            Text(model.selectedDestination?.name ?? "Choose a bot or channel")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(.primary)
                            if model.isRememberedSelection {
                                Text("LAST USED")
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundStyle(.tint)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 3)
                                    .background(Color.accentColor.opacity(0.12), in: Capsule())
                            }
                        }
                        if let subtitle = model.selectedDestination?.subtitle {
                            Text(subtitle)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .padding(14)
                .cardStyle()
            }
            .buttonStyle(.plain)
            .disabled(!model.canEdit)
        }
    }

    @ViewBuilder
    private func destinationButtons(_ destinations: [ShareDestination]) -> some View {
        ForEach(destinations) { destination in
            Button {
                model.selectedDestinationID = destination.id
            } label: {
                if destination.id == model.selectedDestinationID {
                    Label(destination.name, systemImage: "checkmark")
                } else {
                    Text(destination.name)
                }
            }
        }
    }

    private var instructionField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Instruction (optional)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            TextField(
                "For example: summarize this and list the next steps",
                text: $model.instruction,
                axis: .vertical
            )
            .lineLimit(2...5)
            .padding(14)
            .cardStyle()
            .disabled(!model.canEdit)
        }
    }

    private func errorCard(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Couldn't send", systemImage: "wifi.exclamationmark")
                .font(.subheadline.weight(.semibold))
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                model.retry()
            } label: {
                Text(model.retrySendsPreparedMessage ? "Try sending again" : "Try again")
                    .font(.subheadline.weight(.semibold))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.orange.opacity(0.25), lineWidth: 1)
        }
    }

    private func compatibilityCard(_ message: String) -> some View {
        Label {
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "photo.badge.exclamationmark")
                .foregroundStyle(.orange)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 16))
    }

    private var footer: some View {
        Button {
            model.send()
        } label: {
            HStack(spacing: 8) {
                if model.phase == .sending { ProgressView().tint(.white) }
                Text(model.phase == .sending ? "Sending…" : "Send")
                    .fontWeight(.semibold)
                if model.phase != .sending { Image(systemName: "arrow.up") }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.roundedRectangle(radius: 14))
        .disabled(!model.canSend)
        .padding(16)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
    }

    private var destinationIcon: String {
        model.selectedDestination?.kind == .channel ? "person.2.fill" : "sparkles"
    }

    private func previewChip(_ title: String, icon: String) -> some View {
        Label(title, systemImage: icon)
            .font(.caption.weight(.medium))
            .lineLimit(1)
            .truncationMode(.middle)
            .frame(maxWidth: 220, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
    }

    private func icon(for name: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        if ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif"].contains(ext) {
            return "photo"
        }
        if ext == "pdf" { return "doc.richtext" }
        return "doc"
    }
}

private extension View {
    func cardStyle() -> some View {
        background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
            .overlay {
                RoundedRectangle(cornerRadius: 16)
                    .stroke(Color.primary.opacity(0.06), lineWidth: 1)
            }
    }
}

/// A tiny wrapping layout keeps several filenames readable without bringing
/// a third-party dependency into a system extension.
private struct FlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        layout(proposal: proposal, subviews: subviews).size
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let result = layout(proposal: proposal, subviews: subviews)
        for (index, point) in result.points.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y),
                anchor: .topLeading,
                proposal: .unspecified
            )
        }
    }

    private func layout(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, points: [CGPoint]) {
        let width = proposal.width ?? 320
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var points: [CGPoint] = []
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            points.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return (CGSize(width: width, height: y + rowHeight), points)
    }
}
