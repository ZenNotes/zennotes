import Foundation
import UniformTypeIdentifiers

/// One previewed note: its text, the page that renders it, and the files it
/// embeds. The page reaches nothing but this extension's own zenql:// scheme,
/// and of the disk only the files listed here.
struct NotePreview {
    static let scheme = "zenql"
    static let pageURL = URL(string: "zenql://app/index.html")!

    /// Larger notes show their beginning; the rest is a click away in the app.
    private static let markdownLimit = 4 * 1024 * 1024
    /// Embedded files above this size are left out of the preview.
    private static let assetLimit: Int64 = 512 * 1024 * 1024
    private static let mediaExtensions: Set<String> = [
        "png", "jpg", "jpeg", "gif", "webp", "avif", "apng", "svg", "bmp", "tiff", "heic",
        "pdf", "mp3", "m4a", "aac", "flac", "ogg", "wav", "mp4", "m4v", "mov", "ogv", "webm"
    ]

    let fileURL: URL
    let markdown: String
    private let viewer: URL
    private let page: Data
    private let assets: [URL]
    private let noteDirectory: URL
    private let vaultRoot: URL?

    init(fileURL: URL, viewer: URL) throws {
        self.fileURL = fileURL
        self.viewer = viewer.standardizedFileURL

        let data = try Data(contentsOf: fileURL, options: .mappedIfSafe)
        var text = String(data: data.prefix(Self.markdownLimit), encoding: .utf8)
            ?? String(decoding: data.prefix(Self.markdownLimit), as: UTF8.self)
        if data.count > Self.markdownLimit {
            text += "\n\n---\n\n*Quick Look shows the beginning of this note. Open it in ZenNotes to read the rest.*\n"
        }
        markdown = text

        let noteDirectory = fileURL.deletingLastPathComponent().standardizedFileURL
        let vaultRoot = Self.vaultRoot(above: noteDirectory)
        self.noteDirectory = noteDirectory
        self.vaultRoot = vaultRoot
        var resolver = AssetResolver(noteDirectory: noteDirectory, vaultRoot: vaultRoot)
        var files: [URL] = []
        var urls: [String: String] = [:]
        for reference in Self.references(in: text) {
            guard let file = resolver.resolve(reference) else { continue }
            let index: Int
            if let known = files.firstIndex(of: file) {
                index = known
            } else {
                files.append(file)
                index = files.count - 1
            }
            let name = file.lastPathComponent.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "file"
            let url = "zenql://app/asset/\(index)/\(name)"
            urls[reference.written] = url
            urls[reference.decoded] = url
        }
        assets = files

        let notePath: String
        if let vaultRoot, fileURL.standardizedFileURL.path.hasPrefix(vaultRoot.path + "/") {
            notePath = String(fileURL.standardizedFileURL.path.dropFirst(vaultRoot.path.count + 1))
        } else {
            notePath = fileURL.lastPathComponent
        }
        let payload: [String: Any] = [
            "title": fileURL.deletingPathExtension().lastPathComponent,
            "markdown": text,
            "notePath": notePath,
            "assets": urls,
            "config": Self.configText()
        ]
        page = try Self.page(payload: payload)
    }

    static func isOutsideLink(_ link: String) -> Bool {
        guard let scheme = URL(string: link.trimmingCharacters(in: .whitespaces))?.scheme?.lowercased() else { return false }
        return ["http", "https", "mailto"].contains(scheme)
    }

    // MARK: - Serving

    func response(for url: URL, range: String?) throws -> (head: URLResponse, body: Data) {
        let path = url.path
        if path == "/index.html" { return Self.respond(url, page, type: "text/html") }
        if path.hasPrefix("/asset/") {
            let parts = path.split(separator: "/")
            guard parts.count >= 2, let index = Int(parts[1]), assets.indices.contains(index) else {
                throw URLError(.fileDoesNotExist)
            }
            return try Self.serve(assets[index], for: url, range: range)
        }
        if path.hasPrefix("/cover/") {
            // A cover the embed scan did not find (a plain [[link]] or a bare
            // path in the frontmatter): the page names it, having read the
            // frontmatter with the app's own parser, and it resolves here like
            // any embed, inside the vault and media files only.
            let reference = String(path.dropFirst("/cover/".count))
            var resolver = AssetResolver(noteDirectory: noteDirectory, vaultRoot: vaultRoot)
            guard let file = resolver.resolve(Reference(written: reference, decoded: reference, wikilink: true)) else {
                throw URLError(.fileDoesNotExist)
            }
            return try Self.serve(file, for: url, range: nil)
        }
        let file = viewer.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(viewer.path + "/") else { throw URLError(.noPermissionsToReadFile) }
        return try Self.serve(file, for: url, range: nil)
    }

