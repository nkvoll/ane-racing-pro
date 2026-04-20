/**
 * Electron main process — loads the static game from web/ (no bundler).
 */
const { app, BrowserWindow, ipcMain, Menu, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");

/**
 * Internal Electron name / paths / About panel. On macOS, `app.setName` does not change
 * the menu bar title next to the Apple menu during `electron .` dev — that comes from
 * the Electron.app bundle; use a packaged build for the real app name there.
 */
const APP_NAME = "Ane Racing PRO";
app.setName(APP_NAME);
/** Windows taskbar / notification area grouping — match `build.appId` in package.json */
if (process.platform === "win32") {
  app.setAppUserModelId("dev.nkvoll.ane-racing-pro");
}

const INDEX_HTML = path.join(__dirname, "..", "web", "index.html");
/** Absolute path — relative paths break when `npm start` cwd ≠ repo root. */
const APP_ICON_PATH = path.resolve(__dirname, "..", "resources", "icon.png");

function loadTrayAndWindowIcon() {
  if (!fs.existsSync(APP_ICON_PATH)) return undefined;
  try {
    const img = nativeImage.createFromPath(APP_ICON_PATH);
    return img.isEmpty() ? undefined : img;
  } catch (_) {
    return undefined;
  }
}

function createWindow() {
  const icon = loadTrayAndWindowIcon();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    icon,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(INDEX_HTML).catch((err) => {
    console.error("Failed to load game:", err);
  });

  win.once("ready-to-show", () => win.show());

  if (process.env.ELECTRON_OPEN_DEVTOOLS === "1") {
    win.webContents.openDevTools({ mode: "detach" });
  }

  wireFullscreenIpc(win);

  return win;
}

ipcMain.handle("app-quit", () => {
  app.quit();
});

ipcMain.handle("window-toggle-fullscreen", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setFullScreen(!win.isFullScreen());
});

ipcMain.handle("window-get-fullscreen", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win ? win.isFullScreen() : false;
});

function wireFullscreenIpc(win) {
  const send = (flag) => {
    try {
      win.webContents.send("shell-fullscreen-changed", flag);
    } catch (_) {}
  };
  win.on("enter-full-screen", () => send(true));
  win.on("leave-full-screen", () => send(false));
}

/**
 * macOS shows the first menu title next to the Apple menu. In dev (`electron .`)
 * the default template still says "Electron" unless we set the label here.
 * `role: 'about'` keeps “About Electron” / wrong branding — use the about panel + label.
 */
function installMacApplicationMenu() {
  if (process.platform !== "darwin") return;
  const menu = Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: () => {
            app.showAboutPanel();
          },
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  try {
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      copyright: "MIT License",
    });
  } catch (_) {}

  installMacApplicationMenu();

  if (process.platform === "darwin") {
    const dockIcon = loadTrayAndWindowIcon();
    if (dockIcon) {
      try {
        app.dock.setIcon(dockIcon);
      } catch (_) {}
    }
  }

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
