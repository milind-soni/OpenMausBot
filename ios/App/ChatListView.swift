// The roster.
//
// Messages-shaped: a glass header, built-in and user-named sidebar sections,
// channels as compact tiles, and bot conversations as rows. The floating bar
// keeps Updates, search, organization and new-bot actions within one thumb's
// reach while everything scrolls beneath the glass.
import SwiftUI
import CompanionCore

struct ChatListView: View {
    @EnvironmentObject private var session: Session
    @State private var query = ""
    @AppStorage(PrefKey.activityDetail) private var activityDetail = ActivityDetail.full.rawValue
    /// Driven so that making a bot can open it. Value-based navigation alone
    /// cannot push without a tap, and a new bot appearing silently at the
    /// bottom of the roster is a poor answer to pressing +.
    @State private var path = NavigationPath()
    @State private var searchHits: [SearchHit] = []
    @State private var searching = false
    @State private var searchOpen = false
    @State private var showingUpdates = false
    @State private var showingNewGroup = false
    @State private var showingNewSection = false
    @FocusState private var searchFocused: Bool

    /// Room for the floating bar, so the last row can scroll clear of it.
    private static let barClearance: CGFloat = 96

    var body: some View {
        NavigationStack(path: $path) {
            GeometryReader { geo in
            VStack(spacing: 0) {
                header
                StatusBanner()

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if query.isEmpty {
                            rosterSections
                        } else {
                            if !searchHits.isEmpty {
                                HStack {
                                    sectionLabel("Messages")
                                    Spacer()
                                    if searching { ProgressView().controlSize(.small) }
                                }
                                .padding(.top, 10)
                                .padding(.bottom, 4)

                                ForEach(searchHits) { hit in
                                    Button {
                                        Task {
                                            if let chat = await session.open(hit) {
                                                Haptics.selection()
                                                path.append(chat)
                                            }
                                        }
                                    } label: {
                                        SearchHitRow(hit: hit)
                                    }
                                    .buttonStyle(.plain)
                                    .padding(.horizontal, 16)
                                }
                                sectionLabel("Chats")
                                    .padding(.top, 14)
                                    .padding(.bottom, 4)
                            } else if searching {
                                ProgressView()
                                    .controlSize(.small)
                                    .frame(maxWidth: .infinity)
                                    .padding(.top, 24)
                            }

                            botRows(chats)
                        }
                    }
                    .padding(.bottom, Self.barClearance)
                }
                .refreshable { await session.refresh() }
                .overlay {
                    if rosterIsEmpty {
                        ContentUnavailableView(
                            query.isEmpty ? "No bots yet" : "Nothing matches",
                            systemImage: query.isEmpty ? "bubble.left.and.bubble.right" : "magnifyingglass",
                            description: Text(
                                query.isEmpty
                                    ? "Bots you create on your computer show up here."
                                    : "No chat matches \u{201C}\(query)\u{201D}."
                            )
                        )
                    }
                }
            }
            // top-aligned: the roster fills downward from the header
            .frame(maxWidth: CompanionLayout.rosterWidth, maxHeight: .infinity, alignment: .top)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .overlay(alignment: .bottom) {
                bottomBar.frame(maxWidth: CompanionLayout.rosterWidth)
            }
            // a bot that stopped for you grows out of the island
            .overlay(alignment: .top) {
                if CompanionLayout.supportsIslandPresentation {
                    NeedsYouIsland(
                        update: session.state.updates.first { $0.kind == .needsYou },
                        hasIsland: IslandGeometry.hasIsland(topInset: geo.safeAreaInsets.top)
                    ) { chat in path.append(chat) }
                }
            }
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Chat.self) { ChatView(chat: $0) }
            .onChange(of: session.notificationChat) { _, chat in
                guard let chat else { return }
                path.append(chat)
                session.consumeNotificationChat()
            }
            .task {
                if let chat = session.notificationChat {
                    path.append(chat)
                    session.consumeNotificationChat()
                }
            }
#if DEBUG
            // Preview-only routes let the screenshot harness reach screens
            // that normally require a paired computer and a tap.
            .task {
                if ProcessInfo.processInfo.arguments.contains("-open-new-section") {
                    showingNewSection = true
                }
                if ProcessInfo.processInfo.arguments.contains("-open-first"),
                   path.isEmpty, let first = chats.first {
                    path.append(first.chat)
                }
            }
#endif
            .sheet(isPresented: $showingUpdates) {
                UpdatesSheet { chat in
                    showingUpdates = false
                    path.append(chat)
                }
            }
            .sheet(isPresented: $showingNewGroup) {
                NewGroupSheet { room in
                    showingNewGroup = false
                    path.append(Chat.room(room))
                }
            }
            .sheet(isPresented: $showingNewSection) {
                NewSectionSheet()
            }
            .task(id: query) {
                let expected = query
                guard expected.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 else {
                    searchHits = []
                    searching = false
                    return
                }
                searching = true
                defer {
                    if query == expected { searching = false }
                }
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled, query == expected else { return }
                let hits = await session.search(expected)
                guard !Task.isCancelled, query == expected else { return }
                searchHits = hits
            }
        }
    }

    // MARK: - Header

    /// The paired computer's profile on the left, one settings action on the
    /// right, and where you are in between. The avatar is identity, not a
    /// second hidden route to the same screen.
    private var header: some View {
        HStack(alignment: .center) {
            ProfileAvatar(name: session.connection?.name ?? "You", size: 30)
                .frame(width: 44, height: 44)
                .glassCapsule(interactive: false)
                .accessibilityLabel("Connected to \(session.connection?.name ?? "your computer")")

            Spacer(minLength: 8)

            VStack(spacing: 2) {
                Text("Chats")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.primary)
                Text(headerSubtitle)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            NavigationLink { SettingsView() } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(Color.primary)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .glassCapsule()
            .accessibilityLabel("Settings")
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 12)
    }

    private var headerSubtitle: String {
        let name = session.connection?.name ?? "Not paired"
        switch session.status {
        case .live: return "\(name) · connected"
        case .connecting: return "\(name) · connecting…"
        case .offline: return "\(name) · offline"
        case .unauthorized: return "\(name) · unpaired"
        case .unpaired: return "Not paired"
        }
    }

    // MARK: - Sidebar sections

    @ViewBuilder
    private var rosterSections: some View {
        if let chief = session.state.unsectionedChief {
            botRows(summaries(for: [chief]))
        }

        let pinned = summaries(for: session.state.pinnedBots)
        if !pinned.isEmpty {
            sectionLabel("Pinned")
                .padding(.top, 2)
                .padding(.bottom, 4)
            botRows(pinned)
        }

        channelsStrip(
            title: "Channels",
            rooms: session.state.unsectionedChannels,
            showsCreate: true
        )

        if !session.state.botChats.isEmpty {
            channelsStrip(title: "Bot chats", rooms: session.state.botChats, showsCreate: false)
        }

        let unsectioned = summaries(for: session.state.unsectionedBots)
        if !unsectioned.isEmpty {
            sectionLabel("Bots")
                .padding(.top, 18)
                .padding(.bottom, 4)
            botRows(unsectioned)
        }

        ForEach(session.state.sidebarSections) { section in
            VStack(alignment: .leading, spacing: 0) {
                sectionLabel(section.name)
                    .padding(.top, 18)
                    .padding(.bottom, section.chiefs.isEmpty && !section.channels.isEmpty ? 10 : 4)
                if !section.chiefs.isEmpty {
                    botRows(summaries(for: section.chiefs))
                }
                if !section.channels.isEmpty {
                    channelTiles(section.channels, showsCreate: false)
                        .padding(.top, section.chiefs.isEmpty ? 0 : 8)
                        .padding(.bottom, section.bots.isEmpty ? 4 : 8)
                }
                botRows(summaries(for: section.bots))
            }
        }
    }

    private func channelsStrip(title: String, rooms: [Room], showsCreate: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel(title)
            channelTiles(rooms, showsCreate: showsCreate)
        }
        .padding(.top, 2)
    }

    private func channelTiles(_ rooms: [Room], showsCreate: Bool) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(rooms) { room in
                    NavigationLink(value: Chat.room(room)) {
                        GroupTile(room: room)
                    }
                    .buttonStyle(.plain)
                }
                if showsCreate {
                    Button {
                        Haptics.selection()
                        showingNewGroup = true
                    } label: {
                        GroupTile(room: nil)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("New channel")
                }
            }
            .padding(.horizontal, 16)
        }
    }

    @ViewBuilder
    private func botRows(_ rows: [ChatSummary]) -> some View {
        ForEach(Array(rows.enumerated()), id: \.element.id) { index, summary in
            NavigationLink(value: summary.chat) {
                ChatRow(
                    chat: summary.chat,
                    preview: summary.preview,
                    at: summary.lastActivity,
                    state: MausState.forChat(summary.chat, in: session.state),
                    waiting: waitingChats.contains(summary.chat.id),
                    last: index == rows.count - 1
                )
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Bottom bar

    private var bottomBar: some View {
        GlassGroup(spacing: 8) {
            HStack(spacing: 8) {
                if searchOpen {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.secondary)
                        TextField("Search chats", text: $query)
                            .font(.system(size: 17))
                            .submitLabel(.search)
                            .autocorrectionDisabled()
                            .focused($searchFocused)
                        if !query.isEmpty {
                            Button {
                                query = ""
                            } label: {
                                Image(systemName: "xmark.circle.fill").foregroundStyle(Color.secondary)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 16)
                    .frame(height: 52)
                    .glassCapsule()

                    Button("Cancel") {
                        query = ""
                        searchOpen = false
                        searchFocused = false
                    }
                    .font(.system(size: 17))
                    .foregroundStyle(Color.primary)
                    .padding(.horizontal, 16)
                    .frame(height: 52)
                    .glassCapsule()
                } else {
                    ViewThatFits(in: .horizontal) {
                        expandedBottomActions
                        compactBottomActions
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .animation(.snappy(duration: 0.25), value: searchOpen)
    }

    private var expandedBottomActions: some View {
        HStack(spacing: 8) {
            updatesButton
                .frame(width: 180)
            searchButton
            sectionButton
            newBotButton
        }
    }

    private var compactBottomActions: some View {
        HStack(spacing: 8) {
            updatesButton
                .frame(minWidth: 148)
            searchButton
            // Creating bots and sections is the owner's, on the server's own
            // UI, when this phone is paired with a server directly.
            if session.connection?.pairedWithServer != true {
            Menu {
                Button("New section", systemImage: "folder.badge.plus", action: openNewSection)
                    .disabled(!hasVisibleBots)
                Button("New bot", systemImage: "square.and.pencil", action: createBot)
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(Color.primary)
                    .frame(width: 48, height: 48)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .glassCapsule()
            .accessibilityLabel("Create")
            }
        }
    }

    private var updatesButton: some View {
        UpdatesPill(updates: session.state.updates) {
            Haptics.selection()
            showingUpdates = true
        }
        .frame(height: 52)
    }

    private var searchButton: some View {
        GlassButton(systemImage: "magnifyingglass", size: 48, weight: .semibold) {
            Haptics.selection()
            searchOpen = true
            searchFocused = true
        }
        .accessibilityLabel("Search")
    }

    private var sectionButton: some View {
        GlassButton(systemImage: "folder.badge.plus", size: 48, weight: .medium, action: openNewSection)
            .disabled(!hasVisibleBots)
            .opacity(hasVisibleBots ? 1 : 0.45)
            .accessibilityLabel("New section")
    }

    private var newBotButton: some View {
        GlassButton(systemImage: "square.and.pencil", size: 48, weight: .medium, action: createBot)
            .accessibilityLabel("New bot")
    }

    private var hasVisibleBots: Bool {
        session.state.bots.contains { $0.hidden != true }
    }

    private func openNewSection() {
        Haptics.selection()
        showingNewSection = true
    }

    private func createBot() {
        Task {
            if let bot = await session.createBot() {
                Haptics.success()
                path.append(Chat.bot(bot))
            }
        }
    }

    // MARK: - Data

    /// The reader's activity level, which the roster preview folds by.
    private var activity: ActivityDetail { ActivityDetail(rawValue: activityDetail) ?? .full }

    private var chats: [ChatSummary] {
        let all = session.state.chatSummaries(activity: activity)
        guard !query.isEmpty else {
            // rooms live in the strip; the list is bots
            return all.filter { if case .bot = $0.chat { return true } else { return false } }
        }
        return all.filter {
            $0.chat.name.localizedCaseInsensitiveContains(query)
                || $0.chat.subtitle.localizedCaseInsensitiveContains(query)
                || $0.preview.localizedCaseInsensitiveContains(query)
        }
    }

    private func summaries(for bots: [Bot]) -> [ChatSummary] {
        let ids = Set(bots.map(\.id))
        return session.state.chatSummaries(activity: activity).filter { summary in
            if case let .bot(bot) = summary.chat { return ids.contains(bot.id) }
            return false
        }
    }

    private var waitingChats: Set<String> {
        Set(session.state.pendingApprovals.compactMap { session.state.chat(forThread: $0.threadId)?.id })
    }

    private var rosterIsEmpty: Bool {
        if query.isEmpty {
            return session.state.bots.allSatisfy { $0.hidden == true } && session.state.rooms.isEmpty
        }
        return chats.isEmpty && searchHits.isEmpty && !searching
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.system(size: 13, weight: .semibold))
            .tracking(0.4)
            .foregroundStyle(Color.secondary)
            .padding(.horizontal, 20)
    }
}

// MARK: - Rows and tiles

/// A room as a round tile: the first two members' mascots stacked, its name
/// beneath. `nil` is the "make one" tile.
struct GroupTile: View {
    let room: Room?
    @EnvironmentObject private var session: Session

    var body: some View {
        VStack(spacing: 7) {
            ZStack {
                if let room {
                    Circle().fill(Color.secondary.opacity(0.14))
                    let bots = memberBots(room)
                    if let first = bots.first {
                        BotAvatarView(bot: first, size: 34, state: .happy, animated: false)
                            .offset(x: -9, y: -6)
                    }
                    if bots.count > 1 {
                        BotAvatarView(bot: bots[1], size: 30, state: .happy, animated: false)
                            .padding(2)
                            .background(Circle().fill(Color(uiColor: .systemBackground)))
                            .offset(x: 11, y: 9)
                    }
                    if room.unread {
                        Circle()
                            .fill(MausPalette.color("blue"))
                            .frame(width: 10, height: 10)
                            .overlay(Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2))
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                            .padding(3)
                    }
                } else {
                    Circle()
                        .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                        .foregroundStyle(Color.secondary.opacity(0.6))
                    Image(systemName: "plus")
                        .font(.system(size: 22, weight: .medium))
                        .foregroundStyle(Color.secondary)
                }
            }
            .frame(width: 64, height: 64)

            Text(room?.name ?? "New channel")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(room == nil ? Color.secondary : Color.primary)
                .lineLimit(1)
        }
        .frame(width: 76)
        .contentShape(Rectangle())
    }

    private func memberBots(_ room: Room) -> [Bot] {
        room.memberIds.compactMap { session.state.bot($0) }
    }
}

struct ChatRow: View {
    let chat: Chat
    let preview: String
    let at: Double
    var state: MausState = .idle
    var waiting = false
    var last = false

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            // the unread dot, in the bot's own colour, at the very edge
            ZStack {
                if chat.unread && !chat.busy {
                    Circle()
                        .fill(MausPalette.color(chat.color))
                        .frame(width: 10, height: 10)
                }
            }
            .frame(width: 22)
            .frame(maxHeight: .infinity)

            HStack(alignment: .top, spacing: 14) {
                ChatAvatarView(chat: chat, size: 52, state: state, animated: state.showsActivity)
                    .padding(.top, 12)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(chat.name)
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(Color.primary)
                            .lineLimit(1)
                            .layoutPriority(1)

                        // the bot's job, the way the desktop shows it
                        if !chat.subtitle.isEmpty {
                            Text(chat.subtitle)
                                .font(.system(size: 13))
                                .foregroundStyle(Color.secondary)
                                .lineLimit(1)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(Capsule().fill(Color.secondary.opacity(0.15)))
                        }

                        Spacer(minLength: 4)

                        Text(RelativeStamp.list(at))
                            .font(.system(size: 15))
                            .foregroundStyle(Color.secondary)
                            .fixedSize()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.secondary.opacity(0.5))
                    }

                    HStack(alignment: .top, spacing: 8) {
                        // one line for every bot, so the rows keep one rhythm
                        Text(preview.isEmpty ? " " : preview)
                            .font(.system(size: 15))
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)

                        Spacer(minLength: 0)

                        if chat.busy {
                            ProgressView().controlSize(.mini).padding(.top, 3)
                        }
                    }

                    if waiting {
                        Label("Waiting on you", systemImage: "hand.raised.fill")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 4)
                            .background(Capsule().fill(MausPalette.color(chat.color)))
                            .padding(.top, 4)
                    }
                }
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .bottom) {
                    if !last { Divider() }
                }
            }
            .padding(.trailing, 16)
        }
        .padding(.leading, 6)
        .contentShape(Rectangle())
    }
}

