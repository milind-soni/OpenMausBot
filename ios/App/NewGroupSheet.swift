// Make a room from the phone: a name, and which bots are in it.
//
// The harness names it after the first member if the name is left blank,
// which is what the desktop's dialog does too — one rule, two screens.
import SwiftUI
import CompanionCore

struct NewGroupSheet: View {
    let created: (Room) -> Void
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var members = Set<String>()
    @State private var creating = false

    private var bots: [Bot] { session.state.bots.filter { $0.hidden != true } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Group name (optional)", text: $name)
                        .autocorrectionDisabled()
                }
                Section("Bots") {
                    ForEach(bots) { bot in
                        Button {
                            if members.contains(bot.id) { members.remove(bot.id) } else { members.insert(bot.id) }
                        } label: {
                            HStack(spacing: 12) {
                                BotAvatarView(bot: bot, size: 36, state: .idle, animated: false)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(bot.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(Color.primary)
                                    if !bot.title.isEmpty {
                                        Text(bot.title).font(.system(size: 13)).foregroundStyle(Color.secondary)
                                    }
                                }
                                Spacer()
                                Image(systemName: members.contains(bot.id) ? "checkmark.circle.fill" : "circle")
                                    .font(.system(size: 22))
                                    .foregroundStyle(members.contains(bot.id) ? MausPalette.color(bot.color) : Color.secondary.opacity(0.4))
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .navigationTitle("New group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        creating = true
                        Task {
                            // members in roster order, so the room's name (if
                            // it defaults) follows the first bot you picked
                            let ordered = bots.map(\.id).filter(members.contains)
                            if let room = await session.createRoom(name: name, memberIds: ordered) {
                                created(room)
                            }
                            creating = false
                        }
                    }
                    .disabled(members.isEmpty || creating)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
