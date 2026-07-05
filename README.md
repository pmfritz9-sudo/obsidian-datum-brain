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

## Build from source

```bash
npm install
npm run build   # bundles src/main.js + three.js -> main.js
```

## Notes

Desktop only (WebGL + post-processing). Tested with Obsidian 1.4+. Large vaults (2,000+ notes) will run — physics is O(n²) with a cutoff — but the sweet spot is a few hundred to ~1,500 notes.

MIT © Paul Fritz
