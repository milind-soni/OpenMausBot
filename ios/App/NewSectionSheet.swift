import SwiftUI
import CompanionCore

private let maximumBotsPerSection = 100

/// A quick, phone-native way to file several bots under one sidebar heading.
/// A normal tap always works; holding for a beat starts a trail that can be
/// drawn through the grid without lifting a finger.
struct NewSectionSheet: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    @State private var step: Step = .bots
    @State private var selection = SectionSelection(maximumCount: maximumBotsPerSection)
    @State private var name = ""
    @State private var saving = false
    @State private var saveError: String?
    @State private var lastCreatedName: String?
    @State private var cellFrames: [String: CGRect] = [:]
    @State private var fingerLocation: CGPoint?
    @State private var dwellTask: Task<Void, Never>?
    @State private var scheduledCandidate: SectionSelection.Candidate?
    @State private var selectionFeedback = 0
    @State private var warningFeedback = 0
    @State private var successFeedback = 0
    @FocusState private var nameFocused: Bool

    private static let gridSpace = "new-section-grid"
    // A brief touch separates route drawing from an ordinary fast scroll, but
    // must not feel like a long press. The generous movement allowance lets a
    // finger start gliding immediately, like SBB's touch timetable.
    private static let activationMilliseconds = 140
    private static let activationMovement: CGFloat = 80
    private static let dwellMilliseconds = 120

    private enum Step {
        case bots
        case name
    }

    private var bots: [Bot] {
        session.state.bots.filter { $0.hidden != true }
    }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var existingSections: Set<String> {
        let botSections = bots.compactMap { normalizedSection($0.section) }
        let roomSections = session.state.rooms.compactMap { normalizedSection($0.section) }
        return Set(botSections + roomSections)
    }

    private var joinsExistingSection: Bool {
        existingSections.contains(trimmedName)
    }

    private var selectedBots: [Bot] {
        selection.selectedIDs.compactMap { id in bots.first { $0.id == id } }
    }

    /// Sections allow one coordinator. Moving two Chiefs together, or moving
    /// one beside a different incumbent, must never silently remove a role.
    private var hasChiefConflict: Bool {
        let selectedChiefIDs = selectedBots
            .filter { $0.chiefOfStaff == true }
            .map(\.id)
        let destinationChiefIDs = bots
            .filter {
                $0.chiefOfStaff == true && normalizedSection($0.section) == trimmedName
            }
            .map(\.id)
        return Set(selectedChiefIDs + destinationChiefIDs).count > 1
    }

    private var hasPinnedSelection: Bool {
        selectedBots.contains { $0.pinned == true && $0.chiefOfStaff != true }
    }

    private var canSave: Bool {
        !saving
            && !selection.selectedIDs.isEmpty
            && (1...60).contains(trimmedName.utf16.count)
            && !hasChiefConflict
    }

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case .bots: botPicker
                case .name: nameStep
                }
            }
            .navigationTitle(step == .bots ? "New section" : "Name section")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(lastCreatedName == nil ? "Cancel" : "Done") { dismiss() }
                        .disabled(saving)
                }
            }
            .interactiveDismissDisabled(saving)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .sensoryFeedback(.selection, trigger: selectionFeedback)
        .sensoryFeedback(.warning, trigger: warningFeedback)
        .sensoryFeedback(.success, trigger: successFeedback)
        .alert(
            "Couldn’t create section",
            isPresented: Binding(
                get: { saveError != nil },
                set: { if !$0 { saveError = nil } }
            )
        ) {
            Button("OK") { saveError = nil }
        } message: {
            Text(saveError ?? "Try again.")
        }
        .onDisappear { endDrawing() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { endDrawing() }
        }
        .onChange(of: bots.map(\.id)) { _, ids in
            if selection.isDragging { endDrawing() }
            let available = Set(ids)
            selection.selectAll(selection.selectedIDs.filter(available.contains))
        }
    }

    // MARK: - Pick bots

    private var botPicker: some View {
        VStack(spacing: 0) {
            if let lastCreatedName {
                successBanner(name: lastCreatedName)
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Swipe a section together")
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                Text("Touch a bot, then glide. Pause briefly on each bot until it clicks.")
                    .font(.system(size: 15))
                    .foregroundStyle(Color.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 14)

            HStack {
                Text(selection.selectedIDs.isEmpty ? "Choose bots" : "\(selection.selectedIDs.count) selected")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.secondary)
                Spacer()
                let selectableCount = min(bots.count, maximumBotsPerSection)
                Button(selection.selectedIDs.count == selectableCount && selectableCount > 0 ? "Clear" : "Select all") {
                    if selection.selectedIDs.count == selectableCount {
                        selection.clear()
                    } else {
                        selection.selectAll(bots.map(\.id))
                    }
                    selectionFeedback += 1
                }
                .font(.system(size: 14, weight: .semibold))
                .disabled(bots.isEmpty || selection.isDragging)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, bots.count > maximumBotsPerSection ? 4 : 10)

            if bots.count > maximumBotsPerSection {
                Text(
                    selection.selectedIDs.count == maximumBotsPerSection
                        ? "100 selected — that’s the section limit."
                        : "Choose up to 100 bots for one section."
                )
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.bottom, 10)
            }

            if bots.isEmpty {
                ContentUnavailableView(
                    "No bots yet",
                    systemImage: "square.grid.2x2",
                    description: Text("Create a bot first, then come back to group it into a section.")
                )
                .frame(maxHeight: .infinity)
            } else {
                botGrid
            }
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 8) {
                if selection.selectedIDs.isEmpty {
                    Text("Tap bots individually, or hold and swipe through the grid.")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.secondary)
                }
                Button {
                    endDrawing()
                    step = .name
                    nameFocused = true
                } label: {
                    Text("Continue with \(selection.selectedIDs.count) bots")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .disabled(selection.selectedIDs.isEmpty)
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 6)
            .background(.ultraThinMaterial)
        }
    }

    private var botGrid: some View {
        ScrollView {
            ZStack(alignment: .topLeading) {
                trail
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 108, maximum: 180), spacing: 12)],
                    spacing: 12
                ) {
                    ForEach(bots) { bot in
                        botCell(bot)
                            .background {
                                GeometryReader { proxy in
                                    Color.clear.preference(
                                        key: SectionCellFramePreference.self,
                                        value: [bot.id: proxy.frame(in: .named(Self.gridSpace))]
                                    )
                                }
                            }
                    }
                }
            }
            .coordinateSpace(name: Self.gridSpace)
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
            .onPreferenceChange(SectionCellFramePreference.self) { cellFrames = $0 }
            .highPriorityGesture(drawGesture)
        }
        // A fast vertical swipe still scrolls. Briefly touching a tile before
        // gliding switches into drawing and freezes the scroll position; there
        // is deliberately no surprising edge auto-scroll while a trail is active.
        .scrollDisabled(selection.isDragging)
    }

    private func botCell(_ bot: Bot) -> some View {
        let selected = selection.contains(bot.id)
        let candidate = selection.candidate?.id == bot.id
        let order = selection.selectedIDs.firstIndex(of: bot.id).map { $0 + 1 }
        let tint = MausPalette.color(bot.color)

        return Button {
            if selection.toggle(bot.id) {
                selectionFeedback += 1
            } else {
                warningFeedback += 1
            }
        } label: {
            VStack(spacing: 9) {
                ZStack(alignment: .topTrailing) {
                    BotAvatarView(bot: bot, size: 52, animated: false)
                    if let order {
                        Text("\(order)")
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .foregroundStyle(Color.white)
                            .frame(minWidth: 21, minHeight: 21)
                            .background(tint, in: Circle())
                            .overlay(Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2))
                            .offset(x: 5, y: -5)
                    }
                }

                VStack(spacing: 3) {
                    Text(bot.name)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    Text(botContext(bot))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 116)
            .background(
                selected ? tint.opacity(0.13) : Color.secondary.opacity(0.07),
                in: RoundedRectangle(cornerRadius: 20, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(
                        candidate ? tint : (selected ? tint.opacity(0.75) : Color.secondary.opacity(0.12)),
                        lineWidth: candidate ? 3 : 1
                    )
            }
            .overlay(alignment: .bottom) {
                if candidate {
                    Capsule()
                        .fill(tint)
                        .frame(height: 4)
                        .padding(.horizontal, 18)
                        .padding(.bottom, 7)
                        .transition(.opacity)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(bot.name), \(botContext(bot))")
        .accessibilityValue(selected ? "Selected, number \(order ?? 1)" : "Not selected")
        .accessibilityHint(selected ? "Double tap to remove this bot" : "Double tap to add this bot")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .animation(reduceMotion ? nil : .snappy(duration: 0.18), value: selected)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.12), value: candidate)
    }

    private var trail: some View {
        Canvas { context, _ in
            guard selection.isDragging else { return }
            var points = selection.gestureTrail.compactMap { cellFrames[$0]?.center }
            if let fingerLocation { points.append(fingerLocation) }
            guard let first = points.first else { return }

            var path = Path()
            path.move(to: first)
            for point in points.dropFirst() { path.addLine(to: point) }
            context.stroke(
                path,
                with: .color(Color.accentColor.opacity(0.72)),
                style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round)
            )
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var drawGesture: some Gesture {
        LongPressGesture(
            minimumDuration: Double(Self.activationMilliseconds) / 1_000,
            maximumDistance: Self.activationMovement
        )
        .sequenced(
            before: DragGesture(minimumDistance: 0, coordinateSpace: .named(Self.gridSpace))
        )
        .onChanged { phase in
            switch phase {
            case let .second(true, drag):
                guard let drag else { return }
                if !selection.isDragging {
                    let firstHit = cellID(at: drag.startLocation)
                    guard let firstHit,
                          let candidate = selection.beginDrag(over: firstHit) else { return }
                    // The brief activation already supplied the first dwell.
                    commit(candidate)
                }
                fingerLocation = drag.location
                schedule(selection.moveDrag(over: cellID(at: drag.location)))
            default:
                break
            }
        }
        .onEnded { _ in endDrawing() }
    }

    private func cellID(at point: CGPoint) -> String? {
        SectionGridHitTesting.cellID(
            at: .init(x: point.x, y: point.y),
            in: hitFrames
        )
    }

    private var hitFrames: [SectionGridCellFrame] {
        bots.compactMap { bot in
            guard let frame = cellFrames[bot.id] else { return nil }
            return SectionGridCellFrame(
                id: bot.id,
                minX: frame.minX,
                minY: frame.minY,
                maxX: frame.maxX,
                maxY: frame.maxY
            )
        }
    }

    private func schedule(_ candidate: SectionSelection.Candidate?) {
        guard scheduledCandidate != candidate else { return }
        dwellTask?.cancel()
        dwellTask = nil
        scheduledCandidate = candidate
        guard let candidate else { return }
        dwellTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(Self.dwellMilliseconds))
            guard !Task.isCancelled else { return }
            commit(candidate)
            if scheduledCandidate == candidate {
                scheduledCandidate = nil
                dwellTask = nil
            }
        }
    }

    private func commit(_ candidate: SectionSelection.Candidate) {
        let result = selection.commit(candidate)
        if case .limitReached = result {
            warningFeedback += 1
        } else if result.givesFeedback {
            selectionFeedback += 1
        }
    }

    private func endDrawing() {
        dwellTask?.cancel()
        dwellTask = nil
        scheduledCandidate = nil
        selection.endDrag()
        // A bot can disappear while the finger is down. Reconcile after the
        // gesture ends so a stale ID cannot turn the eventual save into a 404.
        let available = Set(bots.map(\.id))
        selection.selectAll(selection.selectedIDs.filter(available.contains))
        fingerLocation = nil
    }

    // MARK: - Name and save

    private var nameStep: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Button {
                    nameFocused = false
                    step = .bots
                } label: {
                    Label("Back to bots", systemImage: "chevron.left")
                        .font(.system(size: 15, weight: .semibold))
                }
                .disabled(saving)

                VStack(alignment: .leading, spacing: 7) {
                    Text("What should this section be called?")
                        .font(.system(size: 24, weight: .bold, design: .rounded))
                    Text("It will appear on both this device and your computer.")
                        .font(.system(size: 15))
                        .foregroundStyle(Color.secondary)
                }

                TextField("For example, Research", text: $name)
                    .font(.system(size: 19, weight: .medium))
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .focused($nameFocused)
                    .padding(.horizontal, 16)
                    .frame(height: 56)
                    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                    .overlay {
                        RoundedRectangle(cornerRadius: 16)
                            .stroke(Color.secondary.opacity(0.14), lineWidth: 1)
                    }
                    .onSubmit { if canSave { save() } }

                HStack {
                    if joinsExistingSection {
                        Label("Adds to existing section", systemImage: "arrow.triangle.merge")
                            .foregroundStyle(Color.secondary)
                    } else {
                        Label("Creates a new section", systemImage: "square.stack.3d.up")
                            .foregroundStyle(Color.secondary)
                    }
                    Spacer()
                    Text("\(trimmedName.utf16.count)/60")
                        .foregroundStyle(trimmedName.utf16.count > 60 ? Color.red : Color.secondary)
                }
                .font(.system(size: 13, weight: .medium))

                if hasChiefConflict {
                    Label(
                        "A section can have one Chief. Go back and choose one Chief, or use a section without one.",
                        systemImage: "person.crop.circle.badge.exclamationmark"
                    )
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.orange)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
                }

                if hasPinnedSelection {
                    Label(
                        "Pinned bots stay in Pinned until you unpin them.",
                        systemImage: "pin.fill"
                    )
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.secondary)
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("\(selection.selectedIDs.count) bot\(selection.selectedIDs.count == 1 ? "" : "s")")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.secondary)
                    selectedBotChips
                }
            }
            .padding(20)
        }
        .safeAreaInset(edge: .bottom) {
            Button(action: save) {
                HStack(spacing: 8) {
                    if saving { ProgressView().tint(.white) }
                    Text(saving ? "Creating…" : (joinsExistingSection ? "Add to section" : "Create section"))
                        .font(.system(size: 17, weight: .semibold))
                }
                .frame(maxWidth: .infinity)
                .frame(height: 52)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .disabled(!canSave)
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 6)
            .background(.ultraThinMaterial)
        }
        .onAppear { nameFocused = true }
    }

    private var selectedBotChips: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 8)], spacing: 8) {
            ForEach(Array(selection.selectedIDs.enumerated()), id: \.element) { index, id in
                if let bot = bots.first(where: { $0.id == id }) {
                    HStack(spacing: 7) {
                        BotAvatarView(bot: bot, size: 26, animated: false)
                        Text("\(index + 1). \(bot.name)")
                            .font(.system(size: 13, weight: .semibold))
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 40)
                    .background(Color.secondary.opacity(0.08), in: Capsule())
                }
            }
        }
    }

    private func save() {
        guard canSave else { return }
        let section = trimmedName
        let botIDs = selection.selectedIDs
        saving = true
        saveError = nil
        session.actionError = nil
        nameFocused = false

        Task {
            let result = await session.assignSection(name: section, botIds: botIDs)
            saving = false
            guard result != nil else {
                let message = session.actionError
                    ?? "The section could not be saved. Your bot selection is still here."
                session.actionError = nil
                saveError = message
                return
            }

            successFeedback += 1
            lastCreatedName = section
            selection.clear()
            name = ""
            step = .bots
        }
    }

    private func successBanner(name: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Color.green)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(name) is ready")
                    .font(.system(size: 14, weight: .semibold))
                Text("Swipe another section together, or tap Done.")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.secondary)
            }
            Spacer()
        }
        .padding(12)
        .background(Color.green.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
    }

    private func normalizedSection(_ section: String?) -> String? {
        guard let value = section?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }

    private func botContext(_ bot: Bot) -> String {
        var parts: [String] = []
        if bot.chiefOfStaff == true {
            parts.append("Chief")
        } else if bot.pinned == true {
            parts.append("Pinned")
        }
        parts.append(normalizedSection(bot.section) ?? "Bots")
        return parts.joined(separator: " · ")
    }
}

private struct SectionCellFramePreference: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]

    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}

private extension CGRect {
    var center: CGPoint { CGPoint(x: midX, y: midY) }
}