    private static func serve(_ file: URL, for url: URL, range: String?) throws -> (head: URLResponse, body: Data) {
        let type = mimeType(file.pathExtension)
        guard let range, let bounds = byteRange(range, file: file) else {
            return respond(url, try Data(contentsOf: file, options: .mappedIfSafe), type: type)
        }
        // Audio and video seek with byte ranges.
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(bounds.start))
        let body = try handle.read(upToCount: bounds.end - bounds.start + 1) ?? Data()
        let head = HTTPURLResponse(url: url, statusCode: 206, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": type,
            "Content-Length": String(body.count),
            "Content-Range": "bytes \(bounds.start)-\(bounds.start + body.count - 1)/\(bounds.size)",
            "Accept-Ranges": "bytes"
        ])!
        return (head, body)
    }

    /// Uniform Type Identifiers knows no MIME type for some web formats.
    private static func mimeType(_ fileExtension: String) -> String {
        switch fileExtension.lowercased() {
        case "js", "mjs": return "text/javascript"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "otf": return "font/otf"
        case "wasm": return "application/wasm"
        default: return UTType(filenameExtension: fileExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }

    private static func respond(_ url: URL, _ body: Data, type: String) -> (head: URLResponse, body: Data) {
        let head = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": type,
            "Content-Length": String(body.count),
            "Accept-Ranges": "bytes"
        ])!
        return (head, body)
    }

    private static func byteRange(_ header: String, file: URL) -> (start: Int, end: Int, size: Int)? {
        guard header.hasPrefix("bytes="),
              let size = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, size > 0 else { return nil }
        let spec = header.dropFirst("bytes=".count).split(separator: ",").first ?? ""
        let sides = spec.split(separator: "-", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        guard sides.count == 2 else { return nil }
        if sides[0].isEmpty, let suffix = Int(sides[1]), suffix > 0 {
            return (max(0, size - suffix), size - 1, size)
        }
        guard let start = Int(sides[0]), start < size else { return nil }
        let end = min(Int(sides[1]) ?? size - 1, size - 1)
        return end >= start ? (start, end, size) : nil
    }

    // MARK: - The page

    private static func page(payload: [String: Any]) throws -> Data {
        let json = try JSONSerialization.data(withJSONObject: payload, options: [])
        // `<` never appears raw inside the script element, so no text in a note
        // can close it.
        let embedded = String(decoding: json, as: UTF8.self).replacingOccurrences(of: "<", with: "\\u003c")
        let policy = [
            "default-src 'self' zenql: data: blob:",
            "script-src 'self' zenql: 'unsafe-eval'",
            "style-src 'self' zenql: 'unsafe-inline'",
            "img-src 'self' zenql: data: blob:",
            "media-src 'self' zenql: data: blob:",
            "font-src 'self' zenql: data:",
            "worker-src 'self' zenql: blob:",
            "connect-src 'self' zenql:",
            "frame-src 'none'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'"
        ].joined(separator: "; ")
        let html = """
        <!doctype html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="\(policy)">
        <meta name="color-scheme" content="light dark">
        <link rel="stylesheet" href="quicklook.css">
        <script type="application/json" id="zen-quicklook-data">\(embedded)</script>
        </head>
        <body>
        <main id="zen-quicklook-root"></main>
        <script type="module" src="quicklook.js"></script>
        </body>
        </html>
        """
        return Data(html.utf8)
    }

    /// The user's ZenNotes settings, read for the theme and fonts. A sandboxed
    /// extension's home is its container, so the real one comes from the
    /// user database.
    private static func configText() -> String {
        guard let entry = getpwuid(getuid()), let directory = entry.pointee.pw_dir else { return "" }
        let file = URL(fileURLWithPath: String(cString: directory)).appendingPathComponent(".config/zennotes/config.toml")
        guard let data = try? Data(contentsOf: file), data.count < 1024 * 1024 else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: - Embedded files

    struct Reference {
        let written: String
        let decoded: String
        let wikilink: Bool
    }

    /// `![[name]]` and `![alt](path)` references, as written.
    static func references(in markdown: String) -> [Reference] {
        var found: [Reference] = []
        let range = NSRange(markdown.startIndex..., in: markdown)
        let wikilink = try! NSRegularExpression(pattern: #"!\[\[([^\]\|#\^\n]+)[^\]\n]*\]\]"#)
        for match in wikilink.matches(in: markdown, range: range) {
            guard let target = Range(match.range(at: 1), in: markdown) else { continue }
            let name = markdown[target].trimmingCharacters(in: .whitespaces)
            found.append(Reference(written: name, decoded: name, wikilink: true))
        }
        let image = try! NSRegularExpression(pattern: #"!\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)"#)
        for match in image.matches(in: markdown, range: range) {
            guard let target = Range(match.range(at: 1), in: markdown) else { continue }
            var href = String(markdown[target])
            if href.hasPrefix("<"), href.hasSuffix(">") { href = String(href.dropFirst().dropLast()) }
            if href.contains("://") || href.lowercased().hasPrefix("data:") || href.lowercased().hasPrefix("mailto:") { continue }
            let bare = href.split(separator: "#", maxSplits: 1).first.map(String.init) ?? href
            let path = bare.split(separator: "?", maxSplits: 1).first.map(String.init) ?? bare
            found.append(Reference(written: href, decoded: path.removingPercentEncoding ?? path, wikilink: false))
        }
        return found
    }

    /// The nearest folder above the note that holds a `.zennotes` folder.
    static func vaultRoot(above directory: URL) -> URL? {
        let home = getpwuid(getuid()).flatMap { $0.pointee.pw_dir.map { String(cString: $0) } }
        var current = directory
        for _ in 0..<32 {
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: current.appendingPathComponent(".zennotes").path, isDirectory: &isDirectory),
               isDirectory.boolValue {
                return current
            }
            if current.path == "/" || current.path == home { return nil }
            current = current.deletingLastPathComponent()
        }
        return nil
    }

    struct AssetResolver {
        let noteDirectory: URL
        let vaultRoot: URL?
        private var byName: [String: URL]?

        init(noteDirectory: URL, vaultRoot: URL?) {
            self.noteDirectory = noteDirectory
            self.vaultRoot = vaultRoot
        }

        /// A file the note embeds, found the way ZenNotes finds it: a path
        /// beside the note or from the vault root, and a bare `![[name]]` by
        /// its name anywhere in the vault. Only media files inside the vault
        /// (or the note's folder outside one) are ever served.
        mutating func resolve(_ reference: Reference) -> URL? {
            let path = reference.decoded
            guard !path.isEmpty else { return nil }
            var candidates: [URL] = []
            if path.hasPrefix("/") {
                if let vaultRoot { candidates.append(vaultRoot.appendingPathComponent(String(path.dropFirst()))) }
            } else {
                candidates.append(noteDirectory.appendingPathComponent(path))
                if let vaultRoot { candidates.append(vaultRoot.appendingPathComponent(path)) }
            }
            for candidate in candidates {
                if let file = allowed(candidate) { return file }
            }
            guard reference.wikilink, !path.contains("/") else { return nil }
            return findByName(path).flatMap(allowed)
        }

        /// The reference must sit inside the vault (or the note's folder); a
        /// symlinked attachment may point elsewhere, as it plays in the app.
        private func allowed(_ candidate: URL) -> URL? {
            let link = candidate.standardizedFileURL
            let root = (vaultRoot ?? noteDirectory).standardizedFileURL
            guard link.path.hasPrefix(root.path + "/") else { return nil }
            let file = link.resolvingSymlinksInPath()
            guard NotePreview.mediaExtensions.contains(file.pathExtension.lowercased()),
                  let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
                  values.isRegularFile == true,
                  Int64(values.fileSize ?? 0) <= NotePreview.assetLimit else { return nil }
            return file
        }

        /// Every media file in the vault by lower-cased name, built once and only
        /// when a bare name is not beside the note.
        private mutating func findByName(_ name: String) -> URL? {
            if byName == nil {
                var index: [String: URL] = [:]
                if let vaultRoot,
                   let walk = FileManager.default.enumerator(
                       at: vaultRoot,
                       includingPropertiesForKeys: [.isRegularFileKey],
                       options: [.skipsHiddenFiles, .skipsPackageDescendants]
                   ) {
                    var visited = 0
                    for case let file as URL in walk {
                        visited += 1
                        if visited > 50_000 { break }
                        if file.lastPathComponent == "node_modules" { walk.skipDescendants(); continue }
                        guard NotePreview.mediaExtensions.contains(file.pathExtension.lowercased()) else { continue }
                        let key = file.lastPathComponent.lowercased()
                        if index[key] == nil { index[key] = file }
                    }
                }
                byName = index
            }
            return byName?[name.lowercased()]
        }
    }
}
