# Changelog

## 1.0.2

- Faster startup: Collab Share now only starts when you use it (opening its panel, running a command, or joining), instead of with every VS Code window.
- Color picker shows the real colors, and the host can type any custom hex color.

## 1.0.1

- New icon and a store page with pictures.
- Links to the GitHub repository.
- Smaller package: your own saved whiteboards are no longer included.

## 1.0.0

First public release.

- **Real-time co-editing.** The host shares a folder and friends join with an invite link: shared file tree, live typing with conflict-free merging (Yjs), and per-person undo.
- **Works over the Internet.** A free Cloudflare link with a one-click, verified download of cloudflared (host only). Local-network links are also available.
- **Presence.** Map-pin cursors with profile pictures, file highlights in the Explorer and on tabs, follow mode, and colors chosen by the host.
- **Permissions.** Read-only or read/write per person, changeable at any time by the host.
- **IntelliSense for guests** from the host's language servers: completions, hover, go to definition, references, signature help and errors, including types from the host's node_modules.
- **Blueprint whiteboard.**
  - Drawing tools, sticky notes, rotation, square or curved wires.
  - Save and open board files, or export a PNG.
  - A live logic simulator at 20 ticks per second with gates, flip-flops (D/T/JK with Set/Reset), counters, clocks, delay and pulse, buttons, levers, lamps, a motor, a 7-segment display and math nodes.
  - Sound: 9 instruments, a drum kit and a buzzer.
- The session ends for everyone when the host stops sharing or goes offline.
