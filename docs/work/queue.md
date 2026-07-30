# Work Queue

- [x] Web app: make the file viewer/editor sidebar resizable via left-border drag, persisting width in sessionStorage ([details](file-viewer-resizable-sidebar.md))
- [x] Mobile: tap-on-link must beat xterm focus so the link opens on first tap (no keyboard) ([details](tap-link-priority-mobile.md))
- [x] Broaden terminal file-path detection (bare filenames) + server existence-gate ([details](clickable-path-detection.md))
- [x] OSC 8 hyperlink support — register a `linkHandler` so tool-emitted terminal links are clickable ([details](osc8-hyperlinks.md))
- [x] Clear scrollback must purge the client IndexedDB cache to fix slow reloads ([details](clear-scrollback-purge-client-cache.md))
- [x] Clear scrollback must free the server-side pty-host output buffer ([details](clear-scrollback-frees-server-buffer.md))
