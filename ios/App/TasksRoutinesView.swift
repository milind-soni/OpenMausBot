import CompanionCore
import SwiftUI

struct TasksRoutinesView: View {
    @EnvironmentObject private var session: Session
    @State private var routines: [Routine] = []
    @State private var runs: [RoutineRun] = []
    @State private var editor: RoutineEditorTarget?
    @State private var deleting: Routine?
    @State private var loading = true

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Thread = one conversation and result", systemImage: "bubble.left.and.text.bubble.right")
                    Label("Routine = scheduled work with one results thread", systemImage: "calendar.badge.clock")
                }
                .font(.subheadline)
            } footer: {
                Text("No cron syntax. Every run uses the agent's existing model, tools, permissions, computer, and connected apps. Times follow the paired computer's local timezone.")
            }

            Section("Routines") {
                if routines.isEmpty && !loading {
                    ContentUnavailableView("No routines", systemImage: "calendar.badge.plus", description: Text("Schedule recurring or one-time agent work."))
                }
                ForEach(routines) { routine in
                    let canToggle = routine.canToggle()
                    RoutineRow(routine: routine, bot: session.state.bot(routine.botId))
                        .contentShape(Rectangle())
                        .onTapGesture { editor = .edit(routine) }
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            if canToggle {
                                Button(routine.enabled ? "Pause" : "Resume") {
                                    Task { await toggle(routine) }
                                }
                                .tint(routine.enabled ? .orange : .green)
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            Button("Delete", role: .destructive) { deleting = routine }
                            Button("Run now") { Task { await runNow(routine) } }.tint(.blue)
                        }
                        .contextMenu {
                            Button("Run now", systemImage: "play.fill") { Task { await runNow(routine) } }
                            if canToggle {
                                Button(routine.enabled ? "Pause" : "Resume", systemImage: routine.enabled ? "pause" : "play") {
                                    Task { await toggle(routine) }
                                }
                            }
                            Button("Edit", systemImage: "pencil") { editor = .edit(routine) }
                            Button("Delete", systemImage: "trash", role: .destructive) { deleting = routine }
                        }
                }
            }

            Section("Run receipts") {
                if runs.isEmpty && !loading {
                    Text("Completed, waiting, failed, and manually started runs appear here.")
                        .foregroundStyle(.secondary)
                }
                ForEach(runs.sorted(by: { $0.scheduledFor > $1.scheduledFor }).prefix(50)) { run in
                    RoutineRunRow(run: run, bot: session.state.bot(run.botId))
                }
            }

            Section {
                Label("Computer only", systemImage: "lock.desktopcomputer")
                    .foregroundStyle(.secondary)
            } header: {
                Text("Webhooks")
            } footer: {
                Text("Creating or rotating a webhook changes an internet-reachable trigger and signing secret, so webhook management remains on the paired computer. Webhook run receipts still appear above.")
            }
        }
        .navigationTitle("Threads & Routines")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New routine", systemImage: "plus") { editor = .new }
            }
        }
        .task { await reload() }
        .refreshable { await reload() }
        .sheet(item: $editor) { target in
            RoutineEditorView(routine: target.routine) { await reload() }
        }
        .confirmationDialog(
            "Delete \(deleting?.name ?? "this routine")?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete routine", role: .destructive) {
                guard let routine = deleting else { return }
                Task {
                    if await session.deleteRoutine(routine) { await reload() }
                    deleting = nil
                }
            }
        } message: {
            Text("Past run receipts remain available.")
        }
    }

    private func reload() async {
        loading = true
        let loaded = await session.loadRoutines()
        routines = loaded.routines.sorted { ($0.nextRunAt ?? .greatestFiniteMagnitude) < ($1.nextRunAt ?? .greatestFiniteMagnitude) }
        runs = loaded.runs
        loading = false
    }

    private func toggle(_ routine: Routine) async {
        guard routine.canToggle() else { return }
        _ = await session.setRoutineEnabled(routine, enabled: !routine.enabled)
        await reload()
    }

    private func runNow(_ routine: Routine) async {
        _ = await session.runRoutine(routine)
        await reload()
    }
}

