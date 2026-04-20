# Ane Racing PRO

Desktop shell for the arcade racer using **Electron**. The game is static files under `web/` (ES modules, no frontend bundler). Electron loads `web/index.html` directly.

## Prerequisites

- **[Node.js](https://nodejs.org/)** 18+ (includes `npm`)

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

This launches the Electron window with the game. Optional: open DevTools by setting an environment variable before starting:

```bash
ELECTRON_OPEN_DEVTOOLS=1 npm start
```

## Production build (installers / artifacts)

Uses [electron-builder](https://www.electron.build/) (configured in `package.json` under `"build"`).

```bash
npm run dist
```

Output goes to `dist/` (`.dmg` / `.zip` on macOS, `nsis` / `.exe` / `.zip` on Windows, `AppImage` / `.deb` on Linux).

Quick unpacked test (faster, no installer):

```bash
npm run dist:dir
```

Build the way you ship: run `npm run dist` **on the target OS** (or use CI). Cross-compiling Electron native modules from one OS to another is not the default workflow; use a matrix on GitHub Actions if you need all three platforms.

## Project layout

| Path | Purpose |
|------|---------|
| `web/` | Game: `index.html`, `game.js`, `styles.css`, `audio.js` |
| `electron/main.cjs` | Electron main process — window + `loadFile` → `web/index.html` |
| `package.json` | npm scripts, electron / electron-builder devDependencies |

## Web / browser

You can still open the game in a normal browser by serving `web/` (e.g. `npx serve web` or any static server) and visiting the served URL.

## CI

See [.github/workflows/electron-build.yml](.github/workflows/electron-build.yml) for a cross-platform `npm run dist` workflow (optional manual trigger).
