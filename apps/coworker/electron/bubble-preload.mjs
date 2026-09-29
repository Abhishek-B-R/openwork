import { contextBridge, ipcRenderer } from "electron";

/**
 * The floating bubble's whole bridge: its state arrives from the main
 * process; it can move itself, show or hide its speech, and ask to open the
 * conversation. It has no access to Open Coworker's commands.
 */
contextBridge.exposeInMainWorld("__COWORKER_BUBBLE__", {
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("bubble:state", handler);
    ipcRenderer.send("bubble:ready");
    return () => ipcRenderer.removeListener("bubble:state", handler);
  },
  onCursor: (listener) => {
    const handler = (_event, cursor) => listener(cursor);
    ipcRenderer.on("bubble:cursor", handler);
    return () => ipcRenderer.removeListener("bubble:cursor", handler);
  },
  moveBy: (dx, dy) => ipcRenderer.send("bubble:move-by", { dx: Number(dx), dy: Number(dy) }),
  open: () => ipcRenderer.send("bubble:open"),
  toggle: () => ipcRenderer.send("bubble:toggle"),
  dismiss: () => ipcRenderer.send("bubble:dismiss"),
});
