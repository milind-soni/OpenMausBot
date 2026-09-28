/// The provider-dependent part of an open agent-profile form.
///
/// Voice identifiers belong to one provider. A successful provider switch
/// clears them on the server, so an already-open phone sheet must clear both
/// its draft and comparison baseline before it can preview or save again.
public struct AgentProfileVoiceState: Equatable, Sendable {
    public let voice: String
    public let speakReplies: Bool
    public let baselineVoice: String

    public init(voice: String, speakReplies: Bool, baselineVoice: String) {
        self.voice = voice
        self.speakReplies = speakReplies
        self.baselineVoice = baselineVoice
    }

    public func afterProviderSwitch(to config: ConfigStatus) -> Self {
        let clearedVoice = ""
        return Self(
            voice: clearedVoice,
            speakReplies: speakReplies && config.canSpeak(agentVoice: clearedVoice),
            baselineVoice: clearedVoice
        )
    }
}
