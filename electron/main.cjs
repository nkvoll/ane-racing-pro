/**
 * Electron main process — loads the static game from web/ (no bundler).
 */
const { app, BrowserWindow } = require("electron");
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
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
