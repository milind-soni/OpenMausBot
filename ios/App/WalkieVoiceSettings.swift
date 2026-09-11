// Walkie's voice: the ElevenLabs key it speaks with and which voice it uses.
//
// The key is pasted once and kept in this phone's Keychain — never in
// defaults, never sent to the computer. It is checked against ElevenLabs
// before it is saved, so a bad key fails at the paste rather than on the
// first reply.
import CompanionCore
import Security
import SwiftUI
import UIKit

enum WalkieVoicePrefs {
    static let voiceId = "walkie.voiceId"
    static let useAgentVoices = "walkie.useAgentVoices"
}

enum WalkieVoiceKey {
    private static let service = "com.openmausbot.walkie.elevenlabs"
    private static let account = "api-key"

    private static var identity: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    static func read() -> String? {
        var query = identity
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let key = String(data: data, encoding: .utf8),
              !key.isEmpty else { return nil }
        return key
    }

    @discardableResult
    static func save(_ key: String) -> Bool {
        let data = Data(key.utf8)
        var status = SecItemUpdate(identity as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = identity
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        return status == errSecSuccess
    }

    static func remove() {
        SecItemDelete(identity as CFDictionary)
    }
}

struct WalkieVoiceSheet: View {
    /// Play a short sample with the current settings.
    let onSample: () -> Void

    @Environment(\.dismiss) private var dismiss
    @AppStorage(WalkieVoicePrefs.voiceId) private var voiceId = ""
    @AppStorage(WalkieVoicePrefs.useAgentVoices) private var useAgentVoices = true
    @State private var keyDraft = ""
    @State private var hasKey = WalkieVoiceKey.read() != nil
    @State private var voices: [ElevenLabs.Voice] = []
    @State private var problem: String?
    @State private var checking = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if hasKey {
                        LabeledContent("ElevenLabs key", value: String(localized: "Saved on this phone"))
                        Button("Remove key", role: .destructive) {
                            WalkieVoiceKey.remove()
                            hasKey = false
                            voices = []
                        }
                    } else {
                        SecureField("ElevenLabs API key", text: $keyDraft)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Paste from clipboard", systemImage: "doc.on.clipboard") {
                            keyDraft = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                        }
                        Button {
                            Task { await saveKey() }
                        } label: {
                            HStack {
                                Text("Check and save")
                                if checking { Spacer(); ProgressView() }
                            }
                        }
                        .disabled(keyDraft.trimmingCharacters(in: .whitespaces).isEmpty || checking)
                    }
                } header: {
                    Text("ElevenLabs")
                } footer: {
                    Text("Replies are spoken by ElevenLabs straight from this phone. The key stays in this phone's Keychain. Get one at elevenlabs.io → Developers → API keys.")
                }

                if let problem {
                    Section {
                        Label(problem, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Color.orange)
                    }
                }

                if hasKey {
                    Section {
                        Toggle("Each agent speaks in its own voice", isOn: $useAgentVoices)
                        Picker("Voice", selection: $voiceId) {
                            Text("George (default)").tag("")
                            ForEach(voices) { voice in
                                Text(voice.detail.map { "\(voice.name) · \($0)" } ?? voice.name).tag(voice.id)
                            }
                        }
                        Button("Play a sample", systemImage: "play.circle", action: onSample)
                    } header: {
                        Text("Who speaks")
                    } footer: {
                        Text("Agents with a voice picked on your computer use it when this is on. Everyone else uses the voice above.")
                    }
                }
            }
            .navigationTitle("Walkie voice")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await loadVoices() }
        }
    }

    private func saveKey() async {
        let key = keyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        checking = true
        defer { checking = false }
        do {
            let list = try await ElevenLabs.voices(key: key)
            guard WalkieVoiceKey.save(key) else {
                problem = String(localized: "Couldn't save the key to this phone's Keychain.")
                return
            }
            voices = list
            keyDraft = ""
            problem = nil
            hasKey = true
        } catch {
            problem = error.localizedDescription
        }
    }

    private func loadVoices() async {
        guard let key = WalkieVoiceKey.read() else { return }
        do {
            voices = try await ElevenLabs.voices(key: key)
        } catch {
            problem = error.localizedDescription
        }
    }
}
