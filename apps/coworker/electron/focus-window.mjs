/**
 * Focus mode on a desktop: the window becomes a small conversation window
 * docked at the right edge of its display, like a phone propped beside your
 * work. On macOS the close, minimize and zoom buttons step aside too (⌘W and
 * ⌘M still work). Leaving Focus mode puts the window and its buttons back.
 */

const FOCUS_WIDTH = 420;
const FOCUS_MAX_HEIGHT = 900;
const EDGE = 16;
const FULL_SCREEN_EXIT_MS = 1500;

/** The docked rectangle inside a display's work area: phone-shaped, right edge, vertically centred. */
export function focusWindowBounds(workArea) {
  const width = Math.min(FOCUS_WIDTH, workArea.width - EDGE * 2);
  const height = Math.min(FOCUS_MAX_HEIGHT, workArea.height - EDGE * 2);
  return {
    x: workArea.x + workArea.width - width - EDGE,
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
}

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Where to put the window back: its old place while that is still on a display, otherwise the same size centred on the current one. */
export function restoredBounds(saved, workAreas, current) {
  if (workAreas.some((area) => overlaps(saved, area))) return saved;
  const width = Math.min(saved.width, current.width);
  const height = Math.min(saved.height, current.height);
  return { x: current.x + Math.round((current.width - width) / 2), y: current.y + Math.round((current.height - height) / 2), width, height };
}

function leaveFullScreen(window) {
  if (!window.isFullScreen()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FULL_SCREEN_EXIT_MS);
    window.once("leave-full-screen", () => { clearTimeout(timer); resolve(); });
    window.setFullScreen(false);
  });
}

/** Docks and restores one window. Docking again while docked only re-docks, so the remembered place survives a reload. */
export function createFocusWindow(screen) {
  let saved = null;
  const mac = process.platform === "darwin";
  return {
    async set(window, on) {
      if (!window || window.isDestroyed()) return { docked: false, controlsHidden: false };
      if (on) {
        if (!saved) saved = { bounds: window.getNormalBounds(), maximized: window.isMaximized(), fullScreen: window.isFullScreen() };
        await leaveFullScreen(window);
        if (window.isMaximized()) window.unmaximize();
        if (mac) window.setWindowButtonVisibility(false);
        window.setBounds(focusWindowBounds(screen.getDisplayMatching(window.getBounds()).workArea), mac);
        return { docked: true, controlsHidden: mac };
      }
      if (mac) window.setWindowButtonVisibility(true);
      if (!saved) return { docked: false, controlsHidden: false };
      const { bounds, maximized, fullScreen } = saved;
      saved = null;
      const current = screen.getDisplayMatching(window.getBounds()).workArea;
      window.setBounds(restoredBounds(bounds, screen.getAllDisplays().map((display) => display.workArea), current), mac);
      if (maximized) window.maximize();
      if (fullScreen) window.setFullScreen(true);
      return { docked: false, controlsHidden: false };
    },
  };
}
