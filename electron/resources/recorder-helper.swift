import AppKit
import ApplicationServices
import Foundation

struct Context {
    let app: String
    let windowTitle: String
}

final class Recorder {
    private let stopFile: String
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var timer: Timer?
    private var lastContext = Context(app: "", windowTitle: "")
    private let startedAt = ProcessInfo.processInfo.systemUptime

    // System-wide AX element used for click hit-tests and focus queries.
    private let systemWide = AXUIElementCreateSystemWide()

    // Typing aggregation state (privacy: plain keycodes never leave this process).
    private var typingCount = 0
    private var typingContext = Context(app: "", windowTitle: "")
    private var typingStartMs = 0
    private var lastTypingMs = 0

    // Secure-field focus cache (~250ms).
    private var secureCachedMs = -1_000_000
    private var secureCachedValue = false

    // Clipboard correlation state.
    private var pendingClip: (op: String, baseline: Int, atMs: Int, ctx: Context)?

    // Downloads polling state.
    private let downloadsURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
    private var knownDownloads: Set<String> = []
    private let partialExtensions: Set<String> = ["crdownload", "download", "part", "tmp"]

    init(stopFile: String) {
        self.stopFile = stopFile
    }

    private func nowMs() -> Int {
        return Int((ProcessInfo.processInfo.systemUptime - startedAt) * 1000)
    }

