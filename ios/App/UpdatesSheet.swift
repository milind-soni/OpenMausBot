// What the Updates pill opens: the active bots, grouped by what they need.
//
// Needs you first, with the answer right there — the phone exists so that
// a stopped bot on the laptop can be un-stopped from wherever you are.
// Then what is working, then what finished while you were not looking.
import SwiftUI
import CompanionCore

struct UpdatesSheet: View {
    let open: (Chat) -> Void
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss

    private var updates: [ChatUpdate] { session.state.updates }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Updates")
                        .font(.system(size: 22, weight: .bold))
                    Spacer()
                    Text(updates.isEmpty ? "All quiet" : "\(updates.count) active")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.secondary)
                }
                .padding(.horizontal, 20)
                .padding(.top, 22)
                .padding(.bottom, 6)

                if updates.isEmpty {
                    ContentUnavailableView(
                        "Nothing needs you",
                        systemImage: "checkmark.circle",
                        description: Text("When a bot stops for an answer, is mid-task, or finishes something, it shows up here.")
                    )
                    .padding(.top, 24)
                } else {
                    section("Needs you", tint: nil, kind: .needsYou)
                    section("Working", tint: nil, kind: .working)
                    section("To review", tint: nil, kind: .toReview)
                }
            }
            .padding(.bottom, 24)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(.thinMaterial)
        .presentationCornerRadius(28)
    }

    @ViewBuilder
    private func section(_ title: LocalizedStringKey, tint: Color?, kind: ChatUpdate.Kind) -> some View {
        let items = updates.filter { $0.kind == kind }
        if !items.isEmpty {
            let color = kind == .needsYou ? MausPalette.color(items[0].chat.color) : Color.secondary
            Text(title)
                .textCase(.uppercase)
                .font(.system(size: 12, weight: .bold))
                .tracking(0.5)
                .foregroundStyle(color)
                .padding(.horizontal, 20)
                .padding(.top, 14)
                .padding(.bottom, 2)

            ForEach(items) { update in
                UpdateRow(update: update) { open(update.chat) }
            }
        }
    }
}

private struct UpdateRow: View {
    let update: ChatUpdate
    let open: () -> Void
    @EnvironmentObject private var session: Session
    @State private var answering = false

    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: 12) {
                ChatAvatarView(chat: update.chat, size: 40, state: MausState.forChat(update.chat, in: session.state))

                VStack(alignment: .leading, spacing: 3) {
                    Text(update.chat.name)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.primary)
                    Text(update.line.isEmpty ? " " : update.line)
                        .font(.system(size: 14))
                        .foregroundStyle(Color.secondary)
                        .lineLimit(update.kind == .needsYou ? 3 : 1)
                        .multilineTextAlignment(.leading)

                    if update.kind == .needsYou, let card = update.card, card.isPending {
                        if card.skillRequest != nil {
                            Label("Open the chat to review SKILL.md", systemImage: "doc.text.magnifyingglass")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Color.secondary)
                                .padding(.top, 6)
                        } else {
                            // The answers, as pills, exactly the options the card
                            // offered — never a choice invented here.
                            HStack(spacing: 8) {
                                ForEach(card.options, id: \.self) { option in
                                    Button {
                                        Haptics.selection()
                                        answering = true
                                        Task {
                                            await session.answer(chat: update.chat, card: card, choice: option)
                                            answering = false
                                        }
                                    } label: {
                                        Text(option)
                                            .font(.system(size: 13, weight: .semibold))
                                            .foregroundStyle(CardStyle.isRefusal(option) ? Color.primary : .white)
                                            .padding(.horizontal, 14)
                                            .frame(height: 32)
                                            .background(
                                                Capsule().fill(
                                                    CardStyle.isRefusal(option)
                                                        ? Color.secondary.opacity(0.18)
                                                        : MausPalette.color(update.chat.color)
                                                )
                                            )
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(answering)
                                }
                            }
                            .padding(.top, 6)
                        }
                    }
                }

                Spacer(minLength: 0)

                switch update.kind {
                case .needsYou:
                    EmptyView()
                case .working:
                    ProgressView().controlSize(.small).padding(.top, 10)
                case .toReview:
                    HStack(spacing: 6) {
                        Circle().fill(MausPalette.color(update.chat.color)).frame(width: 10, height: 10)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.secondary.opacity(0.5))
                    }
                    .padding(.top, 12)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// One definition of "the refusal", shared by every place a card's options
/// are drawn as buttons, so the tints cannot drift apart.
enum CardStyle {
    static func isRefusal(_ option: String) -> Bool {
        OptionCard.isRefusal(option)
    }
}
