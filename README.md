# Datum Brain

A cosmic-organism 3D graph of your Obsidian vault. Your MOC hubs become procedural shader planets, notes become lit spheres sized by connectivity and length, orphans drift as twinkling dust — all orbiting a breathing gold core, wrapped in a warped-noise nebula with WebGL bloom.

Live data: the graph is built from Obsidian's own link index, so it always reflects your vault. No exports, no rebuild step.

## Features

The view opens from the ribbon (orbit icon) or the command palette ("Open Datum Brain"). Drag to orbit, scroll to zoom, click any node to read the note in a dark-glass side panel with backlinks. Planet labels reveal on hover to keep the idle view clean. "Open note" jumps to the editor; internal links inside the reader navigate the brain (Cmd/Ctrl-click opens the editor instead). Systems (top-level folders) get their own colors and can be toggled from the left rail. Press `/` to search titles, paths, and tags. The graph re-syncs automatically when your vault's links change.

Node tiers, so you can tell everything apart at a glance: the vault core is a breathing gold/purple sun; your most-connected hub notes are shader planets with atmospheres and rings; well-linked notes are lit spheres with soft halos; regular notes are matte lit spheres; orphans are dim twinkling dust. Same-system links carry their system's hue; cross-system links take a faint tint of their dominant endpoint.

## Install (manual)

1. Download `manifest.json`, `main.js`, and `styles.css` from the latest release (or this repo).
2. Create the folder `<your vault>/.obsidian/plugins/datum-brain/` and drop the three files in.
3. In Obsidian: Settings → Community plugins → enable **Datum Brain**.

Or with [BRAT](https://github.com/TfTHacker/obsidian42-brat): add this repo as a beta plugin.

## Privacy

Datum Brain is a local, read-only viewer. The plugin's own code and styles make no network request, send no telemetry, call no AI model, and never write to your vault. The three typefaces it uses (Syne, DM Sans, DM Mono — SIL Open Font License 1.1, see `licenses/`) are embedded in `styles.css` rather than fetched from a font CDN, so the plugin itself contacts no one.

The reader is the one place where a note's own content decides what loads. It shows the note you select through Obsidian's markdown renderer and does not filter it: a note that embeds remote images or web content loads them exactly as Obsidian's reading view would, and code blocks handled by your other plugins run.

A build gate checks the plugin's source and the built `main.js` for the common forms of network calls and raw-HTML sinks on every change. It is a pattern check, not a proof.

If a note cannot be read, the reader says so instead of showing an empty page.

## Build from source

```bash
npm ci
npm run build    # bundles src/main.js + three.js -> main.js, and src/styles.css + typefaces -> styles.css
npm run verify   # build + boundary gate (pattern checks for network calls and raw-HTML sinks) + outputs match source
```

`main.js` and `styles.css` in the repository root are build outputs — edit `src/` and rebuild. Contributor rules are in [AGENTS.md](AGENTS.md).

## Notes

Desktop only (WebGL + post-processing). Tested with Obsidian 1.4+. Large vaults (2,000+ notes) will run — physics is O(n²) with a cutoff — but the sweet spot is a few hundred to ~1,500 notes.

MIT © Paul Fritz