/// The floating pill: who is doing what right now, at a glance.
struct UpdatesPill: View {
    let updates: [ChatUpdate]
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if !updates.isEmpty {
                    MascotStack(colors: Array(updates.prefix(3).map(\.chat.color)))
                }
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        if let first = updates.first {
                            switch first.kind {
                            case .needsYou:
                                Image(systemName: "hand.raised.fill")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundStyle(MausPalette.color(first.chat.color))
                                Text("\(first.chat.name) needs you")
                            case .working:
                                Text("\(first.chat.name) is working")
                            case .toReview:
                                Text("\(first.chat.name) has an update")
                            }
                        } else {
                            Text("All quiet")
                        }
                    }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(updates.isEmpty ? Color.secondary : Color.primary)
                    .lineLimit(1)

                    Text(subline)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.up")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Color.secondary)
            }
            .padding(.leading, updates.isEmpty ? 16 : 7)
            .padding(.trailing, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassCapsule()
        .accessibilityLabel("Updates")
    }

    private var subline: String {
        guard let first = updates.first else { return "Nothing needs you" }
        let rest = updates.count - 1
        if rest == 0 { return first.line.isEmpty ? " " : first.line }
        return rest == 1 ? "1 more update" : "\(rest) more updates"
    }
}

/// Up to three mascots overlapping, the way a group of faces reads at a glance.
struct MascotStack: View {
    let colors: [String]
    var size: CGFloat = 28
    var overlap: CGFloat = 12

