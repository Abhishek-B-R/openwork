/**
 * The coworker as a tiny floating bubble: from Focus mode the window steps
 * aside and only the coworker's face stays, in a small round window above
 * everything, on every desktop, that the person can drag anywhere. When the
 * coworker has something for them, a speech bubble opens beside the face.
 * A tap on the face brings the conversation back where it was.
 *
 * The bubble is its own frameless window with a minimal preload: it can
 * move itself, ask to open, and dismiss its speech, and nothing else.
 */

/** The window's size with only the face showing (the face plus room for its shadow). */
export const BUBBLE_FACE = 76;
/** Room beside the face for a speech bubble. */
const SPEECH_WIDTH = 272;
const SPEECH_HEIGHT = 136;
const MARGIN = 6;

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/** Where the face may sit on a display: fully inside its work area. */
export function clampFace(point, workArea) {
  return {
    x: Math.round(clamp(point.x, workArea.x + MARGIN, workArea.x + workArea.width - BUBBLE_FACE - MARGIN)),
    y: Math.round(clamp(point.y, workArea.y + MARGIN, workArea.y + workArea.height - BUBBLE_FACE - MARGIN)),
  };
}

/**
 * The bubble window's rectangle for a face position. Speaking, the window
 * grows beside the face (toward the roomier side) and upward, so the face
 * itself never moves on screen.
 */
export function bubbleBounds(face, workArea, speaking) {
  if (!speaking) return { bounds: { x: face.x, y: face.y, width: BUBBLE_FACE, height: BUBBLE_FACE }, side: "left" };
  const side = face.x - SPEECH_WIDTH < workArea.x ? "right" : "left";
  const height = Math.max(BUBBLE_FACE, SPEECH_HEIGHT);
  const top = Math.max(workArea.y, face.y + BUBBLE_FACE - height);
  return {
    bounds: { x: side === "left" ? face.x - SPEECH_WIDTH : face.x, y: top, width: BUBBLE_FACE + SPEECH_WIDTH, height: face.y + BUBBLE_FACE - top },
    side,
  };
}

/** How often the bubble looks for the cursor, so its eyes can follow it anywhere on screen. */
const CURSOR_MS = 66;

export function createBubbleWindow({ BrowserWindow, screen, ipcMain, preload, url, onOpen }) {
  let window = null;
  let face = null;
  let state = null;
  let cursorTimer = null;
  let lastCursor = "";

  function watchCursor() {
    if (cursorTimer) return;
    cursorTimer = setInterval(() => {
      if (!window || window.isDestroyed() || !face) return;
      const point = screen.getCursorScreenPoint();
      const key = `${point.x},${point.y},${face.x},${face.y}`;
      if (key === lastCursor) return;
      lastCursor = key;
      // Where the cursor is, relative to the face's centre.
      window.webContents.send("bubble:cursor", { dx: point.x - (face.x + BUBBLE_FACE / 2), dy: point.y - (face.y + BUBBLE_FACE / 2) });
    }, CURSOR_MS);
  }
  function stopCursor() {
    if (cursorTimer) clearInterval(cursorTimer);
    cursorTimer = null;
    lastCursor = "";
  }

  function workAreaFor(point) {
    return screen.getDisplayNearestPoint({ x: point.x + BUBBLE_FACE / 2, y: point.y + BUBBLE_FACE / 2 }).workArea;
  }

  function layout() {
    if (!window || window.isDestroyed() || !face || !state) return;
    const { bounds, side } = bubbleBounds(face, workAreaFor(face), Boolean(state.speech && state.open));
    window.setBounds(bounds);
    window.webContents.send("bubble:state", { ...state, side, face: BUBBLE_FACE });
  }

  const fromBubble = (event) => Boolean(window && !window.isDestroyed() && event.sender === window.webContents);
  // The bubble window's own messages; anything else it might send is not heard.
  ipcMain.on("bubble:ready", (event) => { if (fromBubble(event)) layout(); });
  ipcMain.on("bubble:move-by", (event, delta) => { if (fromBubble(event)) move(Number(delta?.dx), Number(delta?.dy)); });
  ipcMain.on("bubble:open", (event) => { if (fromBubble(event)) onOpen(); });
  ipcMain.on("bubble:toggle", (event) => { if (fromBubble(event)) toggle(); });
  ipcMain.on("bubble:dismiss", (event) => { if (fromBubble(event)) dismiss(); });

  function move(dx, dy) {
    if (!face || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const next = { x: face.x + dx, y: face.y + dy };
    face = clampFace(next, workAreaFor(next));
    layout();
  }
  /** A tap on the face shows or hides what it said (or says there is nothing new yet). */
  function toggle() {
    if (!state) return;
    state = state.speech
      ? { ...state, open: !state.open }
      : { ...state, speech: { text: "Nothing new yet. Double-click me to open our conversation.", from: state.coworker.name, hint: true, at: Date.now() }, open: true };
    layout();
  }
  function dismiss() {
    if (!state?.open) return;
    state = { ...state, open: false };
    layout();
  }

  return {
    get active() {
      return Boolean(window && !window.isDestroyed());
    },
    /** Shows the bubble for a coworker, at its last place or `near` the window it stands in for. */
    async show({ coworker, near }) {
      state = { coworker, speech: null, open: false };
      const start = face ?? { x: near.x + near.width - BUBBLE_FACE - 12, y: near.y + near.height - BUBBLE_FACE - 48 };
      face = clampFace(start, workAreaFor(start));
      if (!window || window.isDestroyed()) {
        window = new BrowserWindow({
          ...bubbleBounds(face, workAreaFor(face), false).bounds,
          show: false,
          frame: false,
          transparent: true,
          backgroundColor: "#00000000",
          hasShadow: false,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          skipTaskbar: true,
          title: `${coworker.name}`,
          webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
        });
        // Above other windows and on every desktop, including beside full-screen apps.
        window.setAlwaysOnTop(true, "floating");
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", (event) => event.preventDefault());
        const created = window;
        created.on("closed", () => { if (window === created) { window = null; stopCursor(); } });
        await created.loadURL(typeof url === "function" ? url() : url);
        if (created.isDestroyed()) return;
        // It appears without taking focus from whatever the person is doing.
        created.showInactive();
        watchCursor();
      }
      layout();
    },
    /** Something for the person: a speech bubble beside the face. */
    say(speech) {
      if (!state) return;
      state = { ...state, speech: { ...speech, at: Date.now() }, open: true };
      layout();
    },
    close() {
      stopCursor();
      state = null;
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
    },
  };
}