    private func context() -> Context {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            return Context(app: "", windowTitle: "")
        }
        let appName = app.localizedName ?? ""
        let element = AXUIElementCreateApplication(app.processIdentifier)
        var focused: CFTypeRef?
        var title = ""
        if AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &focused) == .success,
           let window = focused,
           CFGetTypeID(window) == AXUIElementGetTypeID() {
            var value: CFTypeRef?
            let windowElement = window as! AXUIElement
            if AXUIElementCopyAttributeValue(windowElement, kAXTitleAttribute as CFString, &value) == .success,
               let string = value as? String {
                title = String(string.prefix(240))
            }
        }
        return Context(app: appName, windowTitle: title)
    }

    private func emit(_ values: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(values),
              let data = try? JSONSerialization.data(withJSONObject: values),
              let line = String(data: data, encoding: .utf8) else { return }
        FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
        fflush(stdout)
    }

    private func emitContextIfChanged(force: Bool = false) -> Context {
        let current = context()
        if force || current.app != lastContext.app || current.windowTitle != lastContext.windowTitle {
            // Any in-flight typing burst belongs to the OLD context; flush it before
            // announcing the new context so events stay in timeline order.
            flushTyping()
            lastContext = current
            emit(["type": "app", "atMs": nowMs(), "app": current.app, "windowTitle": current.windowTitle])
        }
        return current
    }

    // MARK: - Typing aggregation

    private func flushTyping() {
        guard typingCount > 0 else { return }
        emit([
            "type": "typing",
            "atMs": typingStartMs,
            "app": typingContext.app,
            "windowTitle": typingContext.windowTitle,
            "keyCount": typingCount,
        ])
        typingCount = 0
    }

    private func handlePlainKey() {
        // Never count keystrokes while a secure text field is focused.
        if isSecureFieldFocused() {
            flushTyping()
            return
        }
        // emitContextIfChanged flushes the old burst if the context changed.
        let current = emitContextIfChanged()
        if typingCount > 0 && (current.app != typingContext.app || current.windowTitle != typingContext.windowTitle) {
            flushTyping()
        }
        if typingCount == 0 {
            typingContext = current
            typingStartMs = nowMs()
        }
        typingCount += 1
        lastTypingMs = nowMs()
    }

    // MARK: - Secure field detection

    private func isSecureFieldFocused() -> Bool {
        let t = nowMs()
        if t - secureCachedMs < 250 {
            return secureCachedValue
        }
        secureCachedMs = t
        var focused: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(systemWide, "AXFocusedUIElement" as CFString, &focused)
        // Deny by default: if focus cannot be determined, suppress content-
        // adjacent events rather than risk treating a password field as safe.
        guard err == .success, let focusedRef = focused,
              CFGetTypeID(focusedRef) == AXUIElementGetTypeID() else {
            secureCachedValue = true
            return true
        }
        let element = focusedRef as! AXUIElement
        secureCachedValue = (axString(element, "AXRole") == "AXSecureTextField")
        return secureCachedValue
    }

    // MARK: - AX helpers

    private func axString(_ el: AXUIElement, _ attr: String) -> String? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &ref) == .success,
              let value = ref, let string = value as? String, !string.isEmpty else { return nil }
        return string
    }

    private func axPoint(_ el: AXUIElement, _ attr: String) -> CGPoint? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &ref) == .success,
              let value = ref, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        let axValue = value as! AXValue
        guard AXValueGetType(axValue) == .cgPoint else { return nil }
        var point = CGPoint.zero
        return AXValueGetValue(axValue, .cgPoint, &point) ? point : nil
    }

    private func axSize(_ el: AXUIElement, _ attr: String) -> CGSize? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &ref) == .success,
              let value = ref, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        let axValue = value as! AXValue
        guard AXValueGetType(axValue) == .cgSize else { return nil }
        var size = CGSize.zero
        return AXValueGetValue(axValue, .cgSize, &size) ? size : nil
    }

    /// Hit-test the click point and attach AX element identity. All fields are
    /// optional: any failed/timed-out copy is simply omitted. Never blocks (the
    /// 0.4s system-wide messaging timeout guards every call) and never crashes.
    private func addElementIdentity(_ values: inout [String: Any], x: CGFloat, y: CGFloat, secure: Bool) {
        var elRef: AXUIElement?
        guard AXUIElementCopyElementAtPosition(systemWide, Float(x), Float(y), &elRef) == .success,
              let el = elRef else { return }

        var elementIsSecure = false
        if let role = axString(el, "AXRole") {
            values["role"] = role
            if role == "AXSecureTextField" { elementIsSecure = true }
        }

        // Content-bearing fields (name/identifier/ancestry) are omitted whenever a
        // secure field is focused OR the hit element is itself a secure field.
        let omitContent = secure || elementIsSecure
        if !omitContent {
            // AXValue is deliberately excluded: for text fields it is the
            // user's entered text, which would reconstruct what they typed.
            if let name = axString(el, "AXTitle") ?? axString(el, "AXDescription") {
                values["name"] = String(name.prefix(120))
            }
            if let identifier = axString(el, "AXIdentifier") {
                values["identifier"] = identifier
            }
            var ancestry: [String] = []
            var current: AXUIElement = el
            for _ in 0..<4 {
                var parentRef: CFTypeRef?
                guard AXUIElementCopyAttributeValue(current, "AXParent" as CFString, &parentRef) == .success,
                      let pRef = parentRef, CFGetTypeID(pRef) == AXUIElementGetTypeID() else { break }
                let parent = pRef as! AXUIElement
                let role = axString(parent, "AXRole") ?? ""
                let name = axString(parent, "AXTitle") ?? axString(parent, "AXDescription") ?? ""
                ancestry.append("\(role):\(String(name.prefix(120)))")
                current = parent
            }
            if !ancestry.isEmpty {
                values["ancestry"] = ancestry
            }
        }

        // Geometry is safe to record even for secure fields.
        if let position = axPoint(el, "AXPosition"), let size = axSize(el, "AXSize") {
            values["bbox"] = [
                "x": Int(position.x),
                "y": Int(position.y),
                "w": Int(size.width),
                "h": Int(size.height),
            ]
        }
    }

    // MARK: - Clipboard

    private func trackClipboardChord(keycode: Int, meta: Bool, ctx: Context) {
        guard meta else { return }
        switch keycode {
        case 8: // C
            pendingClip = (op: "copy", baseline: NSPasteboard.general.changeCount, atMs: nowMs(), ctx: ctx)
        case 7: // X
            pendingClip = (op: "cut", baseline: NSPasteboard.general.changeCount, atMs: nowMs(), ctx: ctx)
        case 9: // V — paste never changes the pasteboard, so emit immediately.
            emit([
                "type": "clipboard",
                "atMs": nowMs(),
                "app": ctx.app,
                "windowTitle": ctx.windowTitle,
                "op": "paste",
            ])
        default:
            break
        }
    }

    private func resolvePendingClipboard() {
        guard let pending = pendingClip else { return }
        // Only a changeCount bump confirms the copy/cut actually happened.
        if NSPasteboard.general.changeCount != pending.baseline {
            emit([
                "type": "clipboard",
                "atMs": pending.atMs,
                "app": pending.ctx.app,
                "windowTitle": pending.ctx.windowTitle,
                "op": pending.op,
            ])
            pendingClip = nil
        } else if nowMs() - pending.atMs > 1500 {
            pendingClip = nil // no bump within the window; give up.
        }
    }

    // MARK: - Downloads

    private func baselineDownloads() {
        guard let dir = downloadsURL,
              let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }
        knownDownloads = Set(names)
    }

    private func checkDownloads() {
        guard let dir = downloadsURL,
              let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }
        for name in names where !knownDownloads.contains(name) {
            knownDownloads.insert(name)
            if name.hasPrefix(".") { continue }
            let ext = (name as NSString).pathExtension.lowercased()
            if partialExtensions.contains(ext) { continue } // still downloading
            let path = dir.appendingPathComponent(name).path
            emit([
                "type": "download",
                "atMs": nowMs(),
                "filename": name,
                "whereFroms": readWhereFroms(path),
            ])
        }
    }

    private func readWhereFroms(_ path: String) -> [String] {
        guard let item = MDItemCreate(kCFAllocatorDefault, path as CFString),
              let value = MDItemCopyAttribute(item, kMDItemWhereFroms) else { return [] }
        let strings: [String]
        if let values = value as? [String] {
            strings = values
        } else if let values = value as? [Any] {
            strings = values.compactMap { $0 as? String }
        } else {
            return []
        }
        // Download metadata can contain signed query strings, credentials,
        // fragments, or local file URLs. Only the web origin is useful to a
        // reusable skill, so strip everything else before it leaves native.
        return strings.compactMap { raw in
            guard var components = URLComponents(string: raw),
                  let scheme = components.scheme?.lowercased(),
                  (scheme == "https" || scheme == "http"),
                  components.host != nil else { return nil }
            components.user = nil
            components.password = nil
            components.path = ""
            components.query = nil
            components.fragment = nil
            return components.string
        }
    }

    // MARK: - Event handling

    func handle(type: CGEventType, event: CGEvent) {
        // Plain typing keys are aggregated in-process and never emitted as keycodes.
        if type == .keyDown {
            let flags = event.flags
            let isChord = flags.contains(.maskCommand) || flags.contains(.maskControl) || flags.contains(.maskAlternate)
            if !isChord {
                handlePlainKey()
                return
            }
        }

        // Any non-typing event ends the current typing burst.
        flushTyping()
        let current = emitContextIfChanged()
        let secure = isSecureFieldFocused()

        switch type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            let point = event.location
            var values: [String: Any] = [
                "type": "click",
                "atMs": nowMs(),
                "app": current.app,
                "windowTitle": current.windowTitle,
                "x": Int(point.x),
                "y": Int(point.y),
                "button": type == .leftMouseDown ? "left" : type == .rightMouseDown ? "right" : "other",
            ]
            addElementIdentity(&values, x: point.x, y: point.y, secure: secure)
            emit(values)
        case .scrollWheel:
            emit([
                "type": "scroll",
                "atMs": nowMs(),
                "app": current.app,
                "windowTitle": current.windowTitle,
                "deltaY": event.getIntegerValueField(.scrollWheelEventDeltaAxis1),
            ])
        case .keyDown:
            // Chord (has command/control/option). Keycodes here are shortcut names,
            // not typed content, so they are safe to emit — unless a secure field is
            // focused, in which case both the chord and any clipboard op are suppressed.
            let flags = event.flags
            let meta = flags.contains(.maskCommand)
            let keycode = Int(event.getIntegerValueField(.keyboardEventKeycode))
            if secure { break }
            trackClipboardChord(keycode: keycode, meta: meta, ctx: current)
            emit([
                "type": "key",
                "atMs": nowMs(),
                "app": current.app,
                "windowTitle": current.windowTitle,
                "keycode": keycode,
                "meta": meta,
                "control": flags.contains(.maskControl),
                "option": flags.contains(.maskAlternate),
                "shift": flags.contains(.maskShift),
            ])
        default:
            return
        }
    }

    func start() -> Bool {
        // One-time short messaging timeout so click hit-tests and focus queries can
        // never hang the tap callback on a slow/unresponsive target app.
        AXUIElementSetMessagingTimeout(systemWide, 0.4)
        baselineDownloads()

        let mask = (1 << CGEventType.leftMouseDown.rawValue)
            | (1 << CGEventType.rightMouseDown.rawValue)
            | (1 << CGEventType.otherMouseDown.rawValue)
            | (1 << CGEventType.scrollWheel.rawValue)
            | (1 << CGEventType.keyDown.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, refcon in
            guard let refcon = refcon else { return Unmanaged.passUnretained(event) }
            let recorder = Unmanaged<Recorder>.fromOpaque(refcon).takeUnretainedValue()
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                if let tap = recorder.tap {
                    CGEvent.tapEnable(tap: tap, enable: true)
                }
                return Unmanaged.passUnretained(event)
            }
            recorder.handle(type: type, event: event)
            return Unmanaged.passUnretained(event)
        }
        tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: CGEventMask(mask),
            callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        )
        guard let tap = tap else { return false }
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        _ = emitContextIfChanged(force: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            if FileManager.default.fileExists(atPath: self.stopFile) {
                self.flushTyping()
                CFRunLoopStop(CFRunLoopGetMain())
                return
            }
            // End a typing burst that has gone idle.
            if self.typingCount > 0 && self.nowMs() - self.lastTypingMs > 1200 {
                self.flushTyping()
            }
            self.resolvePendingClipboard()
            self.checkDownloads()
            _ = self.emitContextIfChanged()
        }
        return true
    }
}

func argument(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

guard let stopFile = argument("--stop-file") else {
    fputs("missing --stop-file\n", stderr)
    exit(2)
}
let trustOptions = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
guard AXIsProcessTrustedWithOptions(trustOptions) else {
    fputs("Allow OpenMausBot Recorder in Privacy & Security → Accessibility, then try again. Input Monitoring may also be requested.\n", stderr)
    exit(3)
}
let recorder = Recorder(stopFile: stopFile)
guard recorder.start() else {
    fputs("input monitoring permission is required\n", stderr)
    exit(4)
}
RunLoop.main.run()
