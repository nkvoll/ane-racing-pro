/**
 * Electron main process — loads the static game from web/ (no bundler).
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const INDEX_HTML = path.join(__dirname, "..", "web", "index.html");

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: "Ane Racing PRO",
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

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
