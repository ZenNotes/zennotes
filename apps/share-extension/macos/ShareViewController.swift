import Cocoa
import OSLog
import UniformTypeIdentifiers

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "ZenNotesShare", category: "share")

/// What the sharing app handed over: a page (its link and usually its title),
/// text, or both when Safari shares a page with a selection.
private struct SharedContent {
    var url: URL?
    var title: String?
    var text: String?
}

/// One vault the sheet offers, from the `vaults.json` the app keeps in the
/// share inbox (apps/desktop/src/main/share-inbox.ts).
private struct VaultChoice {
    let id: String
    let name: String
    let kind: String
    let detail: String?

    var label: String {
        guard kind == "remote" else { return name }
        return detail.map { "\(name) (\($0))" } ?? name
    }
}

private let maxText = 1_000_000

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

/// Share > ZenNotes. The sheet previews what is shared, takes an optional
/// note line and a vault, and on Save leaves the share as one JSON file in
/// the share inbox, the one folder its sandbox opens to it. The extension
/// reaches no vault: ZenNotes files the share in Quick Notes, at once when it
/// is running and the next time it opens when it is not.
@objc(ShareViewController)
final class ShareViewController: NSViewController {
    private let titleLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(labelWithString: "")
    private let excerptLabel = NSTextField(wrappingLabelWithString: "")
    private let noteField = NSTextField()
    private let vaultMenu = NSPopUpButton()
    private let vaultHint = NSTextField(labelWithString: "")
    private var vaultRow: NSStackView!
    private let notice = NSTextField(wrappingLabelWithString: "")
    private let saveButton = NSButton(title: "Save", target: nil, action: nil)
    private let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)

    private var content = SharedContent()
    private var keyMonitor: Any?
    private var vaults: [VaultChoice] = []
    private var appRunning = true
    private var saved = false

    private var info: [String: Any] { Bundle.main.infoDictionary ?? [:] }
    private var shareInbox: String? { info["ZenNotesShareInbox"] as? String }
    private var appBundleIdentifier: String? { info["ZenNotesAppBundleIdentifier"] as? String }
    private static let lastVaultKey = "lastVault"

    override func loadView() {
        let icon = NSImageView()
        icon.image = Bundle.main.image(forResource: "icon")
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.widthAnchor.constraint(equalToConstant: 28).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 28).isActive = true
        let heading = NSTextField(labelWithString: "Save to Quick Notes")
        heading.font = .boldSystemFont(ofSize: 14)
        let header = NSStackView(views: [icon, heading])
        header.spacing = 8

        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.maximumNumberOfLines = 2
        titleLabel.cell?.wraps = true
        detailLabel.font = .systemFont(ofSize: 11)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.lineBreakMode = .byTruncatingMiddle
        excerptLabel.font = .systemFont(ofSize: 12)
        excerptLabel.textColor = .secondaryLabelColor
        excerptLabel.maximumNumberOfLines = 6
        excerptLabel.lineBreakMode = .byWordWrapping
        excerptLabel.cell?.truncatesLastVisibleLine = true
        let bar = NSBox()
        bar.boxType = .custom
        bar.fillColor = .tertiaryLabelColor
        bar.borderWidth = 0
        bar.widthAnchor.constraint(equalToConstant: 2).isActive = true
        let excerpt = NSStackView(views: [bar, excerptLabel])
        excerpt.alignment = .top
        excerpt.distribution = .fill
        excerpt.spacing = 8
        bar.heightAnchor.constraint(equalTo: excerptLabel.heightAnchor).isActive = true
        excerpt.identifier = NSUserInterfaceItemIdentifier("excerpt")

        let preview = NSStackView(views: [titleLabel, detailLabel, excerpt])
        preview.orientation = .vertical
        preview.alignment = .leading
        preview.spacing = 4

        noteField.placeholderString = "Add a note (optional)"
        noteField.setAccessibilityLabel("Note")
        noteField.lineBreakMode = .byTruncatingTail
        noteField.usesSingleLineMode = true
        // Return in the note line saves. The field editor takes Return before
        // the window's default button would see it.
        noteField.target = self
        noteField.action = #selector(save(_:))

        let vaultLabel = NSTextField(labelWithString: "Vault")
        vaultLabel.textColor = .secondaryLabelColor
        vaultMenu.setAccessibilityLabel("Vault")
        vaultMenu.target = self
        vaultMenu.action = #selector(vaultChanged)
        vaultHint.font = .systemFont(ofSize: 11)
        vaultHint.textColor = .tertiaryLabelColor
        vaultRow = NSStackView(views: [vaultLabel, vaultMenu, vaultHint])
        vaultRow.spacing = 8
        vaultRow.isHidden = true

        notice.font = .systemFont(ofSize: 11)
        notice.textColor = .secondaryLabelColor
        notice.isHidden = true

        cancelButton.target = self
        cancelButton.action = #selector(cancel(_:))
        cancelButton.keyEquivalent = "\u{1b}"
        saveButton.target = self
        saveButton.action = #selector(save(_:))
        saveButton.keyEquivalent = "\r"
        saveButton.isEnabled = false
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let buttons = NSStackView(views: [spacer, cancelButton, saveButton])
        buttons.spacing = 8

        let stack = NSStackView(views: [header, preview, noteField, vaultRow, notice, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 18, left: 20, bottom: 18, right: 20)
        stack.setCustomSpacing(16, after: preview)
        for view in [preview, noteField, notice, buttons] {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40).isActive = true
        }
        stack.translatesAutoresizingMaskIntoConstraints = false

        let root = NSView()
        root.addSubview(stack)
        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(equalToConstant: 440),
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            stack.topAnchor.constraint(equalTo: root.topAnchor),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor)
        ])
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        if let appBundleIdentifier {
            appRunning = !NSRunningApplication.runningApplications(withBundleIdentifier: appBundleIdentifier).isEmpty
        }
        loadVaults()
        loadContent()
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        view.window?.defaultButtonCell = saveButton.cell as? NSButtonCell
        view.window?.makeFirstResponder(noteField)
        // Cmd+1 to Cmd+9 pick a vault from anywhere in the sheet: with macOS's
        // default keyboard settings Tab never reaches a pop-up button.
        keyMonitor = keyMonitor ?? NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, event.window === self.view.window,
                  event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                  let digit = event.charactersIgnoringModifiers.flatMap(Int.init),
                  digit >= 1, digit <= min(9, self.vaults.count) else { return event }
            self.vaultMenu.selectItem(at: digit - 1)
            self.vaultChanged()
            return nil
        }
    }

    override func viewWillDisappear() {
        super.viewWillDisappear()
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
    }

    // MARK: What was shared

    private func loadContent() {
        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        let group = DispatchGroup()
        // Every load lands on the main queue, so these need no lock; the HTML
        // reader in plainText(from:type:) must run there anyway.
        var urls: [URL] = []
        var texts: [String] = []
        var page: [String: Any]?
        var title: String?
        var contentText: String?

        for item in items {
            if let value = item.attributedTitle?.string.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                title = title ?? value
            }
            if let value = item.attributedContentText?.string.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                contentText = contentText ?? value
            }
            for provider in item.attachments ?? [] {
                log.info("shared item types: \(provider.registeredTypeIdentifiers.joined(separator: ","), privacy: .public)")
                if provider.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier) {
                    // Safari ran ShareExtensionPreprocessing.js on the page: its
                    // title, address and selection, exactly as the page has them.
                    group.enter()
                    provider.loadItem(forTypeIdentifier: UTType.propertyList.identifier, options: nil) { item, _ in
                        let results = (item as? [String: Any])?[NSExtensionJavaScriptPreprocessingResultsKey] as? [String: Any]
                        DispatchQueue.main.async {
                            page = page ?? results
                            group.leave()
                        }
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    group.enter()
                    provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
                        let url = (item as? URL) ?? (item as? Data).flatMap { URL(dataRepresentation: $0, relativeTo: nil) }
                        DispatchQueue.main.async {
                            if let url, Self.isWebLink(url) { urls.append(url) }
                            group.leave()
                        }
                    }
                } else if let type = Self.textType(of: provider) {
                    // Other apps send a selection as plain text, RTF or HTML.
                    group.enter()
                    provider.loadItem(forTypeIdentifier: type.identifier, options: nil) { item, _ in
                        let data = item as? Data
                        let value = item as? String ?? (item as? NSAttributedString)?.string
                        DispatchQueue.main.async {
                            if let text = value ?? data.flatMap({ Self.plainText(from: $0, type: type) }),
                               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                texts.append(text)
                            }
                            group.leave()
                        }
                    }
                }
            }
        }

        group.notify(queue: .main) { [weak self] in
            guard let self else { return }
            var shared = SharedContent()
            if let page {
                shared.url = (page["url"] as? String).flatMap(URL.init(string:)).flatMap { Self.isWebLink($0) ? $0 : nil }
                shared.title = (page["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
                if let selection = (page["selection"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty {
                    texts.insert(selection, at: 0)
                }
            }
            shared.url = shared.url ?? urls.first
            shared.title = shared.title ?? title
            // Without the page script, a link's content text is most often the
            // page title (one short line); anything longer is what was selected.
            if let contentText, contentText != shared.title, contentText != shared.url?.absoluteString {
                if shared.url != nil, shared.title == nil, !contentText.contains("\n"), contentText.count <= 300 {
                    shared.title = contentText
                } else if texts.isEmpty {
                    texts.append(contentText)
                }
            }
            let text = texts.joined(separator: "\n\n")
            shared.text = text.isEmpty ? nil : String(text.prefix(maxText))
            self.content = shared
            log.info("shared: url \(shared.url != nil), title \(shared.title != nil), page script \(page != nil), text \(shared.text?.count ?? 0) chars")
            self.showContent()
        }
    }

    private static func isWebLink(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }

    /// The text type to load from an attachment, plain text first. A file
    /// shared from Finder is out of scope, even a Markdown one.
    private static func textType(of provider: NSItemProvider) -> UTType? {
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) { return nil }
        return [UTType.utf8PlainText, .plainText, .rtf, .html, .text].first {
            provider.hasItemConformingToTypeIdentifier($0.identifier)
        }
    }

    private static func plainText(from data: Data, type: UTType) -> String? {
        if type.conforms(to: .rtf) { return NSAttributedString(rtf: data, documentAttributes: nil)?.string }
        if type.conforms(to: .html) { return NSAttributedString(html: data, documentAttributes: nil)?.string }
        return String(data: data, encoding: .utf8)
    }

    private func showContent() {
        let url = content.url
        let firstLine = content.text?
            .split(separator: "\n", omittingEmptySubsequences: true)
            .first.map { $0.trimmingCharacters(in: .whitespaces) }
        titleLabel.stringValue = content.title ?? (url == nil ? firstLine : nil) ?? url?.host ?? "Shared text"
        detailLabel.stringValue = url.map { $0.host ?? $0.absoluteString } ?? ""
        detailLabel.isHidden = url == nil
        let excerptText = url == nil && content.title == nil
            ? content.text?.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: true).dropFirst().first.map(String.init)
            : content.text
        excerptLabel.stringValue = excerptText ?? ""
        (excerptLabel.superview as? NSStackView)?.isHidden = (excerptText ?? "").isEmpty
        saveButton.isEnabled = url != nil || content.text != nil
        updateNotice()
        #if SHARE_SELFTEST
        let marker = [content.title, content.text, url?.absoluteString].compactMap { $0 }.joined(separator: " ")
        log.error("selftest received: title=\(self.content.title ?? "-", privacy: .public) url=\(url?.absoluteString ?? "-", privacy: .public) text=\(self.content.text?.prefix(80) ?? "-", privacy: .public)")
        if marker.contains("share-selftest-save") {
            noteField.stringValue = "selftest note"
            save(nil)
        } else if marker.contains("share-selftest-keys") {
            // Cmd+2 picks the second vault, "ok" goes in the note line, Return saves.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.postKeys([("2", 19, .command), ("o", 31, []), ("k", 40, []), ("\r", 36, [])])
            }
        } else if marker.contains("share-selftest-escape") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.postKeys([("\u{1b}", 53, [])])
            }
        }
        #endif
    }

    #if SHARE_SELFTEST
    /// Real key events through the sheet's own event handling, so the
    /// self-test proves the keyboard path, not just the save.
    private func postKeys(_ keys: [(String, UInt16, NSEvent.ModifierFlags)]) {
        guard let window = view.window else {
            log.error("selftest keys: the sheet has no window")
            return
        }
        for (characters, keyCode, flags) in keys {
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                if let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode) {
                    NSApp.postEvent(event, atStart: false)
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            log.error("selftest keys: vault \(self?.selectedVault?.id ?? "-", privacy: .public) note \(self?.noteField.stringValue ?? "-", privacy: .public) saved \(self?.saved ?? false)")
        }
    }
    #endif

    // MARK: Vaults

    /// The inbox in the real home folder: inside the sandbox NSHomeDirectory()
    /// is the extension's own container.
    private func inboxFolder() -> URL? {
        guard let shareInbox, let entry = getpwuid(getuid()), let home = entry.pointee.pw_dir else { return nil }
        return URL(fileURLWithPath: String(cString: home), isDirectory: true)
            .appendingPathComponent(shareInbox, isDirectory: true)
    }

    private func loadVaults() {
        defer { updateNotice() }
        guard let folder = inboxFolder(),
              let data = try? Data(contentsOf: folder.appendingPathComponent("vaults.json")),
              let file = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = file["vaults"] as? [[String: Any]] else { return }
        vaults = list.compactMap { entry in
            guard let id = entry["id"] as? String, let name = entry["name"] as? String else { return nil }
            return VaultChoice(id: id, name: name, kind: entry["kind"] as? String ?? "local", detail: entry["detail"] as? String)
        }
        guard !vaults.isEmpty else { return }
        vaultMenu.removeAllItems()
        for (index, vault) in vaults.enumerated() {
            vaultMenu.addItem(withTitle: vault.label)
            if index < 9, let item = vaultMenu.lastItem {
                item.keyEquivalent = String(index + 1)
                item.keyEquivalentModifierMask = .command
            }
        }
        let remembered = UserDefaults.standard.string(forKey: Self.lastVaultKey)
        let current = file["current"] as? String
        let selected = vaults.firstIndex { $0.id == remembered } ?? vaults.firstIndex { $0.id == current } ?? 0
        vaultMenu.selectItem(at: selected)
        vaultRow.isHidden = vaults.count < 2
        vaultHint.stringValue = "\u{2318}1 to \u{2318}\(min(9, vaults.count))"
    }

    private var selectedVault: VaultChoice? {
        let index = vaultMenu.indexOfSelectedItem
        return vaults.indices.contains(index) ? vaults[index] : nil
    }

    @objc private func vaultChanged() {
        updateNotice()
    }

    private func updateNotice(error: String? = nil) {
        if let error {
            notice.stringValue = error
            notice.textColor = .systemRed
            notice.isHidden = false
            return
        }
        notice.textColor = .secondaryLabelColor
        if selectedVault?.kind == "remote" {
            notice.stringValue = "ZenNotes files it in Quick Notes once it is connected to this server."
        } else if !appRunning {
            notice.stringValue = "ZenNotes files it in Quick Notes the next time it opens."
        } else {
            notice.stringValue = ""
        }
        notice.isHidden = notice.stringValue.isEmpty
    }

    // MARK: Save and cancel

    @objc private func save(_ sender: Any?) {
        guard !saved, saveButton.isEnabled else { return }
        do {
            try writeCapture()
        } catch {
            log.error("could not save the share: \(error.localizedDescription, privacy: .public)")
            updateNotice(error: "Could not save: \(error.localizedDescription)")
            return
        }
        saved = true
        if let vault = selectedVault { UserDefaults.standard.set(vault.id, forKey: Self.lastVaultKey) }
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }

    @objc private func cancel(_ sender: Any?) {
        extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }

    override func cancelOperation(_ sender: Any?) {
        cancel(sender)
    }

    private func writeCapture() throws {
        guard let folder = inboxFolder() else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSLocalizedDescriptionKey: "the ZenNotes share inbox is unavailable"])
        }
        let captures = folder.appendingPathComponent("Captures", isDirectory: true)
        try FileManager.default.createDirectory(at: captures, withIntermediateDirectories: true)
        let id = UUID().uuidString.lowercased()
        let now = Date()
        var record: [String: Any] = [
            "version": 1,
            "id": id,
            "createdAt": Int64(now.timeIntervalSince1970 * 1000),
            "vault": selectedVault?.id ?? NSNull()
        ]
        if let url = content.url { record["url"] = url.absoluteString }
        if let title = content.title { record["title"] = title }
        if let text = content.text { record["text"] = text }
        let note = noteField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if !note.isEmpty { record["note"] = note }
        let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
        // The name starts with the time so the app files shares in order; the
        // app ignores dot files, so it never reads one half written.
        let name = String(format: "%013lld-%@.json", Int64(now.timeIntervalSince1970 * 1000), id)
        let temporary = captures.appendingPathComponent(".\(name).tmp")
        try data.write(to: temporary)
        try FileManager.default.moveItem(at: temporary, to: captures.appendingPathComponent(name))
        log.info("saved share \(name, privacy: .public)")
    }
}
