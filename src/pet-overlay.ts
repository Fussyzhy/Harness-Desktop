/**
 * Desktop pet overlay: the window that puts a dsh-live2d-pets character on the
 * desktop instead of inside the DSH Web GUI.
 *
 * Three things make this possible without touching the plugin:
 *
 * 1. The plugin already answers on loopback. `GET /api/live2d-pet/events` is an
 *    SSE snapshot stream and `/pet-assets/vendor/*` serves the PIXI + Live2D
 *    runtime; neither is behind the Web GUI's launch token (that token guards
 *    the index document only), so an independent page can drive a pet.
 * 2. Windows composites a transparent, frameless, always-on-top window with real
 *    alpha (verified on this machine: 88% of captured pixels come back fully
 *    transparent), including WebGL content.
 * 3. Click-through is a window style the shell can toggle per pointer sample, so
 *    the desktop outside the pet stays clickable while the pet itself is not.
 *
 * This controller owns everything the renderer cannot see: the window, its
 * desktop position, mouse transparency, and the desktop-wide cursor sample used
 * for the pet's gaze. The renderer only draws.
 *
 * Geometry contract with the page (kept in one place per side): the page asks
 * for a window of `petWidth + 2 * PAD_X` by `petHeight + BUBBLE_SPACE + PAD_BOTTOM`
 * and reports the canvas rectangle it actually occupies. Resizing anchors the
 * window's bottom-centre, which is what keeps the pet visually still while the
 * bubble makes room above it.
 */
import { BrowserWindow, screen } from "electron";
import { ipcMain, type IpcMainEvent } from "electron";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Mirrors the page's PAD_X / BUBBLE_SPACE / PAD_BOTTOM. */
const PET_PADDING_X = 70;
const PET_BUBBLE_SPACE = 46;
const PET_PADDING_BOTTOM = 6;
/** Pet body height is this multiple of its width (matches the plugin's canvas). */
const PET_ASPECT = 1.2;
const DEFAULT_PET_SIZE = 160;
const MIN_PET_SIZE = 80;
/** Gap between the pet's window and the work-area edge on first run. */
const DEFAULT_MARGIN_RIGHT = 24;
const DEFAULT_MARGIN_BOTTOM = 20;
/** Cursor sampling cadence; gaze updates are a third of that. */
const CURSOR_POLL_MS = 16;
const GAZE_EVERY_N_TICKS = 3;
/** Vendor files the overlay page may pull through the proxy. */
const VENDOR_FILES = new Set([
  "pixi.min.js",
  "live2dcubismcore.min.js",
  "live2d-display.cubism4.min.js"
]);
const STATE_FILENAME = "pet-overlay.json";

interface PersistedOverlayState {
  x?: number;
  y?: number;
  size?: number;
  userEnabled?: boolean;
}

interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PetOverlayDeps {
  /** Application root; the overlay page lives in `<appRoot>/src`. */
  appRoot: string;
  /** Directory holding the overlay's own persistence file. */
  userDataDir: string;
  /** Diagnostic sink, wired to the application's log buffer. */
  log: (message: string) => void;
  /**
   * Show and focus the DSH window ("I want the client back"). Wired to the same
   * handler as the tray's 打开 item.
   */
  openClient: () => void;
}

/**
 * Owns the overlay window, its loopback origin, and the desktop interaction
 * state. One instance per application.
 */
export class PetOverlayController {
  private readonly deps: PetOverlayDeps;
  private readonly statePath: string;
  private server: Server | undefined;
  private origin: string | undefined;
  private window: BrowserWindow | undefined;
  private dshUrl: string | undefined;
  private cursorTimer: NodeJS.Timeout | undefined;
  private tickCount = 0;
  private canvasRect: CanvasRect | undefined;
  private interactive = false;
  private pageReady = false;
  private disposed = false;
  /** Pet visibility from the plugin's own configuration. */
  private pluginEnabled = true;
  /** Tray switch: "float the pet on the desktop". */
  private userEnabled: boolean;
  private size: number;
  private position: { x: number; y: number } | undefined;
  private dragOrigin: { x: number; y: number; screenX: number; screenY: number } | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private ipcHandlers: Array<[string, (event: IpcMainEvent, ...args: unknown[]) => void]> = [];
  private visibilityListeners = new Set<(visible: boolean) => void>();

