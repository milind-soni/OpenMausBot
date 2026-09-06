import AVFAudio
import CompanionCore
import PhotosUI
import SwiftUI

/// The paired-safe subset of bot settings. Shared provider keys remain on the
/// computer; the phone sees only the model catalog, configured/not-configured
/// status, and renderer-neutral profile operations.
struct AgentProfileView: View {
    let bot: Bot

    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var title: String
    @State private var description: String
    @State private var notifications: Bool
    @State private var crop: AvatarCrop
    @State private var voice: String
    @State private var speakReplies: Bool
    @State private var photo: PhotosPickerItem?
    @State private var prompt = ""
    @State private var voices: [Voice] = []
    @State private var config: ConfigStatus?
    @State private var instances: [Instance] = []
    @State private var modelsLoaded = false
    @State private var selectedInstanceID: String
    @State private var selectedModelID: String
    @State private var selectedEffort: String?
    @State private var savedModel: ModelSelection
    @State private var busy = false
    @State private var player: AVAudioPlayer?
    @State private var baseline: ProfileFormSnapshot

    init(bot: Bot) {
        self.bot = bot
        _name = State(initialValue: bot.name)
        _title = State(initialValue: bot.title)
        _description = State(initialValue: bot.description)
        _notifications = State(initialValue: bot.notifications)
        _crop = State(initialValue: bot.avatarCrop ?? .mascot)
        _voice = State(initialValue: bot.voice ?? "")
        _speakReplies = State(initialValue: bot.speakReplies == true)
        _selectedInstanceID = State(initialValue: bot.modelSelection.instanceId)
        _selectedModelID = State(initialValue: bot.modelSelection.model)
        _selectedEffort = State(initialValue: bot.modelSelection.effort)
        _savedModel = State(initialValue: bot.modelSelection)
        _baseline = State(initialValue: ProfileFormSnapshot(bot: bot))
    }

