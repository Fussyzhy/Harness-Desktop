const fs = require("node:fs");
const path = require("node:path");

const SUPPORTED_VERSION = "0.1.6-alpha.2";
const SETTINGS_CLIENT_PACKAGE = "@deepseek-ai/dsh-client-ui-settings-general";
const NATIVE_COMMAND_PACKAGE = "@deepseek-ai/dsh-native-command";

function packagePath(packageName, ...parts) {
  return path.join(__dirname, "..", "node_modules", packageName, ...parts);
}

const SETTINGS_OPEN_TRY_BLOCK = `\t\t\ttry {
					const result = await this.ctx.remote.settings.openSettingsDocument();
					if (!result.ok) {
						const { message } = result.error;
						this.store.update((state) => {
							state.error = message;
						});
					}
				} finally {
					this.store.update((state) => {
						state.opening = false;
					});
				}`;

const PATCHED_SETTINGS_OPEN_TRY_BLOCK = `\t\t\ttry {
					const result = await this.ctx.remote.settings.openSettingsDocument();
					if (!result.ok) {
						const { message } = result.error;
						this.store.update((state) => {
							state.error = message;
						});
					}
				} catch (error) {
					this.store.update((state) => {
						state.error = error instanceof Error ? error.message : String(error);
					});
				} finally {
					this.store.update((state) => {
						state.opening = false;
					});
				}`;

const NATIVE_COMMAND_RUNNER_OPTIONS = `\texecFile(command, [...args], {
		encoding: "utf8",
		signal,
		windowsHide: true
	},`;

const PATCHED_NATIVE_COMMAND_RUNNER_OPTIONS = `\texecFile(command, [...args], {
		encoding: "utf8",
		signal,
		windowsHide: true,
		env: Object.fromEntries(
			Object.entries(process.env).filter(([name]) => name !== "ELECTRON_RUN_AS_NODE")
		)
	},`;

function patchSettingsClientSource(source) {
  if (source.includes(PATCHED_SETTINGS_OPEN_TRY_BLOCK)) return source;
  if (!source.includes(SETTINGS_OPEN_TRY_BLOCK)) {
    throw new Error(
      `${SETTINGS_CLIENT_PACKAGE}: settings open source changed; review the patch`
    );
  }
  return source.replace(SETTINGS_OPEN_TRY_BLOCK, PATCHED_SETTINGS_OPEN_TRY_BLOCK);
}

function patchNativeCommandSource(source) {
  if (source.includes(PATCHED_NATIVE_COMMAND_RUNNER_OPTIONS)) return source;
  if (!source.includes(NATIVE_COMMAND_RUNNER_OPTIONS)) {
    throw new Error(
      `${NATIVE_COMMAND_PACKAGE}: command runner source changed; review the patch`
    );
  }
  return source.replace(
    NATIVE_COMMAND_RUNNER_OPTIONS,
    PATCHED_NATIVE_COMMAND_RUNNER_OPTIONS
  );
}

function patchInstalledPackage(packageName, sourceParts, patch) {
  const manifest = JSON.parse(
    fs.readFileSync(packagePath(packageName, "package.json"), "utf8")
  );
  if (manifest.version !== SUPPORTED_VERSION) {
    throw new Error(
      `${packageName}: expected ${SUPPORTED_VERSION}, found ${String(manifest.version)}`
    );
  }

  const sourcePath = packagePath(packageName, ...sourceParts);
  const source = fs.readFileSync(sourcePath, "utf8");
  const patched = patch(source);
  if (patched === source) {
    console.log(`${packageName}: settings-open patch already applied`);
    return;
  }
  fs.writeFileSync(sourcePath, patched, "utf8");
  console.log(`${packageName}: applied settings-open patch`);
}

function patchInstalledSettingsOpen() {
  patchInstalledPackage(
    SETTINGS_CLIENT_PACKAGE,
    ["lib", "client.js"],
    patchSettingsClientSource
  );
  patchInstalledPackage(
    NATIVE_COMMAND_PACKAGE,
    ["lib", "index.js"],
    patchNativeCommandSource
  );
}

if (require.main === module) patchInstalledSettingsOpen();

module.exports = {
  NATIVE_COMMAND_RUNNER_OPTIONS,
  PATCHED_NATIVE_COMMAND_RUNNER_OPTIONS,
  PATCHED_SETTINGS_OPEN_TRY_BLOCK,
  SETTINGS_OPEN_TRY_BLOCK,
  patchNativeCommandSource,
  patchSettingsClientSource
};