private enum RoutineEditorTarget: Identifiable {
    case new
    case edit(Routine)
    var id: String { routine?.id ?? "new" }
    var routine: Routine? { if case let .edit(value) = self { value } else { nil } }
}

private struct RoutineRow: View {
    let routine: Routine
    let bot: Bot?

    var body: some View {
        let canToggle = routine.canToggle()
        HStack(spacing: 12) {
            if let bot { BotAvatarView(bot: bot, size: 42, state: routine.enabled ? .idle : .sleeping, animated: false) }
            else { Image(systemName: "calendar.badge.exclamationmark").frame(width: 42, height: 42) }
            VStack(alignment: .leading, spacing: 3) {
                Text(routine.name).font(.headline)
                ((bot.map { Text(verbatim: $0.name) } ?? Text("Deleted agent"))
                    + Text(verbatim: " · \(routine.schedule.summary) · ")
                    + Text(LocalizedStringKey(routine.runLocation.label)))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer()
            if !routine.enabled {
                Image(systemName: canToggle ? "pause.circle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(canToggle ? .orange : .secondary)
                    .accessibilityLabel(canToggle ? "Paused" : "Completed")
            }
        }
    }
}

private struct RoutineRunRow: View {
    let run: RoutineRun
    let bot: Bot?
    @EnvironmentObject private var session: Session

    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 8) {
                if let output = run.output, !output.isEmpty { Text(output).textSelection(.enabled) }
                if let error = run.error, !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                if run.status == "waiting" { Text("This thread is waiting for your answer.").foregroundStyle(.orange) }
                if let threadId = run.threadId,
                   let target = NotificationTarget(botId: run.botId, threadId: threadId) {
                    Button("Open thread", systemImage: "arrow.up.right.square") {
                        Task { await session.openNotification(target) }
                    }
                }
            }
            .font(.subheadline)
        } label: {
            HStack {
                Image(systemName: run.status.symbol).foregroundStyle(run.status.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(run.routineName)
                    ((bot.map { Text(verbatim: $0.name) } ?? Text("Deleted agent"))
                        + Text(verbatim: " · \(Date(timeIntervalSince1970: run.scheduledFor / 1_000).formatted(date: .abbreviated, time: .shortened))"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text(run.status == "waiting" ? "Needs you" : run.status.capitalized)
                    .font(.caption).foregroundStyle(run.status.tint)
            }
        }
    }
}

private struct RoutineEditorView: View {
    let routine: Routine?
    let onSaved: () async -> Void

    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var prompt: String
    @State private var botId: String
    @State private var runOn: RoutineRunLocation
    @State private var runAvailability: RoutineRunAvailability?
    @State private var availabilityLoaded: Bool
    @State private var kind: RoutineSchedule.Kind
    @State private var onceAt: Date
    @State private var dailyTime: Date
    @State private var weekdays: Set<Int>
    @State private var intervalAnchor: Date
    @State private var intervalPreset: Int
    @State private var customIntervalMinutes: Int?
    @State private var duration: Int
    @State private var timeoutMinutes: Int?
    @State private var intervalTimeoutDefaultApplied: Bool
    @State private var advancedExpanded: Bool
    @State private var saving = false

    init(routine: Routine?, onSaved: @escaping () async -> Void) {
        self.routine = routine
        self.onSaved = onSaved
        _name = State(initialValue: routine?.name ?? "")
        _prompt = State(initialValue: routine?.prompt ?? "")
        _botId = State(initialValue: routine?.botId ?? "")
        _runOn = State(initialValue: routine?.runLocation ?? .maus)
        _runAvailability = State(initialValue: nil)
        _availabilityLoaded = State(initialValue: false)
        _kind = State(initialValue: routine?.schedule.type ?? .daily)
        _onceAt = State(initialValue: routine?.schedule.at.map { Date(timeIntervalSince1970: $0 / 1_000) } ?? Date().addingTimeInterval(3_600))
        let parts = (routine?.schedule.time ?? "09:00").split(separator: ":").compactMap { Int($0) }
        let time = Calendar.current.date(bySettingHour: parts.first ?? 9, minute: parts.count > 1 ? parts[1] : 0, second: 0, of: Date()) ?? Date()
        _dailyTime = State(initialValue: time)
        _weekdays = State(initialValue: Set(routine?.schedule.weekdays ?? [1, 2, 3, 4, 5]))
        _intervalAnchor = State(initialValue: routine?.schedule.anchorAt.map { Date(timeIntervalSince1970: Double($0) / 1_000) } ?? Date().addingTimeInterval(15 * 60))
        let everyMinutes = routine?.schedule.everyMinutes ?? 15
        _intervalPreset = State(initialValue: Self.intervalPresets.contains(everyMinutes) ? everyMinutes : 0)
        _customIntervalMinutes = State(initialValue: everyMinutes)
        let duration = routine?.durationMinutes ?? 30
        _duration = State(initialValue: duration)
        let timeoutMinutes = routine?.timeoutMinutes
        _timeoutMinutes = State(initialValue: timeoutMinutes)
        _intervalTimeoutDefaultApplied = State(initialValue: routine != nil)
        _advancedExpanded = State(initialValue: timeoutMinutes != nil && timeoutMinutes != 30)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Work") {
                    TextField("Routine name", text: $name)
                    Picker("Agent", selection: $botId) {
                        Text("Choose an agent").tag("")
                        ForEach(session.state.bots.filter { $0.hidden != true }) { bot in Text(bot.name).tag(bot.id) }
                    }
                    TextField("What should the agent do?", text: $prompt, axis: .vertical).lineLimit(4...10)
                }

                Section {
                    Picker("Run location", selection: $runOn) {
                        Label("This computer", systemImage: "laptopcomputer")
                            .tag(RoutineRunLocation.maus)
                        Label("Cloud VM", systemImage: "cloud")
                            .tag(RoutineRunLocation.cloud)
                            .selectionDisabled(!cloudSelectable)
                    }
                    .pickerStyle(.inline)

                    if !availabilityLoaded {
                        ProgressView("Checking Cloud VM availability…")
                    } else if runAvailability == nil {
                        Label("Cloud VM status is unavailable", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Where does it run?")
                } footer: {
                    if runOn == .maus {
                        Text("Uses this agent's selected model and computer setting on the paired computer.")
                    } else if runAvailability?.cloudReady == true {
                        Text("Runs the agent and its tools inside its Box virtual machine. The VM wakes automatically for each run; keep OpenMausBot running so its scheduler can launch the job.")
                    } else {
                        Text("This existing Cloud VM choice is preserved, but it cannot run until the paired computer has a configured Box API key and an available Box agent.")
                    }
                }

                Section {
                    Picker("Repeats", selection: $kind) {
                        if kind == .unknown {
                            Text("Newer schedule").tag(RoutineSchedule.Kind.unknown)
                                .selectionDisabled()
                        }
                        Text("One time").tag(RoutineSchedule.Kind.once)
                        Text("Selected days").tag(RoutineSchedule.Kind.daily)
                        Text("Every X minutes").tag(RoutineSchedule.Kind.interval)
                    }
                    if kind == .once {
                        DatePicker("Run", selection: $onceAt, in: Date()...)
                    } else if kind == .daily {
                        DatePicker("Time", selection: $dailyTime, displayedComponents: .hourAndMinute)
                        HStack {
                            ForEach(0..<7) { day in
                                Button(Self.dayLetters[day]) {
                                    if weekdays.contains(day) { weekdays.remove(day) } else { weekdays.insert(day) }
                                }
                                .buttonStyle(.bordered)
                                .tint(weekdays.contains(day) ? .accentColor : .secondary)
                                .accessibilityLabel(Self.dayNames[day])
                            }
                        }
                    } else if kind == .interval {
                        HStack(spacing: 5) {
                            Text(intervalPreset == 0 ? "Runs on" : "Runs every")
                            Menu {
                                ForEach(Self.intervalPresets, id: \.self) { minutes in
                                    Button("\(minutes) minutes") {
                                        intervalPreset = minutes
                                    }
                                }
                                Divider()
                                Button("Custom interval…") {
                                    intervalPreset = 0
                                }
                            } label: {
                                HStack(spacing: 3) {
                                    Text(intervalPreset == 0 ? "a custom interval" : "\(intervalPreset)")
                                        .fontWeight(.semibold)
                                    Image(systemName: "chevron.up.chevron.down")
                                        .font(.caption2)
                                }
                            }
                            .accessibilityLabel("How often this routine runs")
                            .accessibilityValue(intervalFrequencyAccessibilityValue)
                            if intervalPreset != 0 {
                                Text("minutes")
                            }
                            Spacer(minLength: 0)
                        }
                        if intervalPreset == 0 {
                            HStack {
                                Text("Set the interval to")
                                TextField("5–1,440", value: $customIntervalMinutes, format: .number)
                                    .keyboardType(.numberPad)
                                    .multilineTextAlignment(.trailing)
                                    .frame(minWidth: 72)
                                    .accessibilityLabel("Custom interval in minutes")
                                Text("minutes")
                                    .foregroundStyle(.secondary)
                            }
                            if selectedIntervalMinutes == nil {
                                Text("Enter a whole number from 5 to 1,440 minutes.")
                                    .font(.footnote)
                                    .foregroundStyle(.red)
                            }
                        }
                        DatePicker("Starting", selection: $intervalAnchor)
                    } else {
                        Label(
                            "This routine uses a schedule added by a newer OpenMausBot. Choose One time, Selected days, or Every X minutes before saving.",
                            systemImage: "exclamationmark.triangle"
                        )
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Schedule")
                } footer: {
                    if kind == .interval {
                        Text("Each occurrence starts with fresh context. Results collect in one thread, and full run logs remain available. If the previous run is still active, the next occurrence is skipped instead of queued.")
                    } else {
                        Text("Each occurrence starts with fresh context. Results collect in one thread, and full run logs remain available. No cron syntax is used.")
                    }
                }

                Section {
                    DisclosureGroup(isExpanded: $advancedExpanded) {
                        Picker("Stop if still running after", selection: $timeoutMinutes) {
                            Text("No limit").tag(nil as Int?)
                            ForEach(Self.timeoutOptions, id: \.self) { minutes in
                                Text(Self.durationLabel(minutes)).tag(Optional(minutes))
                            }
                        }
                    } label: {
                        timeoutMinutes.map { Text("Advanced · \(Self.durationLabel($0)) run limit") } ?? Text("Advanced · no run limit")
                    }
                } footer: {
                    if advancedExpanded {
                        Text("Optional. The clock starts when work actually begins and does not control how often the routine starts.")
                    }
                }
            }
            .navigationTitle(routine == nil ? "New routine" : "Edit routine")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(
                            saving || kind == .unknown
                                || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                || botId.isEmpty
                                || (kind == .daily && weekdays.isEmpty)
                                || (kind == .interval && selectedIntervalMinutes == nil)
                        )
                }
            }
            .onAppear { if botId.isEmpty { botId = session.state.bots.first(where: { $0.hidden != true })?.id ?? "" } }
            .onChange(of: kind) { _, nextKind in
                guard nextKind == .interval, !intervalTimeoutDefaultApplied else { return }
                timeoutMinutes = timeoutMinutes ?? 30
                intervalTimeoutDefaultApplied = true
            }
            .task {
                runAvailability = await session.loadRoutineRunAvailability()
                availabilityLoaded = true
            }
        }
    }

