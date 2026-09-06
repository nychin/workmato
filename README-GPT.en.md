[中文](README.md) · [English](README-GPT.en.md)

[![License: PolyForm Noncommercial](https://img.shields.io/badge/License-PolyForm%20Noncommercial-2391e6.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.3.2-brightgreen.svg)](https://github.com/nychin/workmato/releases)
[![Platform](https://img.shields.io/badge/platform-Windows-0078d6.svg)](#)

![](assets/hero.png)

# Working Tomato (Workmato)

A pixel-art desktop tomato timer, paired with a task flow canvas — usually it is a transparent little desktop companion keeping you focused; when you need to plan, open the task canvas and lay out the flow. Both run independently, yet stay linked through the billboard.

## Overview

- Working Tomato is a desktop-pet style productivity tool. Its main panel is a pixel-art tomato timer, and there is also a task flow manager window.
- **Languages**: English, Chinese, Japanese
- **Requirements**: Windows 10 / 11 (64-bit). Built on Electron, cross-platform in principle.

## Features

**Pixel UI**
- Carefully drawn pixel-art UI covering the regular states — idle, focus, overtime, break — plus easter-egg states such as celebration and nag. A breathing animation plays while the timer is running.

**Overtime mode (count-up)**
- Ever get interrupted right when you are in the zone? Overtime mode makes your focus sessions elastic.
- When a focus countdown ends, the timer switches to a count-up overtime phase, and the overtime counts toward your focus time.
- End overtime manually whenever you like and move on to the break, instead of being cut off by an alert.

**Auto-calculated break time**
- Breaks can be derived from your focus time automatically; the ratio and related parameters are adjustable in Settings.

**No-button design**
- Functional controls disguised as scenery objects, so the UI stays vivid and coherent.

**Billboard**
- Shows the pinned task from your task canvas in real time, helping you stay on track.
- Click the billboard to open the task flow manager.

**Task flow canvas**
- A task manager tuned for lightweight personal planning.
- Several intuitive ways to add cards and reshape a flow quickly.
- Infinite node canvas, smooth text editing, and multiple node types for sub-tasks and notes.

**Statistics**
- When the tomato timer and the task manager are used together, it records how long each stage of each task takes, so you can track how you actually work.

**Celebration animation**
- When a task is completed, the little tomato celebrates with you (while in a focus state).

![](assets/celebration.gif)

## More screenshots

### Tomato timer

![](assets/tomato-buttons.png)
![](assets/tomato-ui.png)

### Task flow manager

![](assets/taskflow.png)

### Statistics

![](assets/statistics.png)

## Installation

### Download

Grab `workmato-setup-1.3.2.exe` from [Releases](https://github.com/nychin/workmato/releases) (NSIS installer, custom install directory supported), for Windows 10 / 11 (64-bit).

### Note

After installing, open the task manager to read the in-app usage guide.

## Run from source (Quick Start)

Requires Node.js 18+ and npm:

```bash
npm install            # install dependencies
npm run dev            # dev mode: vite hot reload + auto start (task canvas served from source)
npm run build          # build (main + renderer output into dist/)
npm run test:taskflow  # task data storage migration test
npm run pack           # build NSIS installer (release/workmato-setup-<version>.exe)
npm run pack:dir       # build portable directory (release/win-unpacked)
```

Dev mode uses a separate data directory (`%TEMP%\tomato-clock-dev`), isolated from the installed app, so debugging never touches your real task data.

## Architecture (at a glance)

**Shell**: Electron + TypeScript (strict), split into main / renderer / preload, with a minimal API exposed through `contextBridge`; the renderer process never touches system capabilities directly.

**Tomato window**: PixiJS 6 (WebGL) renders the 491×407 pixel canvas from bitmap assets. The window is frameless and transparent, and click-through is driven by a static hitmap — only the button regions accept clicks, everything else is for dragging the window.

**Timing core**: A table-driven state machine (TimerFSM) plus a one-second engine in the main process, driving idle → focus → overtime → break and back. Events such as task completion trigger the celebration animation over IPC.

**Animation system**: A home-grown declarative Timeline engine (JSON parameters for easing, duration, scale) powers breathing, state transitions, celebration and nag animations. A hidden animation lab (click the tomato stem five times) tunes them live.

**Task flow canvas**: A free-form canvas written in plain TypeScript (no frontend framework), supporting an infinite canvas, flow edges, note/scribble cards, grouping, undo/redo and search-to-locate by task name.

**Storage**: sql.js (SQLite compiled to WASM). All reads and writes go through the main process with atomic flushing; the renderer reaches data over IPC (the preload API), keeping data consistent and migrations safe.

**Localization**: English / Chinese / Japanese built in, with strings centralized in `src/shared/i18n`; the sample task data is provided per language as well.

**Windows**: tomato main panel, task flow manager, settings window and the animation lab — each runs on its own and opens on demand.

## Support

If Working Tomato helps you, consider buying the developer a coffee ☕ via Ko-fi / PayPal:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/nychin260828)

Users in mainland China can also tip via the QR code in the app's **Settings → About** page.

## License

Released under [PolyForm Noncommercial 1.0.0](LICENSE).

- Allowed: personal learning, use, modification and redistribution
- Not allowed: any commercial use (selling, paid hosting, ad revenue, etc.)
- Redistributions must keep the copyright notice and the full license text

**Asset copyright**: The bundled pixel art, sound effects and font files remain the property of their original authors. They are distributed with this project for noncommercial purposes only — please do not extract them for commercial use.