    private var current: Bot { session.state.bot(bot.id) ?? bot }
    private var imageGenerationReady: Bool { config?.imageGen?.configured == true }
    private var voiceConfigured: Bool { config?.isTTSConfigured == true }
    private var hasWorkspaceDefaultVoice: Bool { config?.hasWorkspaceDefaultVoice == true }
    private var selectedVoiceCanSpeak: Bool { config?.canSpeak(agentVoice: voice) == true }
    private var selectedInstance: Instance? {
        instances.first { $0.instanceId == selectedInstanceID }
    }
    private var availableInstances: [Instance] { instances.filter(\.snapshot.isAvailable) }
    private var instanceChoices: [Instance] {
        guard let currentInstance = instances.first(where: { $0.instanceId == savedModel.instanceId }),
              !currentInstance.snapshot.isAvailable
        else { return availableInstances }
        return [currentInstance] + availableInstances
    }
    private var selectedModelChoices: [ModelChoice] {
        guard let instance = selectedInstance else {
            return selectedModelID.isEmpty ? [] : [ModelChoice(id: selectedModelID, label: selectedModelID)]
        }
        var seen = Set<String>()
        var choices: [ModelChoice] = []
        let defaultOption = instance.models.options.first { $0.id == instance.models.default }
        if !instance.models.default.isEmpty {
            seen.insert(instance.models.default)
            choices.append(ModelChoice(
                id: instance.models.default,
                label: defaultOption?.label ?? instance.models.default
            ))
        }
        for option in instance.models.options where seen.insert(option.id).inserted {
            choices.append(ModelChoice(id: option.id, label: option.label))
        }
        if !selectedModelID.isEmpty, seen.insert(selectedModelID).inserted {
            choices.append(ModelChoice(id: selectedModelID, label: selectedModelID))
        }
        return choices
    }
    private var effortLevels: [String] {
        var seen = Set<String>()
        return (selectedInstance?.capabilities?.effortLevels ?? []).filter {
            !$0.isEmpty && seen.insert($0).inserted
        }
    }
    private var modelDraft: ModelSelection {
        ModelSelection(instanceId: selectedInstanceID, model: selectedModelID, effort: selectedEffort)
    }
    private var canApplyModel: Bool {
        guard modelsLoaded, current.busy != true,
              let selectedInstance, selectedInstance.snapshot.isAvailable
        else { return false }
        let modelIsOffered = selectedModelID == selectedInstance.models.default
            || selectedInstance.models.options.contains { $0.id == selectedModelID }
        let effortIsOffered = selectedEffort.map(effortLevels.contains) ?? true
        return modelIsOffered && effortIsOffered && modelDraft != savedModel
    }
    /// Which engine's words to use. An unloaded status is ElevenLabs for the
    /// same reason a missing `provider` is: that is the server's own fallback,
    /// and the copy that shipped.
    private var usesSystemVoices: Bool { config?.voiceProvider == .system }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if !modelsLoaded {
                        HStack {
                            Text("Loading models")
                            Spacer()
                            ProgressView()
                        }
                    } else if instanceChoices.isEmpty {
                        Label("No model providers are available", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.secondary)
                    } else {
                        Picker("Provider", selection: $selectedInstanceID) {
                            if !instances.contains(where: { $0.instanceId == selectedInstanceID }) {
                                Text("Current provider (unavailable)")
                                    .tag(selectedInstanceID)
                                    .disabled(true)
                            }
                            ForEach(instanceChoices) { instance in
                                Text(instanceLabel(instance))
                                    .tag(instance.instanceId)
                                    .disabled(!instance.snapshot.isAvailable)
                            }
                        }
                        .onChange(of: selectedInstanceID) { _, instanceID in
                            selectDefaults(for: instanceID)
                        }

                        Picker("Model", selection: $selectedModelID) {
                            ForEach(selectedModelChoices) { option in
                                Text(option.label).tag(option.id)
                            }
                        }
                        .disabled(selectedInstance?.snapshot.isAvailable != true)

                        if !effortLevels.isEmpty {
                            Picker("Reasoning effort", selection: $selectedEffort) {
                                Text("Default").tag(String?.none)
                                ForEach(effortLevels, id: \.self) { level in
                                    Text(effortLabel(level)).tag(Optional(level))
                                }
                            }
                        }

                        if current.busy == true {
                            Label("Stop this bot before changing its model.", systemImage: "hourglass")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        } else if selectedInstance?.snapshot.isAvailable != true {
                            Label("Choose an available provider to change this bot's model.", systemImage: "info.circle")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }

                        Button("Apply model", systemImage: "checkmark") {
                            Task { await saveModel() }
                        }
                        .disabled(busy || !canApplyModel)
                    }
                } header: {
                    Text("Model")
                } footer: {
                    Text("Provider accounts and API keys stay on your computer. Default sends no reasoning level and lets the provider decide.")
                }

                Section {
                    HStack {
                        Spacer()
                        BotAvatarView(bot: current, size: 112, state: .happy, animated: true)
                        Spacer()
                    }
                    .listRowBackground(Color.clear)

                    Picker("Shape", selection: $crop) {
                        ForEach(AvatarCrop.allCases, id: \.self) { shape in
                            Text(shape.label).tag(shape)
                        }
                    }
                    .pickerStyle(.segmented)

                    PhotosPicker(selection: $photo, matching: .images) {
                        Label("Upload image", systemImage: "photo.badge.plus")
                    }
                    .disabled(busy)

                    if current.avatarUrl != nil {
                        Button("Use mascot", systemImage: "trash", role: .destructive) {
                            Task { await clearImage() }
                        }
                        .disabled(busy)
                    }
                } header: {
                    Text("Avatar")
                } footer: {
                    Text("PNG, JPEG, GIF, or WebP, up to 10 MB. Images are stored on your paired computer and loaded with this device's pairing token.")
                }

                Section {
                    TextField("Art direction", text: $prompt, axis: .vertical)
                        .lineLimit(2...5)
                    Button("Generate on computer", systemImage: "sparkles") {
                        Task { await generateImage() }
                    }
                    .disabled(busy || !imageGenerationReady || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } header: {
                    Text("Generate an avatar")
                } footer: {
                    Text(imageGenerationReady
                         ? "Generation uses the shared image provider configured on your computer. No provider key is sent to or stored on this device."
                         : "To generate images, configure the shared image provider in OpenMausBot on your computer. Provider keys cannot be added from this device.")
                }

                Section("Identity") {
                    NavigationLink {
                        BotOverviewView(bot: current)
                    } label: {
                        Label("What this bot does", systemImage: "list.bullet.rectangle")
                    }
                    TextField("Name", text: $name)
                        .textInputAutocapitalization(.words)
                    TextField("Title", text: $title)
                    TextField("What this agent does", text: $description, axis: .vertical)
                        .lineLimit(3...8)
                    Toggle("Agent notifications", isOn: $notifications)
                }

                Section {
                    if voiceConfigured {
                        Picker("Voice", selection: $voice) {
                            if hasWorkspaceDefaultVoice {
                                Text("Workspace default").tag("")
                            } else {
                                Text("Choose an agent voice").tag("").disabled(true)
                            }
                            if !voice.isEmpty, !voices.contains(where: { $0.id == voice }) {
                                Text("Current agent voice").tag(voice)
                            }
                            ForEach(voices) { option in
                                VStack(alignment: .leading) {
                                    Text(option.label)
                                    if let detail = option.description { Text(detail) }
                                }
                                .tag(option.id)
                            }
                        }
                        Toggle("Speak replies", isOn: $speakReplies)
                            .disabled(!selectedVoiceCanSpeak)
                        Button("Preview voice", systemImage: "speaker.wave.2") {
                            Task { await previewVoice() }
                        }
                        .disabled(busy || !selectedVoiceCanSpeak)

                        if !hasWorkspaceDefaultVoice, voice.isEmpty {
                            Label("Pick a voice for this agent before enabling speech.", systemImage: "info.circle")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    } else if usesSystemVoices {
                        Label("Built-in Mac voices are unavailable", systemImage: "speaker.slash")
                            .foregroundStyle(.secondary)
                    } else {
                        Label("ElevenLabs is not configured", systemImage: "speaker.slash")
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Voice")
                } footer: {
                    if !voiceConfigured {
                        // Under the built-in engine "not configured" is not a
                        // missing credential — there is none — so the remedy
                        // cannot be a key. `providerConfigured` in
                        // `server/tts/index.ts` is reporting that this
                        // computer has no built-in voices to speak with.
                        if usesSystemVoices {
                            Text("Built-in Mac voices need no key, and this computer has none available. Switch the voice engine to ElevenLabs in this agent's profile on the computer to keep using voice.")
                        } else {
                            Text("Add the shared ElevenLabs key in this agent's profile on the computer. The key is never returned to iOS.")
                        }
                    } else if !hasWorkspaceDefaultVoice {
                        if usesSystemVoices {
                            Text("No workspace default voice is selected. Choose an agent-specific voice above; synthesis still uses the built-in Mac voices on your computer.")
                        } else {
                            Text("No workspace default voice is selected. Choose an agent-specific voice above; synthesis still uses the shared ElevenLabs key on your computer.")
                        }
                    } else {
                        Text("The voice choice belongs to this agent. Workspace default uses the shared voice selected on your computer.")
                    }
                }

                Section {
                    Button("Save profile changes") { Task { await save() } }
                        .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .navigationTitle("Bot settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
            .overlay { if busy { ProgressView().controlSize(.large) } }
            .task {
                async let status = session.configStatus()
                async let options = session.voiceOptions()
                async let catalog = session.modelInstances()
                let (loadedConfig, loadedVoices, loadedInstances) = await (status, options, catalog)
                config = loadedConfig
                voices = loadedVoices
                instances = loadedInstances
                modelsLoaded = true
                if let loadedConfig, !loadedConfig.canSpeak(agentVoice: voice) {
                    speakReplies = false
                }
            }
            .onChange(of: photo) { _, item in
                guard let item else { return }
                Task { await upload(item) }
            }
        }
    }

    private func profilePatch() -> BotProfilePatch {
        let savedSpeakReplies = config.map { $0.canSpeak(agentVoice: voice) && speakReplies } ?? speakReplies
        return BotProfilePatch(
            // The shared server contract owns the 100/200/4000 limits. Do not
            // silently apply narrower iOS-only limits to a user's profile.
            name: name == baseline.name ? nil : name.trimmingCharacters(in: .whitespacesAndNewlines),
            title: title == baseline.title ? nil : title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description == baseline.description
                ? nil : description.trimmingCharacters(in: .whitespacesAndNewlines),
            notifications: notifications == baseline.notifications ? nil : notifications,
            avatarCrop: crop == baseline.crop ? nil : crop,
            // Empty is the server's explicit "use workspace default" value;
            // nil would mean the voice field is not part of this patch.
            voice: voice == baseline.voice ? nil : voice,
            speakReplies: savedSpeakReplies == baseline.speakReplies ? nil : savedSpeakReplies
        )
    }

    private func save() async {
        busy = true
        if let updated = await session.updateProfile(profilePatch(), for: current) {
            synchronizeForm(with: updated)
        }
        busy = false
    }

    private func saveModel() async {
        guard canApplyModel else { return }
        busy = true
        defer { busy = false }
        if let updated = await session.updateModel(modelDraft, for: current) {
            selectedInstanceID = updated.modelSelection.instanceId
            selectedModelID = updated.modelSelection.model
            selectedEffort = updated.modelSelection.effort
            savedModel = updated.modelSelection
        }
    }

    private func selectDefaults(for instanceID: String) {
        guard let instance = instances.first(where: { $0.instanceId == instanceID }) else { return }
        if instanceID == savedModel.instanceId {
            selectedModelID = savedModel.model
            let supported = instance.capabilities?.effortLevels ?? []
            selectedEffort = savedModel.effort.flatMap { supported.contains($0) ? $0 : nil }
        } else {
            selectedModelID = instance.models.default
            selectedEffort = nil
        }
    }

    private func instanceLabel(_ instance: Instance) -> String {
        let base = instance.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = base.flatMap { $0.isEmpty ? nil : $0 } ?? instance.instanceId
        return instance.snapshot.isAvailable ? name : "\(name) (Unavailable)"
    }

    private func effortLabel(_ effort: String) -> String {
        switch effort.lowercased() {
        case "xhigh": "X-High"
        default: effort.capitalized
        }
    }

    private func clearImage() async {
        busy = true
        defer { busy = false }
        if let updated = await session.updateProfile(
            BotProfilePatch(avatarUrl: .clear, avatarCrop: .mascot),
            for: current
        ) {
            crop = updated.avatarCrop ?? .mascot
            baseline.crop = crop
        }
    }

    private func upload(_ item: PhotosPickerItem) async {
        busy = true
        defer { busy = false; photo = nil }
        guard let data = try? await item.loadTransferable(type: Data.self),
              let mime = Self.imageMIME(data)
        else {
            session.actionError = "Choose a PNG, JPEG, GIF, or WebP image."
            return
        }
        if data.count > 10 * 1_024 * 1_024 {
            session.actionError = "That image is larger than 10 MB."
            return
        }
        let intendedCrop = crop == .mascot ? AvatarCrop.circle : crop
        if let updated = await session.uploadAvatar(data, mime: mime, for: current, crop: intendedCrop) {
            crop = updated.avatarCrop ?? intendedCrop
            baseline.crop = crop
        }
    }

    private func generateImage() async {
        busy = true
        defer { busy = false }
        // What the selector said when the request went out. The desktop
        // compares the same way (`latestCrop === cropAtStart` in
        // `src/components/BotProfileAvatarCard.tsx`) so a selector moved
        // mid-flight still wins over the server's pick.
        let cropAtStart = crop
        guard let generated = await session.generateAvatar(
            prompt: String(prompt.trimmingCharacters(in: .whitespacesAndNewlines).prefix(400)),
            for: current
        ) else { return }

        // `AvatarCrop.afterGenerating` is the shared decision: the server's
        // pick unless the selector moved while the request was in flight, in
        // which case that newer explicit choice wins.
        let resolved = AvatarCrop.afterGenerating(
            cropAtStart: cropAtStart,
            latestCrop: crop,
            serverCrop: generated.avatarCrop
        )

        guard crop != cropAtStart else {
            crop = resolved
            baseline.crop = crop
            return
        }

        // The user moved the selector while the image was generating: an
        // explicit choice made after the request, so persist it against the
        // returned attachment rather than leaving UI and server out of sync.
        if let updated = await session.updateProfile(BotProfilePatch(avatarCrop: resolved), for: generated) {
            crop = updated.avatarCrop ?? resolved
        } else {
            // Generation itself succeeded. Reflect its authoritative result
            // rather than claiming the requested crop was persisted. A `nil`
            // crop here matches `afterGenerating`'s own fallback: `.circle`,
            // not `.mascot`, which would throw away the picture just
            // generated.
            crop = generated.avatarCrop ?? .circle
        }
        baseline.crop = crop
    }

    private func previewVoice() async {
        guard selectedVoiceCanSpeak else {
            session.actionError = "Pick an agent voice or configure a workspace default on your computer first."
            return
        }
        busy = true
        defer { busy = false }
        guard let data = await session.previewVoice(voice, for: current) else { return }
        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playback, mode: .spokenAudio)
            try audioSession.setActive(true)

            let nextPlayer = try AVAudioPlayer(data: data)
            guard nextPlayer.prepareToPlay(), nextPlayer.play() else {
                try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
                player = nil
                session.actionError = "The generated audio could not be played."
                return
            }
            player = nextPlayer
        } catch {
            player = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            session.actionError = "The generated audio could not be played."
        }
    }

    private static func imageMIME(_ data: Data) -> String? {
        let bytes = [UInt8](data.prefix(12))
        if bytes.starts(with: [0x89, 0x50, 0x4e, 0x47]) { return "image/png" }
        if bytes.starts(with: [0xff, 0xd8, 0xff]) { return "image/jpeg" }
        if bytes.starts(with: Array("GIF8".utf8)) { return "image/gif" }
        if bytes.count >= 12,
           String(bytes: bytes[0..<4], encoding: .ascii) == "RIFF",
           String(bytes: bytes[8..<12], encoding: .ascii) == "WEBP" { return "image/webp" }
        return nil
    }

    private func synchronizeForm(with bot: Bot) {
        name = bot.name
        title = bot.title
        description = bot.description
        notifications = bot.notifications
        crop = bot.avatarCrop ?? .mascot
        voice = bot.voice ?? ""
        speakReplies = bot.speakReplies == true
        baseline = ProfileFormSnapshot(bot: bot)
    }
}

private struct ModelChoice: Identifiable {
    let id: String
    let label: String
}

private struct ProfileFormSnapshot {
    var name: String
    var title: String
    var description: String
    var notifications: Bool
    var crop: AvatarCrop
    var voice: String
    var speakReplies: Bool

    init(bot: Bot) {
        name = bot.name
        title = bot.title
        description = bot.description
        notifications = bot.notifications
        crop = bot.avatarCrop ?? .mascot
        voice = bot.voice ?? ""
        speakReplies = bot.speakReplies == true
    }
}

private extension AvatarCrop {
    var label: String {
        switch self {
        case .mascot: "Mascot"
        case .circle: "Circle"
        case .rounded: "Rounded"
        case .square: "Square"
        }
    }
}
