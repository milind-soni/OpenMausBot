import CompanionCore
import SwiftUI

/// The question card: what the bot actually asked, and its own answers.
///
/// A structured ask (Claude's `AskUserQuestion`) reaches the harness through
/// the permission channel, so before this it drew the ordinary card — a flat
/// row of buttons over "which model should this bot run on?". One tap could
/// not say WHICH question it answered, so a multi-question ask had nothing
/// tappable at all and the phone could only watch it time out.
///
/// The desktop's `src/components/QuestionCard.tsx`, in SwiftUI: a tab per
/// question, the model's options with their glosses, an "Other" row for a
/// reply it did not think of, and one submit that sends every answer at once.
/// The answer text is built by `AskQuestionAnswer.format`, so an answer given
/// here is byte-for-byte the one the Mac would have sent.
struct QuestionCardView: View {
    let chat: Chat
    let message: Message
    @EnvironmentObject private var session: Session

    /// Per question: the option labels ticked, and the free-text reply.
    @State private var picked: [Int: Set<String>] = [:]
    @State private var custom: [Int: String] = [:]
    @State private var other: Set<Int> = []
    @State private var active = 0
    @State private var answering = false
    /// The harness settles the card, but only after a round trip. Holding the
    /// sent answer closes the window where the buttons are still live.
    @State private var sent: String?
    @FocusState private var otherFocused: Bool

    private var tint: Color { MausPalette.color(chat.color) }

    private var card: OptionCard? { message.card }
    private var questions: [AskQuestion] { card?.questions ?? [] }

    private var index: Int { min(active, max(questions.count - 1, 0)) }
    private var current: AskQuestion? { questions.indices.contains(index) ? questions[index] : nil }

    /// An open "Other" field with nothing in it is not an answer.
    private func answers(for position: Int) -> [String] {
        var chosen = Array(picked[position] ?? []).sorted()
        if other.contains(position) {
            let typed = (custom[position] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !typed.isEmpty { chosen.append(typed) }
        }
        return chosen
    }

    private func isAnswered(_ position: Int) -> Bool { !answers(for: position).isEmpty }
    private var complete: Bool { questions.indices.allSatisfy(isAnswered) }
    private var answeredCount: Int { questions.indices.filter(isAnswered).count }
    private var settled: Bool { (card?.answered != nil) || sent != nil }

    var body: some View {
        if let card, !questions.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                header(card)
                if questions.count > 1 { tabs }
                if let current {
                    Text(current.question)
                        .font(.system(size: 15))
                        .foregroundStyle(Color.primary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    if !settled {
                        if current.allowsMultiple {
                            Text("Choose all that apply")
                                .font(.system(size: 12))
                                .foregroundStyle(Color.secondary)
                        }
                        choices(current)
                    }
                }
                if settled {
                    answeredSummary(card)
                } else {
                    submit
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(settled ? Color.secondary.opacity(0.13) : tint.opacity(0.12))
            )
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(settled ? .clear : tint, lineWidth: 1.5)
            }
        }
    }

