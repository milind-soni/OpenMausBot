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
                    Label("Task = one conversation and result", systemImage: "bubble.left.and.text.bubble.right")
                    Label("Routine = a schedule that creates a fresh task", systemImage: "calendar.badge.clock")
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
        .navigationTitle("Tasks & Routines")
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
                Text("\(bot?.name ?? "Deleted agent") · \(routine.schedule.summary) · \(routine.runLocation.label)")
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
                if run.status == "waiting" { Text("This task is waiting for your answer.").foregroundStyle(.orange) }
                if let threadId = run.threadId,
                   let target = NotificationTarget(botId: run.botId, threadId: threadId) {
                    Button("Open task", systemImage: "arrow.up.right.square") {
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
                    Text("\(bot?.name ?? "Deleted agent") · \(Date(timeIntervalSince1970: run.scheduledFor / 1_000).formatted(date: .abbreviated, time: .shortened))")
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
    @State private var duration: Int
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
        _duration = State(initialValue: routine?.durationMinutes ?? 30)
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
                    Stepper("Allow up to \(duration) minutes", value: $duration, in: 15...240, step: 15)
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
                    } else {
                        Label(
                            "This routine uses a schedule added by a newer OpenMausBot. Choose One time or Selected days before saving.",
                            systemImage: "exclamationmark.triangle"
                        )
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Schedule")
                } footer: {
                    Text("Each occurrence creates a fresh task. No cron syntax is used.")
                }
            }
            .navigationTitle(routine == nil ? "New routine" : "Edit routine")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(saving || kind == .unknown || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || botId.isEmpty || (kind == .daily && weekdays.isEmpty))
                }
            }
            .onAppear { if botId.isEmpty { botId = session.state.bots.first(where: { $0.hidden != true })?.id ?? "" } }
            .task {
                runAvailability = await session.loadRoutineRunAvailability()
                availabilityLoaded = true
            }
        }
    }

    private var cloudSelectable: Bool {
        runAvailability?.canSelect(.cloud, preserving: runOn) ?? (runOn == .cloud)
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
        let schedule = kind == .once ? RoutineSchedule.once(at: onceAt) : .daily(time: formatter.string(from: dailyTime), weekdays: weekdays.sorted())
        let input = RoutineInput(
            name: String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80)),
            prompt: String(prompt.trimmingCharacters(in: .whitespacesAndNewlines).prefix(20_000)),
            botId: botId, runOn: runOn.rawValue, enabled: routine?.enabled,
            schedule: schedule, durationMinutes: duration
        )
        if await session.saveRoutine(input, id: routine?.id) != nil {
            await onSaved()
            dismiss()
        }
        saving = false
    }

    private static let dayLetters = ["S", "M", "T", "W", "T", "F", "S"]
    fileprivate static let dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
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