  constructor(deps: PetOverlayDeps) {
    this.deps = deps;
    this.statePath = path.join(deps.userDataDir, STATE_FILENAME);
    const persisted = this.readState();
    this.size = normalizeSize(persisted.size);
    this.userEnabled = persisted.userEnabled !== false;
    if (typeof persisted.x === "number" && typeof persisted.y === "number") {
      this.position = { x: persisted.x, y: persisted.y };
    }
    this.registerIpc();
  }

  /** Whether the tray switch currently asks for the pet to float. */
  isUserEnabled(): boolean {
    return this.userEnabled;
  }

  /**
   * Whether the pet is actually on screen: the tray switch, the plugin's own
   * `enabled` configuration and a running service all have to agree.
   */
  isVisible(): boolean {
    return this.userEnabled && this.pluginEnabled && this.dshUrl !== undefined;
  }

  /**
   * Observe {@link isVisible}. The shell uses it to hide the in-window pet only
   * while the floating one is really there — otherwise turning the overlay off
   * would leave the user with no pet at all.
   */
  onVisibilityChange(listener: (visible: boolean) => void): () => void {
    this.visibilityListeners.add(listener);
    return () => this.visibilityListeners.delete(listener);
  }

  /**
   * Toggle the tray switch. Returns the effective value; the window is hidden
   * (not destroyed) so the pet keeps its place and its renderer keeps its model.
   */
  setUserEnabled(enabled: boolean): boolean {
    this.userEnabled = enabled;
    this.saveState();
    this.applyVisibility();
    return this.userEnabled;
  }

  /** Point the overlay at the DSH service, (re)loading the page when it moves. */
  async setDshUrl(url: string | undefined): Promise<void> {
    if (this.disposed) return;
    if (this.dshUrl === url) return;
    this.dshUrl = url;

    if (!url) {
      this.applyVisibility();
      return;
    }

    try {
      const origin = await this.ensureServer();
      const window = this.ensureWindow();
      if (window && !window.isDestroyed()) {
        await window.loadURL(`${origin}/`);
      }
    } catch (error) {
      this.deps.log(`pet overlay: failed to load (${describe(error)})`);
      return;
    }

    this.applyVisibility();
  }

  /** Stop the cursor sampler when the pet is not on screen. */
  dispose(): void {
    this.disposed = true;
    this.stopCursorLoop();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    for (const [channel, handler] of this.ipcHandlers) {
      ipcMain.removeListener(channel, handler);
    }
    this.ipcHandlers = [];
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = undefined;
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
  }

  // ------------------------------------------------------------- visibility --

  private applyVisibility(): void {
    const window = this.window;
    const visible = this.userEnabled && this.pluginEnabled && this.dshUrl !== undefined;

    if (window && !window.isDestroyed()) {
      if (visible) {
        if (!window.isVisible()) window.showInactive();
        this.startCursorLoop();
      } else {
        if (window.isVisible()) window.hide();
        this.stopCursorLoop();
      }
    }

    for (const listener of this.visibilityListeners) {
      try {
        listener(visible);
      } catch (error) {
        this.deps.log(`pet overlay: visibility listener failed (${describe(error)})`);
      }
    }
  }

  // ------------------------------------------------------------------- state --

