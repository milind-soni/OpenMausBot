import CompanionCore
import SwiftUI

/// Routines on a calendar (MOCA-191): a week strip, the way Calendar does it
/// on iPhone, over the chosen day's runs in time order — what ran and how it
/// went, and what is coming. The days are worked out by RoutineCalendar, the
/// same rules as the desktop's calendar.
struct RoutineCalendarView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var routines: [Routine] = []
    @State private var runs: [RoutineRun] = []
    @State private var loading = true
    @State private var selected = Calendar.current.startOfDay(for: Date())
    @State private var editor: CalendarEditorTarget?

    private var calendar: Calendar { .current }
    private var week: [Date] { RoutineCalendar.week(containing: selected, calendar: calendar) }

    private func items(on day: Date) -> [RoutineCalendarItem] {
        RoutineCalendar.items(routines: routines, runs: runs, day: day, calendar: calendar)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                weekStrip
                Divider()
                let dayItems = items(on: selected)
                List {
                    if dayItems.isEmpty && !loading {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Nothing scheduled")
                                .font(.headline)
                            Text("Routines that run on this day appear here.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 8)
                        .listRowSeparator(.hidden)
                    }
                    ForEach(dayItems) { item in
                        CalendarRunRow(item: item, bot: session.state.bot(item.run?.botId ?? item.routine?.botId ?? ""))
                            .contentShape(Rectangle())
                            .onTapGesture { open(item) }
                    }
                }
                .listStyle(.plain)
                .overlay {
                    if loading && routines.isEmpty && runs.isEmpty { ProgressView() }
                }
            }
            .navigationTitle(Text(selected, format: .dateTime.month(.wide).year()))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    if !calendar.isDateInToday(selected) {
                        Button("Today") { select(Date()) }
                    }
                    Button("New routine", systemImage: "plus") { editor = .new }
                        .accessibilityIdentifier("calendar-new-routine")
                }
            }
            .task { await reload() }
            .refreshable { await reload() }
            .sheet(item: $editor) { target in
                RoutineEditorView(routine: target.routine) { await reload() }
            }
        }
    }

    // MARK: - Week strip

    private var weekStrip: some View {
        HStack(spacing: 2) {
            Button { shiftWeek(by: -1) } label: {
                Image(systemName: "chevron.left").frame(width: 32, height: 44)
            }
            .accessibilityLabel("Previous week")
            ForEach(week, id: \.self) { day in
                dayCell(day)
            }
            Button { shiftWeek(by: 1) } label: {
                Image(systemName: "chevron.right").frame(width: 32, height: 44)
            }
            .accessibilityLabel("Next week")
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        // A sideways swipe turns the week, as it does in Calendar.
        .gesture(DragGesture(minimumDistance: 30).onEnded { value in
            guard abs(value.translation.width) > abs(value.translation.height) else { return }
            shiftWeek(by: value.translation.width < 0 ? 1 : -1)
        })
    }

    private func dayCell(_ day: Date) -> some View {
        let isSelected = calendar.isDate(day, inSameDayAs: selected)
        let isToday = calendar.isDateInToday(day)
        let count = items(on: day).count
        return Button { select(day) } label: {
            VStack(spacing: 4) {
                Text(day, format: .dateTime.weekday(.narrow))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                // The bare number, as Calendar's week strip draws it: the date
                // style's day is "28日" in Chinese and Japanese, which the
                // 34-point circle cuts to "2…".
                Text(calendar.component(.day, from: day), format: .number)
                    .font(.system(size: 17, weight: isSelected || isToday ? .semibold : .regular))
                    // Selected reads as the inverse of the page (white on black
                    // in dark mode, black on white in light); today, in the accent.
                    .foregroundStyle(isSelected ? (isToday ? Color.white : Color(uiColor: .systemBackground))
                        : isToday ? Color.accentColor : Color.primary)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(isSelected ? (isToday ? Color.accentColor : Color.primary) : Color.clear))
                Circle()
                    .fill(count > 0 ? Color.secondary : Color.clear)
                    .frame(width: 5, height: 5)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .accessibilityLabel(Text(day, format: .dateTime.weekday(.wide).day().month(.wide)))
        .accessibilityValue(count == 0 ? Text("Nothing scheduled") : Text("\(count) runs"))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("calendar-day-\(Self.dayKey(day, calendar))")
    }

    static func dayKey(_ day: Date, _ calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: day)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    // MARK: - Actions

    private func select(_ day: Date) {
        withAnimation(.easeOut(duration: 0.15)) { selected = calendar.startOfDay(for: day) }
    }

    private func shiftWeek(by weeks: Int) {
        guard let next = calendar.date(byAdding: .day, value: 7 * weeks, to: selected) else { return }
        select(next)
    }

    /// A run opens the thread its results went to; one still to come opens
    /// its routine to edit.
    private func open(_ item: RoutineCalendarItem) {
        if let run = item.run, let threadId = run.threadId,
           let target = NotificationTarget(botId: run.botId, threadId: threadId) {
            dismiss()
            Task { await session.openNotification(target) }
        } else if let routine = item.routine {
            editor = .edit(routine)
        }
    }

    private func reload() async {
        loading = true
        let loaded = await session.loadRoutines()
        routines = loaded.routines
        runs = loaded.runs
        loading = false
    }
}

private enum CalendarEditorTarget: Identifiable {
    case new
    case edit(Routine)
    var id: String { routine?.id ?? "new" }
    var routine: Routine? { if case let .edit(value) = self { value } else { nil } }
}

/// One run on the day: when, what, for whom, and how it went.
private struct CalendarRunRow: View {
    let item: RoutineCalendarItem
    let bot: Bot?

    private var name: String { item.routine?.name ?? item.run?.routineName ?? "" }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(item.date, format: .dateTime.hour().minute())
                .font(.system(size: 15).monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(minWidth: 58, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: name)
                    .font(.system(size: 16, weight: .medium))
                    .lineLimit(2)
                (bot.map { Text(verbatim: $0.name) } ?? Text("Deleted agent"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            status
        }
        .padding(.vertical, 4)
        // The divider runs under the whole row, not just its last label.
        .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var status: some View {
        if let run = item.run {
            Label {
                Text(run.status == "waiting" ? "Needs you" : LocalizedStringKey(run.status.capitalized))
            } icon: {
                Image(systemName: run.status.routineStatusSymbol)
            }
            .font(.caption)
            .foregroundStyle(run.status.routineStatusTint)
        } else {
            Label("Scheduled", systemImage: "clock")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