    @ViewBuilder
    private func header(_ card: OptionCard) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Label("\(chat.name) has a question", systemImage: "questionmark.bubble.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(settled ? Color.secondary : tint)
            Spacer(minLength: 8)
            if questions.count > 1, !settled {
                Text("\(answeredCount) of \(questions.count)")
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundStyle(Color.secondary)
            }
        }
    }

    private var tabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(questions.enumerated()), id: \.offset) { position, question in
                    Button {
                        Haptics.selection()
                        active = position
                    } label: {
                        HStack(spacing: 4) {
                            if isAnswered(position) {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 10, weight: .bold))
                            }
                            Text(question.tabLabel(position: position + 1))
                                .font(.system(size: 13, weight: position == index ? .semibold : .regular))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(
                            Capsule().fill(position == index ? Color.secondary.opacity(0.22) : Color.clear)
                        )
                        .foregroundStyle(position == index ? Color.primary : Color.secondary)
                    }
                    .buttonStyle(.plain)
                    .disabled(settled)
                }
            }
        }
    }

    @ViewBuilder
    private func choices(_ question: AskQuestion) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(question.options.enumerated()), id: \.offset) { position, option in
                if position > 0 { Divider().opacity(0.4) }
                row(
                    label: option.label,
                    detail: option.detail,
                    checked: picked[index]?.contains(option.label) == true,
                    multi: question.allowsMultiple
                ) { choose(option.label, in: question) }
            }
            if !question.options.isEmpty { Divider().opacity(0.4) }
            row(
                label: String(localized: "Other"),
                detail: nil,
                checked: other.contains(index),
                multi: question.allowsMultiple
            ) { toggleOther(question) }
            if other.contains(index) {
                Divider().opacity(0.4)
                TextField("Type your own answer", text: binding(forCustom: index), axis: .vertical)
                    .font(.system(size: 15))
                    .lineLimit(1...4)
                    .focused($otherFocused)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.secondary.opacity(0.10))
        )
    }

    @ViewBuilder
    private func row(
        label: String,
        detail: String?,
        checked: Bool,
        multi: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: {
            Haptics.selection()
            action()
        }) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: marker(checked: checked, multi: multi))
                    .font(.system(size: 17))
                    .foregroundStyle(checked ? tint : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Color.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(.system(size: 13))
                            .foregroundStyle(Color.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(answering)
        .accessibilityAddTraits(checked ? [.isSelected] : [])
    }

    private func marker(checked: Bool, multi: Bool) -> String {
        if multi { return checked ? "checkmark.square.fill" : "square" }
        return checked ? "largecircle.fill.circle" : "circle"
    }

    private var submit: some View {
        Button {
            Haptics.selection()
            send()
        } label: {
            Text(questions.count > 1 ? "Submit answers" : "Submit answer")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
                .background(Capsule().fill(complete ? tint : Color.secondary.opacity(0.35)))
        }
        .buttonStyle(.plain)
        .disabled(!complete || answering)
        .padding(.top, 2)
    }

    @ViewBuilder
    private func answeredSummary(_ card: OptionCard) -> some View {
        let answer = card.answeredText ?? sent
        Label {
            Text(answer.map(AskQuestionAnswer.withoutPreamble) ?? String(localized: "Answered"))
                .font(.system(size: 14))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "checkmark.circle")
        }
        .foregroundStyle(Color.secondary)
    }

    private func binding(forCustom position: Int) -> Binding<String> {
        Binding(get: { custom[position] ?? "" }, set: { custom[position] = $0 })
    }

    private func choose(_ label: String, in question: AskQuestion) {
        guard !settled else { return }
        var chosen = picked[index] ?? []
        if question.allowsMultiple {
            if chosen.contains(label) { chosen.remove(label) } else { chosen.insert(label) }
            picked[index] = chosen
            return
        }
        // Single-select is a radio group: picking replaces, and picking an
        // option means the free-text answer was not the one they wanted.
        picked[index] = [label]
        other.remove(index)
        otherFocused = false
        // Move to the next question they still owe an answer to. The last one
        // stays put so the submit button is under the thumb that just chose.
        if let next = questions.indices.first(where: { $0 != index && !isAnswered($0) }) {
            active = next
        }
    }

    private func toggleOther(_ question: AskQuestion) {
        guard !settled else { return }
        if other.contains(index) {
            other.remove(index)
            otherFocused = false
            return
        }
        other.insert(index)
        if !question.allowsMultiple { picked[index] = [] }
        otherFocused = true
    }

    private func send() {
        guard !settled, complete, let card, let requestId = card.requestId else { return }
        let answer = AskQuestionAnswer.format(
            questions: questions,
            answers: questions.indices.map(answers(for:))
        )
        guard !answer.isEmpty else { return }
        sent = answer
        answering = true
        otherFocused = false
        Task {
            // A question only ever answers with text; the harness rejects an
            // allow/deny on one, so this never takes the permission path.
            await session.answer(
                threadId: chat.threadId,
                requestId: requestId,
                choice: answer,
                isPermission: false
            )
            answering = false
        }
    }
}
