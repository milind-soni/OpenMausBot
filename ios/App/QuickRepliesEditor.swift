// The composer's chip row, editable.
//
// The four chips the app shipped with are now just the default contents of
// a list you own: rename them, throw out the ones you never tap, add the
// prompt you actually type every day.
import SwiftUI
import CompanionCore

struct QuickRepliesEditor: View {
    @AppStorage(PrefKey.quickReplies) private var stored = ""
    @State private var editing: QuickReply?
    @State private var addingNew = false
    @State private var confirmingReset = false

    private var replies: [QuickReply] { QuickReply.decode(stored) }

    private func write(_ replies: [QuickReply]) {
        stored = QuickReply.encode(replies)
    }

    var body: some View {
        List {
            Section {
                ForEach(replies) { reply in
                    Button {
                        editing = reply
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: reply.icon)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Color.accentColor)
                                .frame(width: 22)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(reply.title)
                                    .font(.body)
                                Text(reply.prompt)
                                    .font(.caption)
                                    .foregroundStyle(Color.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(Color.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                }
                .onDelete { offsets in
                    var next = replies
                    next.remove(atOffsets: offsets)
                    write(next)
                }
                .onMove { from, to in
                    var next = replies
                    next.move(fromOffsets: from, toOffset: to)
                    write(next)
                }
            } header: {
                Text("Chips")
            } footer: {
                if replies.isEmpty {
                    Text("The chip row is hidden while this list is empty.")
                } else {
                    Text("Tap a chip to edit it. Drag to reorder, swipe to delete.")
                }
            }

            Section {
                Button {
                    addingNew = true
                } label: {
                    Label("Add Quick Reply", systemImage: "plus.circle.fill")
                }
                Button(role: .destructive) {
                    confirmingReset = true
                } label: {
                    Label("Reset to Defaults", systemImage: "arrow.counterclockwise")
                }
            }
        }
        .navigationTitle("Quick Replies")
        .toolbar { EditButton() }
        .sheet(item: $editing) { reply in
            QuickReplyForm(reply: reply) { updated in
                var next = replies
                if let index = next.firstIndex(where: { $0.id == updated.id }) { next[index] = updated }
                write(next)
            }
        }
        .sheet(isPresented: $addingNew) {
            QuickReplyForm(reply: QuickReply(title: "", prompt: "", icon: QuickReply.iconChoices[0])) { created in
                write(replies + [created])
            }
        }
        .confirmationDialog("Reset quick replies?", isPresented: $confirmingReset, titleVisibility: .visible) {
            Button("Reset to Defaults", role: .destructive) { write(QuickReply.defaults) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This restores the four chips the app came with and discards your own.")
        }
    }
}

/// Add and edit are the same form; only the title differs.
private struct QuickReplyForm: View {
    @State var reply: QuickReply
    let onSave: (QuickReply) -> Void
    @Environment(\.dismiss) private var dismiss

    private var titled: String {
        reply.title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var prompted: String {
        reply.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Label") {
                    TextField("Run tests", text: $reply.title)
                }
                Section {
                    TextField("Run all automated tests", text: $reply.prompt, axis: .vertical)
                        .lineLimit(2...6)
                } header: {
                    Text("Prompt")
                } footer: {
                    Text("What gets sent to the bot when you tap the chip.")
                }
                Section("Icon") {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 6), spacing: 14) {
                        ForEach(QuickReply.iconChoices, id: \.self) { icon in
                            Button {
                                reply.icon = icon
                                Haptics.selection()
                            } label: {
                                Image(systemName: icon)
                                    .font(.system(size: 16, weight: .semibold))
                                    .frame(width: 38, height: 34)
                                    .foregroundStyle(reply.icon == icon ? Color.white : Color.accentColor)
                                    .background(
                                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                                            .fill(reply.icon == icon ? Color.accentColor : Color.secondary.opacity(0.12))
                                    )
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(icon)
                            .accessibilityAddTraits(reply.icon == icon ? [.isSelected] : [])
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            .navigationTitle(titled.isEmpty ? Text("New Quick Reply") : Text(verbatim: titled))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        var saved = reply
                        saved.title = titled
                        saved.prompt = prompted
                        onSave(saved)
                        dismiss()
                    }
                    .disabled(titled.isEmpty || prompted.isEmpty)
                }
            }
        }
    }
}
