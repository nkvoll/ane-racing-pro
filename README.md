# Ane Racing PRO

Desktop shell for the game UI, built with [Tauri](https://tauri.app/) 2. The frontend is static files under `web/`; release builds copy that folder into the app (no separate bundler step).

## Prerequisites

- [Rust](https://rustup.rs/) (stable), with the usual target for your OS (e.g. `x86_64-pc-windows-msvc` on Windows for the CI-style build).
- **Python 3** for local development only: `beforeDevCommand` serves `web/` with `python3 -m http.server` on port **1420**.
- **Tauri CLI** (if you do not have it yet):

  ```bash
  cargo install tauri-cli --version 2.10.1 --locked
  ```

## Development

From the **repository root** (same directory as this file):

```bash
cargo tauri dev
```

This starts the static file server and opens the app window pointed at `http://127.0.0.1:1420`.

## Release build

From the repository root:

```bash
cargo tauri build
```

Artifacts depend on the platform (e.g. `.app` / `.dmg` on macOS via `tauri.macos.conf.json`, plain `.exe` on Windows when bundling is disabled). On GitHub Actions, the [tauri-build](.github/workflows/tauri-build.yml) workflow uses a matrix (Linux, macOS, Windows) and [tauri-action](https://github.com/tauri-apps/tauri-action): Windows and Linux upload the release binary; macOS uploads the `bundle/` output (`.app` / `.dmg`).

### Release builds for Apple Silicon, Linux x64, and Windows x64

Tauri uses Rust [target triples](https://doc.rust-lang.org/rustc/platform-support.html). For these desktop targets the usual triples are:

| Platform | Target triple |
| -------- | ------------- |
| macOS (Apple Silicon) | `aarch64-apple-darwin` |
| Linux (x86_64, typical glibc) | `x86_64-unknown-linux-gnu` |
| Windows (x86_64) | `x86_64-pc-windows-msvc` |

Install only the targets you need:

```bash
rustup target add aarch64-apple-darwin
rustup target add x86_64-unknown-linux-gnu
rustup target add x86_64-pc-windows-msvc
```

From the **repository root**, build for one triple:

```bash
cargo tauri build --target aarch64-apple-darwin
cargo tauri build --target x86_64-unknown-linux-gnu
cargo tauri build --target x86_64-pc-windows-msvc
```

On an Apple Silicon Mac, a plain `cargo tauri build` already targets `aarch64-apple-darwin`. To produce an Intel (x86_64) macOS build from Apple Silicon, add the `x86_64-apple-darwin` target and pass `--target x86_64-apple-darwin`.

**Host vs cross-compile:** Tauri depends on each platform’s WebView and system libraries. The most reliable approach is to run `cargo tauri build --target …` **on a machine that matches that OS** (or use CI, as in [tauri-build](.github/workflows/tauri-build.yml)). Cross-compiling from one OS to another (for example Windows from macOS or Linux) needs extra C toolchains, linkers, and setup. Install the usual tools per OS first ([Tauri prerequisites](https://v2.tauri.app/start/prerequisites/): WebKitGTK on Linux, MSVC/WebView2 on Windows, Xcode or command-line tools on macOS), then see [Distribute](https://v2.tauri.app/distribute/) for bundling and signing.

#### Example building from Mac to Windows x64 with cargo-xwin and lld/llvm

Building for Windows, this seemed to do the trick:

```
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin
brew install lld llvm
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/llvm/bin:$PATH"
CARGO_TARGET_DIR=src-tauri/target cargo tauri build \
  --target x86_64-pc-windows-msvc \
  --runner cargo-xwin
```