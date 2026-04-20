# Ane Racing PRO

Desktop shell for the arcade racer using **Electron**. The game is static files under `web/` (ES modules, no frontend bundler). Electron loads `web/index.html` directly.

## Prerequisites

- **[Node.js](https://nodejs.org/)** 25.9+ (includes `npm`; repo targets **25.9.0**)

## Install

From the repository root:

```bash
npm install
```

That installs Electron and electron-builder and writes `package-lock.json`. Commit the lockfile so CI and teammates get the same versions.

## Run (development)

```bash
npm start
```

This launches the Electron window with the game. On macOS, the system menu bar may still show **Electron** while developing (`electron .`); a **packaged** build (`npm run dist`) uses the real app name and icon. Optional: open DevTools by setting an environment variable before starting:

```bash
ELECTRON_OPEN_DEVTOOLS=1 npm start
```

## In-game menu

On launch you get the main menu (**New game**, **Audio** for SFX/music, **Fullscreen** becomes **Exit fullscreen** while the window is fullscreen, **Exit game**). During a race or the pre-race **3–2–1** countdown, **Esc** or **P** opens the pause menu. **Restart race** moves everyone to the grid first, then runs **3–2–1–GO** (same order as **New game**). **Space** on the main menu starts a race; with the menu open, **Space** resumes after **3–2–1–GO**, or **Back** from the Audio screen. Clicking the dimmed backdrop returns from Audio or resumes from pause (not on the title screen).

## Production build (installers / artifacts)

Uses [electron-builder](https://www.electron.build/) (configured in `package.json` under `"build"`).

```bash
npm run dist
```

Output goes to `dist/` (`.dmg` / `.zip` on macOS, `nsis` / `.exe` / `.zip` on Windows, `AppImage` / `.deb` on Linux). The app icon is the committed **`resources/icon.png`** (see below).

Quick unpacked test (faster, no installer):

```bash
npm run dist:dir
```

For a **native** Mac build on Apple Silicon, run `npm run dist` on the Mac (default targets are in `package.json` → `build`).

### Cross-build Windows x64 from macOS (Apple Silicon)

[electron-builder](https://www.electron.build/cli) can produce a **64-bit Windows** build from your Mac: it downloads the Windows Electron binary and assembles the installer/portable zip here—no Windows VM required for this project (there are no native npm addons in the shipped app).

```bash
npm run dist -- --win --x64
```

Outputs land in **`dist/`** (per `build.win` in `package.json`: NSIS `.exe` installer + `.zip`). To only build the zip (faster, fewer host tools):

```bash
npm run dist -- --win zip --x64
```

If the **NSIS** step fails on macOS, see the [electron-builder Windows](https://www.electron.build/configuration/win) / host-OS notes (sometimes [Wine](https://www.electron.build/multi-platform-build#building-for-windows-on-linux) is needed on Linux; on Mac, try updating `electron-builder` or use CI). **Code signing** for Windows from a Mac is optional and uses a separate certificate flow from Apple code signing.

For all three OS artifacts without a local cross-build, use the [GitHub Actions workflow](.github/workflows/electron-build.yml) matrix.

## Project layout

| Path | Purpose |
|------|---------|
| `resources/icon.svg` | Vector app icon (source — edit this) |
| `resources/icon.png` | Raster icon checked into git (1024² for window + installers) |
| `scripts/render-icon.mjs` | `npm run build:icon` — regenerate **`icon.png`** from **`icon.svg`** only when the art changes ([sharp](https://sharp.pixelplumbing.com/)) |
| `web/` | Game: `index.html`, `game.js`, `styles.css`, `audio.js` |
| `electron/main.cjs` | Electron main process — window + `loadFile` → `web/index.html` |
| `package.json` | npm scripts, electron / electron-builder devDependencies |

## Web / browser

You can still open the game in a normal browser by serving `web/` (e.g. `npx serve web` or any static server) and visiting the served URL.

## CI

See [.github/workflows/electron-build.yml](.github/workflows/electron-build.yml) for a cross-platform `npm run dist` workflow (optional manual trigger).
