/**
 * Preload for the vision-engine settings window.
 *
 * Hand-written CommonJS on purpose: the page runs with `sandbox: true`, and a
 * sandboxed preload cannot be an ES module, so this file ships as an asset next
 * to `loading.html` instead of going through `tsc`.
 *
 * The surface is three calls into a window the main process owns. The page
 * never touches the configuration file itself: every read and write goes
 * through the plugin's own CLI in the main process, which is what keeps the
 * schema, the validation, and the secret handling in one place.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("modlensConfig", {
  /**
   * Read the current state: the masked settings, and the `doctor --json` report
   * the form is built from.
   */
  load: () => ipcRenderer.invoke("modlens:load"),

  /**
   * Write the changed settings. Each entry is `{ key, value, secret }`; a secret
   * is handed to the CLI on stdin by the main process, never as an argument.
   * The answer carries what was applied, what was refused, and a fresh report.
   */
  save: (changes) => ipcRenderer.invoke("modlens:save", changes),

  /** Close the window. */
  close: () => ipcRenderer.invoke("modlens:close")
});
