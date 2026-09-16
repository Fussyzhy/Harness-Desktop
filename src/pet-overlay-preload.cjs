/**
 * Preload for the desktop pet overlay window.
 *
 * Hand-written CommonJS on purpose: the overlay renderer runs with
 * `sandbox: true`, and a sandboxed preload cannot be an ES module, so this file
 * ships as an asset next to `loading.html` instead of going through `tsc`.
 *
 * The surface is deliberately tiny. Every call is a request from the renderer
 * to the main process, which owns the window: geometry, mouse transparency, and
 * the desktop-wide cursor sample all live there, because a renderer that cannot
 * see outside its own window cannot implement a desktop pet on its own.
 */
const { contextBridge, ipcRenderer } = require("electron");

/** Screen-space pointer samples pushed by the main process (~20 Hz). */
const CURSOR_CHANNEL = "pet:cursor";

/** "The window moved or resized — re-report the canvas rectangle." */
const MEASURE_CHANNEL = "pet:measure";

contextBridge.exposeInMainWorld("petOverlay", {
  /** The page booted and is ready to be shown. */
  ready: () => ipcRenderer.send("pet:ready"),

  /**
   * Pet visibility from the plugin's own configuration (settings → 桌宠配置).
   * The window is hidden while this is false; the tray switch is separate.
   */
  setEnabled: (enabled) => ipcRenderer.send("pet:set-enabled", Boolean(enabled)),

  /** Window size the current pet size needs, in DIP. */
  setWindowSize: (width, height) =>
    ipcRenderer.send("pet:set-window-size", {
      width: Math.round(Number(width)),
      height: Math.round(Number(height))
    }),

  /**
   * The pet canvas rectangle inside the window. The main process hit-tests the
   * desktop cursor against it to decide when the window should stop being
   * click-through, so a click on the pet is delivered to the page.
   */
  setCanvasRect: (rect) =>
    ipcRenderer.send("pet:canvas-rect", {
      x: Number(rect.x),
      y: Number(rect.y),
      width: Number(rect.width),
      height: Number(rect.height)
    }),

  /**
   * Drag by absolute screen coordinates rather than deltas: the window itself
   * moves under the pointer, so any window-relative delta would feed back on
   * itself. `screenX/screenY` are stable for the whole gesture.
   */
  dragStart: (screenX, screenY) =>
    ipcRenderer.send("pet:drag-start", { screenX: Number(screenX), screenY: Number(screenY) }),
  dragMove: (screenX, screenY) =>
    ipcRenderer.send("pet:drag-move", { screenX: Number(screenX), screenY: Number(screenY) }),
  dragEnd: () => ipcRenderer.send("pet:drag-end"),

  /**
   * Bring the DSH window back (double click on the pet). The main process owns
   * the window, so this is a request rather than something the page could do.
   */
  openClient: () => ipcRenderer.send("pet:open-client"),

  /** Subscribe to the desktop-wide cursor samples used for eye/head tracking. */
  onCursor: (listener) => {
    const wrapped = (_event, point) => listener(point);
    ipcRenderer.on(CURSOR_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(CURSOR_CHANNEL, wrapped);
  },

  /**
   * The main process finished resizing/repositioning the window, so the canvas
   * rectangle the page last reported is stale. Keeping this a request rather
   * than trusting the page's `resize` event matters: the window can settle
   * before a listener exists (the page still has vendor scripts to load), and a
   * stale rectangle means clicks on the pet fall through to whatever is behind
   * it — the DSH window, usually.
   */
  onMeasure: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on(MEASURE_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(MEASURE_CHANNEL, wrapped);
  }
});