  private readState(): PersistedOverlayState {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.statePath, "utf8"));
      return typeof parsed === "object" && parsed !== null
        ? (parsed as PersistedOverlayState)
        : {};
    } catch {
      return {};
    }
  }

  private saveState(): void {
    const state: PersistedOverlayState = {
      size: this.size,
      userEnabled: this.userEnabled
    };
    const bounds = this.window && !this.window.isDestroyed() ? this.window.getBounds() : undefined;
    if (bounds) {
      state.x = bounds.x;
      state.y = bounds.y;
    } else if (this.position) {
      state.x = this.position.x;
      state.y = this.position.y;
    }
    try {
      writeFileSync(this.statePath, JSON.stringify(state, undefined, 2) + "\n");
    } catch (error) {
      this.deps.log(`pet overlay: could not persist position (${describe(error)})`);
    }
  }

  /** Coalesce the writes a drag would otherwise produce at pointer rate. */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveState();
    }, 400);
  }

  // ------------------------------------------------------------------ window --

  private windowSize(size = this.size): { width: number; height: number } {
    return {
      width: size + PET_PADDING_X * 2,
      height: Math.round(size * PET_ASPECT) + PET_BUBBLE_SPACE + PET_PADDING_BOTTOM
    };
  }

  /** Bottom-right of the primary work area, the spot the plugin defaults to. */
  private defaultPosition(size = this.size): { x: number; y: number } {
    const { workArea } = screen.getPrimaryDisplay();
    const { width, height } = this.windowSize(size);
    return {
      x: Math.round(workArea.x + workArea.width - width - DEFAULT_MARGIN_RIGHT),
      y: Math.round(workArea.y + workArea.height - height - DEFAULT_MARGIN_BOTTOM)
    };
  }

  /**
   * Keep a saved position only while some display can still show it: a pet
   * restored onto a disconnected monitor would be invisible with no way back
   * except the tray menu.
   */
  private resolvePosition(size = this.size): { x: number; y: number } {
    const { width, height } = this.windowSize(size);
    const candidate = this.position;
    if (candidate) {
      const visible = screen.getAllDisplays().some(({ workArea }) => {
        const overlapX = Math.min(candidate.x + width, workArea.x + workArea.width) - Math.max(candidate.x, workArea.x);
        const overlapY = Math.min(candidate.y + height, workArea.y + workArea.height) - Math.max(candidate.y, workArea.y);
        return overlapX > 60 && overlapY > 60;
      });
      if (visible) return candidate;
      this.deps.log("pet overlay: saved position is off-screen, falling back to the primary display");
    }
    return this.defaultPosition(size);
  }

  private ensureWindow(): BrowserWindow | undefined {
    if (this.window && !this.window.isDestroyed()) return this.window;

    const position = this.resolvePosition();
    const { width, height } = this.windowSize();
    const preload = path.join(this.deps.appRoot, "src", "pet-overlay-preload.cjs");

    const window = new BrowserWindow({
      x: position.x,
      y: position.y,
      width,
      height,
      // A desktop pet must never look like a window: no frame, no shadow, no
      // taskbar entry, and no focus stealing (`focusable: false` keeps the user's
      // typing where it was — and incidentally means the page never receives the
      // blur that would pause an in-window pet).
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      show: false,
      title: "Harness Desktop pet",
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The overlay is unfocused by design; throttling it would freeze the pet.
        backgroundThrottling: false
      }
    });
    window.setAlwaysOnTop(true, "screen-saver");
    this.window = window;
    this.position = position;
    this.pageReady = false;
    // Click-through until the page reports where the pet actually is.
    window.setIgnoreMouseEvents(true, { forward: true });
    this.interactive = false;

    window.once("ready-to-show", () => {
      if (!window.isDestroyed() && this.userEnabled && this.pluginEnabled) window.showInactive();
    });
    window.on("closed", () => {
      if (this.window === window) this.window = undefined;
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      this.deps.log(`pet overlay: renderer gone (${details.reason})`);
    });

    return window;
  }

  // ------------------------------------------------------------ mouse + gaze --

  private startCursorLoop(): void {
    if (this.cursorTimer) return;
    this.cursorTimer = setInterval(() => this.tickCursor(), CURSOR_POLL_MS);
  }

  private stopCursorLoop(): void {
    if (!this.cursorTimer) return;
    clearInterval(this.cursorTimer);
    this.cursorTimer = undefined;
  }

  /**
   * One pointer sample: decide whether the cursor is over the pet, flip the
   * window's mouse transparency accordingly, and hand the position to the page
   * for gaze tracking.
   *
   * The hit test lives here rather than in the renderer because Windows only
   * forwards hover events to a click-through window on a best-effort basis; the
   * cursor position is authoritative and needs no cooperation from the window
   * under it. That is also what lets the pet look at a cursor anywhere on the
   * desktop, not just one inside its own window.
   */
  private tickCursor(): void {
    const window = this.window;
    if (!window || window.isDestroyed() || !window.isVisible()) return;

    const point = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    const rect = this.canvasRect;

    let inside = false;
    if (rect && rect.width > 0 && rect.height > 0) {
      inside =
        point.x >= bounds.x + rect.x &&
        point.x <= bounds.x + rect.x + rect.width &&
        point.y >= bounds.y + rect.y &&
        point.y <= bounds.y + rect.y + rect.height;
    }

    if (inside !== this.interactive) {
      this.interactive = inside;
      window.setIgnoreMouseEvents(!inside, { forward: true });
    }

    this.tickCount += 1;
    if (this.tickCount % GAZE_EVERY_N_TICKS === 0 && !window.webContents.isDestroyed()) {
      window.webContents.send("pet:cursor", {
        x: point.x - bounds.x,
        y: point.y - bounds.y
      });
    }
  }

  // -------------------------------------------------------------------- ipc --

  private registerIpc(): void {
    const fromOverlay = (event: IpcMainEvent): boolean => {
      const window = this.window;
      return window !== undefined && !window.isDestroyed() && event.sender === window.webContents;
    };

    const on = (channel: string, handler: (event: IpcMainEvent, ...args: unknown[]) => void): void => {
      const wrapped = (event: IpcMainEvent, ...args: unknown[]): void => {
        if (!fromOverlay(event)) return;
        try {
          handler(event, ...args);
        } catch (error) {
          this.deps.log(`pet overlay: ${channel} failed (${describe(error)})`);
        }
      };
      ipcMain.on(channel, wrapped);
      this.ipcHandlers.push([channel, wrapped]);
    };

    on("pet:ready", () => {
      this.pageReady = true;
      this.applyVisibility();
    });

    on("pet:set-enabled", (_event, enabled) => {
      this.pluginEnabled = enabled !== false;
      this.applyVisibility();
    });

    on("pet:set-window-size", (_event, payload) => {
      const size = payload as { width?: number; height?: number } | undefined;
      if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
      this.resizeWindow(Math.round(size.width as number), Math.round(size.height as number));
    });

    on("pet:canvas-rect", (_event, payload) => {
      const rect = payload as CanvasRect | undefined;
      if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.width)) return;
      this.canvasRect = rect;
    });

    on("pet:drag-start", (_event, payload) => {
      const point = payload as { screenX: number; screenY: number } | undefined;
      const window = this.window;
      if (!point || !window || window.isDestroyed()) return;
      const bounds = window.getBounds();
      this.dragOrigin = { x: bounds.x, y: bounds.y, screenX: point.screenX, screenY: point.screenY };
    });

    on("pet:drag-move", (_event, payload) => {
      const point = payload as { screenX: number; screenY: number } | undefined;
      const origin = this.dragOrigin;
      const window = this.window;
      if (!point || !origin || !window || window.isDestroyed()) return;
      const x = Math.round(origin.x + (point.screenX - origin.screenX));
      const y = Math.round(origin.y + (point.screenY - origin.screenY));
      window.setBounds({ ...window.getBounds(), x, y });
      this.position = { x, y };
    });

    on("pet:drag-end", () => {
      this.dragOrigin = undefined;
      this.scheduleSave();
    });

    on("pet:open-client", () => {
      this.deps.openClient();
    });
  }

  /**
   * Resize while keeping the window's bottom-centre anchored: the pet sits on
   * that edge, so the character appears to stay put while the bubble space above
   * it grows or shrinks.
   */
  private resizeWindow(width: number, height: number): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    const bounds = window.getBounds();
    if (bounds.width === width && bounds.height === height) return;
    const anchorX = bounds.x + bounds.width / 2;
    const anchorY = bounds.y + bounds.height;
    window.setBounds({
      x: Math.round(anchorX - width / 2),
      y: Math.round(anchorY - height),
      width,
      height
    });
    const next = window.getBounds();
    this.position = { x: next.x, y: next.y };
    const petSize = Math.max(MIN_PET_SIZE, next.width - PET_PADDING_X * 2);
    if (petSize !== this.size) {
      this.size = petSize;
      this.scheduleSave();
    }
    // The pet is bottom-centred, so its rectangle just moved with this resize and
    // every rectangle the page reported before it is stale. Ask again instead of
    // waiting for a `resize` event the page might not be listening for yet.
    if (!window.webContents.isDestroyed()) {
      window.webContents.send("pet:measure");
    }
  }

  // ------------------------------------------------------------------ proxy --

  /**
   * Serve the overlay page and forward the pet's loopback endpoints.
   *
   * The page cannot talk to the DSH origin directly: scripts would load, but
   * `EventSource` is CORS-checked and the DSH server sends no CORS headers. One
   * same-origin hop through this application removes the whole class of problem
   * (and keeps the page origin stable across DSH restarts, which take a new
   * port every time).
   */
  private async ensureServer(): Promise<string> {
    if (this.origin) return this.origin;

    const server = createServer((request, response) => {
      void this.handleRequest(request.url ?? "/", response, request.method ?? "GET");
    });
    server.on("error", (error) => {
      this.deps.log(`pet overlay: server error (${describe(error)})`);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("pet overlay: could not bind a loopback port");
    }

    this.server = server;
    this.origin = `http://127.0.0.1:${address.port}`;
    return this.origin;
  }

  private async handleRequest(
    rawUrl: string,
    response: import("node:http").ServerResponse,
    method: string
  ): Promise<void> {
    let pathname: string;
    try {
      pathname = new URL(rawUrl, "http://127.0.0.1").pathname;
    } catch {
      response.writeHead(400).end();
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }

    try {
      if (pathname === "/" || pathname === "/index.html") {
        this.serveAsset(response, "pet-overlay.html", "text/html; charset=utf-8");
        return;
      }
      if (pathname === "/page.js") {
        this.serveAsset(response, "pet-overlay-page.js", "text/javascript; charset=utf-8");
        return;
      }
      if (pathname.startsWith("/vendor/")) {
        const name = pathname.slice("/vendor/".length);
        if (!VENDOR_FILES.has(name)) {
          response.writeHead(404).end();
          return;
        }
        await this.proxy(`/pet-assets/vendor/${name}`, response);
        return;
      }
      if (pathname === "/api/state") {
        await this.proxy("/api/live2d-pet/state", response);
        return;
      }
      if (pathname === "/api/events") {
        await this.proxySse(response);
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      this.deps.log(`pet overlay: request ${pathname} failed (${describe(error)})`);
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  }

  private serveAsset(
    response: import("node:http").ServerResponse,
    filename: string,
    contentType: string
  ): void {
    const file = path.join(this.deps.appRoot, "src", filename);
    if (!existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    const body = readFileSync(file);
    response.writeHead(200, {
      "content-type": contentType,
      "content-length": String(body.byteLength),
      "cache-control": "no-store"
    });
    response.end(body);
  }

  /** Forward one pet endpoint, passing status and content type through. */
  private async proxy(
    targetPath: string,
    response: import("node:http").ServerResponse
  ): Promise<void> {
    const base = this.dshUrl;
    if (!base) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end("pet overlay: the dsh service is not running");
      return;
    }

    const upstream = await fetch(new URL(targetPath, base), {
      signal: AbortSignal.timeout(15_000)
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "content-length": String(body.byteLength),
      "cache-control": "no-store"
    });
    response.end(body);
  }

  /**
   * Stream `/api/live2d-pet/events` through unchanged. The pet's alive-ness
   * depends on this connection, so a dead upstream or an aborted client both
   * have to end the other side instead of leaking a socket.
   */
  private async proxySse(response: import("node:http").ServerResponse): Promise<void> {
    const base = this.dshUrl;
    if (!base) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end("pet overlay: the dsh service is not running");
      return;
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    response.on("close", abort);

    try {
      const upstream = await fetch(new URL("/api/live2d-pet/events", base), {
        headers: { accept: "text/event-stream" },
        signal: controller.signal
      });
      if (!upstream.ok || !upstream.body) {
        response.writeHead(502).end();
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });

      const reader = upstream.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!response.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => response.once("drain", () => resolve()));
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.deps.log(`pet overlay: state stream ended (${describe(error)})`);
      }
    } finally {
      response.off("close", abort);
      if (!response.writableEnded) response.end();
    }
  }
}

function normalizeSize(value: unknown): number {
  const size = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DEFAULT_PET_SIZE;
  return Math.max(MIN_PET_SIZE, size);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