    private var cloudSelectable: Bool {
        runAvailability?.canSelect(.cloud, preserving: runOn) ?? (runOn == .cloud)
    }

    private var selectedIntervalMinutes: Int? {
        let minutes = intervalPreset == 0 ? customIntervalMinutes : intervalPreset
        guard let minutes, (5...1_440).contains(minutes) else { return nil }
        return minutes
    }

    private var intervalFrequencyAccessibilityValue: String {
        intervalPreset == 0 ? "Custom interval" : "Every \(intervalPreset) minutes"
    }

    private func save() async {
        guard kind != .unknown else {
            session.actionError = "Choose a supported schedule before saving this routine."
            return
        }
        saving = true
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = "HH:mm"
        let schedule: RoutineSchedule
        switch kind {
        case .once:
            schedule = .once(at: onceAt)
        case .daily:
            schedule = .daily(time: formatter.string(from: dailyTime), weekdays: weekdays.sorted())
        case .interval:
            guard let minutes = selectedIntervalMinutes else {
                session.actionError = "Choose an interval from 5 to 1,440 minutes."
                saving = false
                return
            }
            let anchor = Calendar.current.date(bySetting: .second, value: 0, of: intervalAnchor)
                ?? intervalAnchor
            schedule = .interval(everyMinutes: minutes, anchorAt: anchor)
        case .unknown:
            saving = false
            return
        }
        let input = RoutineInput(
            name: String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80)),
            prompt: String(prompt.trimmingCharacters(in: .whitespacesAndNewlines).prefix(20_000)),
            botId: botId, runOn: runOn.rawValue, enabled: routine?.enabled,
            schedule: schedule, durationMinutes: duration,
            timeoutMinutes: timeoutMinutes, clearTimeout: timeoutMinutes == nil
        )
        if await session.saveRoutine(input, id: routine?.id) != nil {
            await onSaved()
            dismiss()
        }
        saving = false
    }

    private static let dayLetters = ["S", "M", "T", "W", "T", "F", "S"]
    fileprivate static let dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    private static let intervalPresets = [5, 10, 15, 30, 60]
    private static let timeoutOptions = stride(from: 5, through: 240, by: 5).map { $0 }

    private static func durationLabel(_ minutes: Int) -> String {
        if minutes < 60 { return "\(minutes) min" }
        if minutes % 60 == 0 { return "\(minutes / 60) hr" }
        return "\(minutes / 60) hr \(minutes % 60) min"
    }
}

