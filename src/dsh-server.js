import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

const require = createRequire(import.meta.url);

export function resolveDshCliPath() {
  const packageJsonPath = require.resolve("@deepseek-ai/dsh/package.json");
  return path.join(path.dirname(packageJsonPath), "lib", "bin.js");
}

export function buildDshArguments({ cliPath, host, port }) {
  return [
    "--expose-internals",
    cliPath,
    "web",
    "--host",
    host,
    "--port",
    String(port)
  ];
}

export async function getAvailablePort(host = "127.0.0.1") {
  const server = net.createServer();

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, resolve);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine an available local port.");
    }

    return address.port;
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

export function startDshServer({ electronPath, cwd, host, port }) {
  const cliPath = resolveDshCliPath();
  const args = buildDshArguments({ cliPath, host, port });
  const child = spawn(
    electronPath,
    args,
    {
      cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NO_COLOR: "1"
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  );

  return child;
}

export async function waitForDshStartup(child, url, options) {
  let exitHandler;
  let errorHandler;
  const stopped = new Promise((_, reject) => {
    exitHandler = (code, signal) => {
      reject(
        new Error(
          `dsh exited before startup (code ${code ?? "unknown"}, signal ${signal ?? "none"}).`
        )
      );
    };
    errorHandler = (error) => reject(error);
    child.once("exit", exitHandler);
    child.once("error", errorHandler);
  });

  try {
    await Promise.race([waitForHttp(url, options), stopped]);
  } finally {
    child.off("exit", exitHandler);
    child.off("error", errorHandler);
  }
}

export async function waitForHttp(
  url,
  { timeoutMs = 90_000, intervalMs = 250, requestTimeoutMs = 1_000 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs)
      });

      if (response.status >= 200 && response.status < 500) {
        return;
      }

      lastError = new Error(`Server returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `DeepSeek Harness did not become ready within ${timeoutMs / 1_000} seconds.`,
    { cause: lastError }
  );
}