    var body: some View {
        HStack(spacing: -overlap) {
            ForEach(Array(colors.enumerated()), id: \.offset) { _, color in
                MausAvatar(color: color, size: size, state: .idle, animated: false)
                    .padding(2)
                    .background(Circle().fill(Color(uiColor: .systemBackground)))
            }
        }
    }
}

/// Connection state, shown only when it is not "fine".
struct StatusBanner: View {
    @EnvironmentObject private var session: Session

    var body: some View {
        Group {
            switch session.status {
            case .live, .unpaired:
                EmptyView()
            case .connecting:
                banner("Connecting…", systemImage: "arrow.triangle.2.circlepath", tint: .secondary)
            case let .offline(reason):
                banner(reason, systemImage: "wifi.slash", tint: .orange)
            case .unauthorized:
                banner("This device was unpaired on the computer.", systemImage: "lock.slash", tint: .red)
            }
        }
        .animation(.default, value: session.status)
    }

    private func banner(_ text: String, systemImage: String, tint: Color) -> some View {
        Label(text, systemImage: systemImage)
            .font(.footnote)
            .foregroundStyle(tint)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .glassCapsule(interactive: false)
            .padding(.bottom, 8)
    }
}

struct SearchHitRow: View {
    let hit: SearchHit

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: hit.role == .user ? "person.fill" : "bubble.left.fill")
                .foregroundStyle(Color.secondary)
                .frame(width: 26, height: 26)
                .background(Circle().fill(Color.secondary.opacity(0.13)))

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(hit.name).font(.system(size: 15, weight: .semibold))
                    if let task = hit.task, !task.isEmpty {
                        Text(task).font(.system(size: 12)).foregroundStyle(Color.secondary)
                    }
                    Spacer()
                    Text(RelativeStamp.list(hit.at))
                        .font(.system(size: 12))
                        .foregroundStyle(Color.secondary)
                }
                Text(hit.snippet)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

/// Timestamps the way a messaging app writes them.
enum RelativeStamp {
    /// Roster: time today, weekday this week, date beyond that.
    static func list(_ at: Double) -> String {
        guard at > 0 else { return "" }
        let date = Date(timeIntervalSince1970: at / 1000)
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if let week = calendar.date(byAdding: .day, value: -6, to: Date()), date > week {
            return date.formatted(.dateTime.weekday(.wide))
        }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }

    /// In a transcript: enough to place a gap in the conversation.
    static func separator(_ date: Date) -> String {
        let calendar = Calendar.current
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDateInToday(date) { return "Today \(time)" }
        if calendar.isDateInYesterday(date) { return "Yesterday \(time)" }
        return "\(date.formatted(.dateTime.day().month(.abbreviated))) \(time)"
    }
}
