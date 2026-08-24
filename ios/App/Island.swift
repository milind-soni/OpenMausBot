// The island: a black shape at the top of the screen, sitting where the
// hardware Dynamic Island is, that grows into a square with a bot's face
// alive inside it — and shrinks back into the island when it is done.
//
// Apps cannot draw inside the real island, so this is the same trick X
// uses: a black rounded square whose collapsed state hides behind the
// island (or, on phones without one, disappears into the top edge). The
// mascot engine does the rest — it already morphs every state and
// expression, which is what makes the square worth growing.
import SwiftUI
import CompanionCore

/// The hardware island's frame, in points from the top of the screen, on the
/// phones that have one. Used to hide the collapsed pill behind it.
enum IslandGeometry {
    static let size = CGSize(width: 126, height: 37)
    static let top: CGFloat = 11

    /// True on Dynamic Island phones: their top safe-area inset is 59.
    static func hasIsland(topInset: CGFloat) -> Bool { topInset >= 54 }

    /// The window's top safe-area inset — the one number that places
    /// anything relative to the screen's top edge.
    static var topInset: CGFloat {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first?.safeAreaInsets.top ?? 0
    }
}

/// The island shape, collapsed or expanded, with whatever is inside it.
struct IslandShell<Content: View>: View {
    let expanded: Bool
    let hasIsland: Bool
    var expandedSize = CGSize(width: 250, height: 330)
    @ViewBuilder let content: () -> Content

    var body: some View {
        let size = expanded ? expandedSize : IslandGeometry.size
        ZStack(alignment: .top) {
            RoundedRectangle(cornerRadius: expanded ? 56 : IslandGeometry.size.height / 2, style: .continuous)
                .fill(Color.black)
                // a hairline, so the square still reads as a shape on a dark
                // screen; invisible against the real island when collapsed
                .overlay(
                    RoundedRectangle(cornerRadius: expanded ? 56 : IslandGeometry.size.height / 2, style: .continuous)
                        .strokeBorder(Color.white.opacity(expanded ? 0.12 : 0), lineWidth: 1)
                )
            if expanded {
                content()
                    .frame(width: expandedSize.width, height: expandedSize.height)
                    .transition(.opacity.combined(with: .scale(scale: 0.92)))
            }
        }
        .frame(width: size.width, height: size.height)
        .clipShape(RoundedRectangle(cornerRadius: expanded ? 56 : IslandGeometry.size.height / 2, style: .continuous))
        // collapsed and no hardware island to hide behind: be gone entirely
        .opacity(expanded || hasIsland ? 1 : 0)
        .scaleEffect(expanded || hasIsland ? 1 : 0.6, anchor: .top)
        .padding(.top, IslandGeometry.top)
        .shadow(color: .black.opacity(expanded ? 0.45 : 0), radius: 28, y: 12)
        .ignoresSafeArea(edges: .top)
    }
}

/// The roster's island: when a bot stops for you, it grows with that bot's
/// face, the question, and the answers. Tap the face to open the chat.
struct NeedsYouIsland: View {
    let update: ChatUpdate?
    let hasIsland: Bool
    let open: (Chat) -> Void
    @EnvironmentObject private var session: Session
    @State private var shown: ChatUpdate?
    @State private var dismissedCardIds = Set<String>()
    @State private var answering = false
    // The comet face is the costliest draw in the app. It earns a beat of
    // motion when the island appears; an approval left unattended overnight
    // must not keep a 30fps orbit running until morning.
    @State private var attentionLive = true

    private var expanded: Bool { shown != nil }

    var body: some View {
        ZStack(alignment: .top) {
            if expanded {
                // tap anywhere else: put it away, keep the row's tag
                Color.black.opacity(0.001)
                    .ignoresSafeArea()
                    .onTapGesture { dismiss() }
            }
            IslandShell(expanded: expanded, hasIsland: hasIsland) {
                if let shown {
                    VStack(spacing: 10) {
                        // The hardware island covers the first 37pt of the
                        // square; the face sits clear of it, centred.
                        Button { open(shown.chat) } label: {
                            ChatAvatarView(chat: shown.chat, size: 120, state: MausState.forChat(shown.chat, in: session.state), animated: attentionLive, comets: attentionLive)
                        }
                        .buttonStyle(.plain)
                        .task(id: shown.chat.id) {
                            attentionLive = true
                            try? await Task.sleep(for: .seconds(30))
                            attentionLive = false
                        }
                        .padding(.top, IslandGeometry.size.height + 14)

                        VStack(spacing: 4) {
                            Label("\(shown.chat.name) needs you", systemImage: "hand.raised.fill")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(MausPalette.color(shown.chat.color))
                            Text(shown.line.isEmpty ? (shown.card?.title ?? "") : shown.line)
                                .font(.system(size: 15))
                                .foregroundStyle(.white)
                                .multilineTextAlignment(.center)
                                .lineLimit(3)
                                .padding(.horizontal, 20)
                        }

                        if let card = shown.card, card.isPending {
                            HStack(spacing: 8) {
                                ForEach(card.options, id: \.self) { option in
                                    Button {
                                        answering = true
                                        Task {
                                            await session.answer(chat: shown.chat, card: card, choice: option)
                                            answering = false
                                            dismiss()
                                        }
                                    } label: {
                                        Text(option)
                                            .font(.system(size: 15, weight: .semibold))
                                            .foregroundStyle(CardStyle.isRefusal(option) ? .white : .white)
                                            .frame(maxWidth: .infinity)
                                            .frame(height: 40)
                                            .background(
                                                Capsule().fill(CardStyle.isRefusal(option) ? Color.white.opacity(0.16) : MausPalette.color(shown.chat.color))
                                            )
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(answering)
                                }
                            }
                            .padding(.horizontal, 20)
                            .padding(.bottom, 18)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .top)
        .animation(.spring(response: 0.55, dampingFraction: 0.78), value: expanded)
        .onChange(of: update?.card?.requestId) { _, _ in reconcile() }
        .onAppear { reconcile() }
    }

    /// Show a new needs-you the moment it lands; never re-show one the user
    /// put away; fold away when it is answered elsewhere.
    private func reconcile() {
        guard let update, update.kind == .needsYou, let id = update.card?.requestId else {
            shown = nil
            return
        }
        if dismissedCardIds.contains(id) { shown = nil; return }
        shown = update
    }

    private func dismiss() {
        if let id = shown?.card?.requestId { dismissedCardIds.insert(id) }
        shown = nil
    }
}
