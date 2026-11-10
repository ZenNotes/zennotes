# The clip links: `zennotes://new` and `zennotes://daily`

This is the contract between the ZenNotes Web Clipper (a browser extension in its own repo,
`ZenNotes/web-clipper`) and the ZenNotes apps. Anything else that wants to hand ZenNotes a note
(Raycast, Shortcuts, Alfred, a script) can use the same links.

The extension turns a page into Markdown, puts the note on the clipboard, and opens one of these
links. The app that handles `zennotes://` (desktop on macOS, Windows and Linux, or the iPhone,
iPad and Android apps) writes the file. Nothing goes through a server.

The parser is `packages/shared-domain/src/clip-link.ts`. Every implementation (that parser, the
extension's link builder, the phone shells) is tested against the same cases in
[`web-clipper-link.fixtures.json`](web-clipper-link.fixtures.json). Change the contract here, in
the fixtures, and in every implementation together.

## Shape

```
zennotes://new?vault=<name>&file=<folder/name>&<body>[&append|&prepend][&silent]
zennotes://daily?vault=<name>&<body>[&append|&prepend][&silent]

<body> = clipboard=<sha256>   the note is on the clipboard (the default)
       | content=<text>       the note is in the link (a fallback, at most 32 KiB)
```

Every value is percent-encoded, leaving only RFC 3986's unreserved characters (`A-Z a-z 0-9 - . _
~`) bare. A bare `+` is a plus sign, never a space. Flags (`append`, `prepend`, `silent`) are bare
names; `=true` and `=1` also turn one on, `=false` and `=0` leave it off. Each parameter appears
at most once. Unknown parameters are ignored, so a newer clipper can add some.

The canonical form, which the fixtures marked `canonical` pin exactly, lists the parameters in the
order `vault`, `file`, body, position, `silent`.

## Parameters

| Parameter | Meaning |
|---|---|
| `vault` | The vault's display name, else its folder name, matched without regard to case. Never a path. Left out: the vault that is open. A name that matches no vault, or more than one, writes nothing. |
| `file` | `folder/name` inside the notes area, without `.md` (a trailing `.md` is dropped). The folder is relative to where notes live: the vault's top level in an Obsidian-style vault, the Inbox otherwise. So `Clippings/My Article` lands in a `Clippings` folder next to your other notes. Left out on `new`: the note goes to the top of the notes area, named from its first line the way Quick Capture names notes. |
| `clipboard` | The lowercase hex SHA-256 of the UTF-8 bytes of the note text the link put on the clipboard. |
| `content` | The note text itself, at most 32 KiB of UTF-8. |
| `append` | Add the text to the end of the note (`new`: of the note at `file`, created if missing). |
| `prepend` | Add the text to the top of the note, below its frontmatter. |
| `silent` | Write without opening the note or raising the app. |

## Actions

- **`new`** with a body creates a note at `file`. If that name is taken it never overwrites: the
  note gets the next free name (`My Article 2`). With `append` or `prepend` it adds to the note at
  `file` instead, creating it when it does not exist; `file` and a body are required then.
- **`new`** with `file` and no body creates an empty note there.
- **Bare `zennotes://new`** creates a blank note in the Inbox and opens it (what the phone widgets
  have always fired).
- **`daily`** adds the body to today's daily note, at the end unless `prepend`, creating the note
  from the vault's daily-note settings and template when it does not exist. Bare
  `zennotes://daily` just opens today's note.

## Safety rules

Any web page can fire a `zennotes://` link, so the app treats every link as untrusted:

- **No overwrite.** There is no `overwrite` parameter.
- **The clipboard is never read blind.** The app files the clipboard only when its SHA-256 matches
  `clipboard=`. Otherwise it writes nothing and says the clip did not arrive. A page therefore
  cannot make the app file whatever you copied last, such as a password. One allowance: a browser
  on Windows can store the text with CRLF line endings, so a clipboard whose CRLF-to-LF form
  matches is accepted too, and the LF text is what gets filed. Builders hash the text exactly as
  they wrote it.
- **Locations stay inside the notes area.** No `..`, no leading `/`, no drive letter, no folder or
  note name starting with `.` (so never `.zennotes`), and no folder with a character Windows
  refuses (`< > : " | ? *`), because vaults sync between systems. Characters a note title cannot
  hold are replaced the same way as for any new note.
- **Limits.** A link is at most 128 KiB, inline content at most 32 KiB (Windows and Linux pass a
  link on the command line, which tops out near 32K characters), clipboard text at most 8 MiB.

## Why the clipboard

The note travels on the clipboard, not in the link, because a full article does not fit in a link
the operating system will pass along. This is the same design as Obsidian's clipper. The hash is
our addition: it makes the clipboard read safe without asking the extension to talk to the app any
other way.

## Refusals

A link that is a clip link but malformed is refused with one of these codes (the fixtures name
them): `link-too-long`, `bad-encoding`, `duplicate-param`, `bad-vault`, `bad-file`, `bad-hash`,
`two-bodies`, `empty-body`, `content-too-long`, `append-and-prepend`, `missing-file`,
`nothing-to-insert`.