private extension RoutineRunLocation {
    var label: String {
        switch self {
        case .maus: "This computer"
        case .cloud: "Cloud VM"
        }
    }
}

private extension RoutineSchedule {
    var summary: String {
        switch type {
        case .once:
            guard let at else { return "One time · date unavailable" }
            return Date(timeIntervalSince1970: at / 1_000).formatted(date: .abbreviated, time: .shortened)
        case .unknown:
            return "Newer schedule"
        case .interval:
            guard let everyMinutes else { return "Interval unavailable" }
            let cadence = "Every \(everyMinutes) min"
            guard let anchorAt else { return cadence }
            let start = Date(timeIntervalSince1970: Double(anchorAt) / 1_000)
                .formatted(date: .abbreviated, time: .shortened)
            return "\(cadence) · starting \(start)"
        case .daily:
            break
        }
        let dayText: String
        let values = weekdays ?? []
        if values.count == 7 { dayText = "Every day" }
        else if values == [1, 2, 3, 4, 5] { dayText = "Weekdays" }
        else { dayText = values.compactMap { (0..<7).contains($0) ? RoutineEditorView.dayNames[$0].prefix(3) : nil }.joined(separator: ", ") }
        return "\(dayText) at \(time ?? "—")"
    }
}

private extension String {
    var symbol: String {
        switch self {
        case "running": "play.circle.fill"
        case "completed": "checkmark.circle.fill"
        case "waiting": "hand.raised.circle.fill"
        case "failed", "missed": "exclamationmark.triangle.fill"
        case "cancelled": "xmark.circle.fill"
        default: "clock.fill"
        }
    }
    var tint: Color {
        switch self {
        case "completed": .green
        case "waiting": .orange
        case "failed", "missed": .red
        default: .secondary
        }
    }
}
