// Voice: the key that lets a bot talk, set from the phone.
//
// The desktop has this under App Settings → Voice. The credential lives on
// the computer, in the same config the desktop writes, so entering it here
// is the same as entering it there: one PUT, the server checks the key
// against ElevenLabs before saving, and the key never comes back in any
// response. What the phone shows afterwards is only whether one is on file.
import SwiftUI
import CompanionCore

struct VoiceSettingsView: View {
    @EnvironmentObject private var session: Session
    @State private var status: ConfigStatus?
    @State private var key = ""
    @State private var saving = false
    @State private var message: String?
    @State private var messageIsError = false

    private var configured: Bool { status?.isTTSConfigured == true }
    private var provider: String { status?.tts?.provider ?? "elevenlabs" }

    var body: some View {
        Form {
            Section {
                HStack {
                    Text("Status")
                    Spacer()
                    if let status {
                        Text(status.isTTSConfigured ? "Ready" : "Not set up")
                            .foregroundStyle(status.isTTSConfigured ? Color.green : Color.secondary)
                    } else {
                        ProgressView().controlSize(.small)
                    }
                }
                if provider == "system" {
                    Text("This computer is using its built-in voices. Switch to ElevenLabs to use a key from here.")
                        .font(.footnote)
                        .foregroundStyle(Color.secondary)
                    Button("Use ElevenLabs") { Task { await switchProvider("elevenlabs") } }
                        .disabled(saving)
                }
            } header: {
                Text("Calls and spoken replies")
            } footer: {
                Text("Calls use the voice set up on your computer. Each bot's voice is chosen on its profile.")
            }

            if provider != "system" {
                Section {
                    SecureField("ElevenLabs API key", text: $key)
                        .textContentType(.password)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    Button {
                        Task { await save() }
                    } label: {
                        HStack {
                            Text(configured ? "Replace key" : "Save key")
                            if saving { Spacer(); ProgressView().controlSize(.small) }
                        }
                    }
                    .disabled(saving || key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if configured {
                        Button("Remove key", role: .destructive) { Task { await remove() } }
                            .disabled(saving)
                    }
                } header: {
                    Text("ElevenLabs")
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        if let message {
                            Text(message).foregroundStyle(messageIsError ? Color.orange : Color.green)
                        }
                        Text("The key is checked and stored on your computer, never on this phone. Get one at elevenlabs.io → Settings → API Keys.")
                    }
                }
            }
        }
        .navigationTitle("Voice")
        .navigationBarTitleDisplayMode(.inline)
        .task { await refresh() }
    }

    private func refresh() async {
        status = await session.configStatus()
    }

    private func save() async {
        saving = true
        defer { saving = false }
        message = nil
        if let error = await session.updateVoiceKey(key) {
            message = error
            messageIsError = true
            return
        }
        key = ""
        message = "Key saved. Calls are ready."
        messageIsError = false
        await refresh()
    }

    private func remove() async {
        saving = true
        defer { saving = false }
        message = nil
        if let error = await session.updateVoiceKey("") {
            message = error
            messageIsError = true
            return
        }
        message = "Key removed."
        messageIsError = false
        await refresh()
    }

    private func switchProvider(_ provider: String) async {
        saving = true
        defer { saving = false }
        if let error = await session.updateVoiceProvider(provider) {
            message = error
            messageIsError = true
            return
        }
        await refresh()
    }
}
