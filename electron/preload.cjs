const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronShell", {
  quit: () => ipcRenderer.invoke("app-quit"),
  toggleFullscreen: () => ipcRenderer.invoke("window-toggle-fullscreen"),
  getFullscreen: () => ipcRenderer.invoke("window-get-fullscreen"),
  onFullscreenChange: (cb) => {
    const handler = (_e, isFullscreen) => {
      try {
        cb(Boolean(isFullscreen));
      } catch (_) {}
    };
    ipcRenderer.on("shell-fullscreen-changed", handler);
    return () => ipcRenderer.removeListener("shell-fullscreen-changed", handler);
  },
});
