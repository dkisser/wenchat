# UI rendering & clipboard invariants

Moved verbatim from `CLAUDE.md` / `AGENTS.md` (was the "Message rendering & clipboard" section). Read before touching `packages/ui/src/markdown.ts`, `toDisplayLines`, `apps/cli/src/clipboard.ts`, or `apps/cli/src/mouseMode.ts`.

- Inbound text messages are run through `renderMarkdown` (`packages/ui/src/markdown.ts`) before `wrap-ansi` — this preserves original newlines, indentation, and consecutive spaces, and adds CommonMark styling (bold / italic / inline / fenced code with `cli-highlight` highlighting, blockquotes, lists, hr). System entries (`[system]`) bypass the renderer so operator strings never become formatted by accident.
- `toDisplayLines` returns `{ lines, messageStartIndices }`; the start-index array lets a click coordinate map back to the message owning that line (`findMessageAtLine`).
- ChatView uses `wrap="wrap"` (matching `wrap-ansi` `{trim:false, hard:true}`) so the "flat line count = rendered row count" invariant survives markdown.
- Copy-to-clipboard is exposed two ways: **double-click** a message row (uses `useDoubleClick`, SGR mouse events; only left-button presses within 500 ms at the same coord count) and ** `/copy [n]` ** (1-based nth from most recent; file/ping/pong messages do not count).
- `apps/cli/src/clipboard.ts` probes the platform helper in order (`pbcopy` on macOS, `clip.exe` on Windows, `wl-copy` / `xclip` / `xsel` on Linux). When none is available, falls back to **OSC 52** (`\x1b]52;c;<base64>\x07`) written via `process.stdout.write` so it bypasses Ink's render pipeline. iTerm2 requires Preferences → Advanced → "Allow clipboard read/write from shell" for OSC 52 to take effect.
- `process.stdout.write` for OSC 52 must bypass Ink — the same pattern `apps/cli/src/mouseMode.ts` uses for `\x1b[?1006h`.
