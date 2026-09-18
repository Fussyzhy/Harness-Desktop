import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

const require = createRequire(import.meta.url);

interface DshArgumentsOptions {
  cliPath: string;
  host: string;
  port: number;
}

interface StartDshServerOptions {
  electronPath: string;
  cwd: string;
  host: string;
  port: number;
  /**
   * Environment for the child, merged over this process's own. The desktop
   * shell uses it to put the pnpm shim on the child's `PATH` and to give the
   * installs it runs the pnpm settings they need.
   */
  extraEnv?: NodeJS.ProcessEnv;
}

interface WaitForHttpOptions {
  timeoutMs?: number;
  intervalMs?: number;
  requestTimeoutMs?: number;
}

export function resolveDshPackageJsonPath(): string {
  return resolveAsarUnpackedPath(
    require.resolve("@deepseek-ai/dsh/package.json")
  );
}

export function resolveDshCliPath(): string {
  return path.join(path.dirname(resolveDshPackageJsonPath()), "lib", "bin.js");
}

export function resolveAsarUnpackedPath(filePath: string): string {
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  const unpackedSegment = `${path.sep}app.asar.unpacked${path.sep}`;
  return filePath.replace(asarSegment, unpackedSegment);
}

export function buildDshArguments({
  cliPath,
  host,
  port
}: DshArgumentsOptions): string[] {
  return [
    "--expose-internals",
    cliPath,
    "web",
    "--no-open",
    "--host",
    host,
    "--port",
    String(port)
  ];
}

export function extractDshUrl(output: string): string | undefined {
  const match = output.match(/\bdsh web:\s+(https?:\/\/\S+)/);
  return match?.[1].replace(/[\r\n]+$/, "");
}

export async function getAvailablePort(host = "127.0.0.1"): Promise<number> {
  const server = net.createServer();

  try {
    await new Promise<void>((resolve, reject) => {
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
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

export function startDshServer({
  electronPath,
  cwd,
  host,
  port,
  extraEnv
}: StartDshServerOptions): ChildProcess {
  const cliPath = resolveDshCliPath();
  const args = buildDshArguments({ cliPath, host, port });

  return spawn(electronPath, args, {
    cwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NO_COLOR: "1",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

export async function waitForDshStartup(
  child: ChildProcess,
  url: string,
  options?: WaitForHttpOptions
): Promise<void> {
  let exitHandler:
    | ((code: number | null, signal: NodeJS.Signals | null) => void)
    | undefined;
  let errorHandler: ((error: Error) => void) | undefined;

  const stopped = new Promise<never>((_resolve, reject) => {
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
    if (exitHandler) {
      child.off("exit", exitHandler);
    }
    if (errorHandler) {
      child.off("error", errorHandler);
    }
  }
}

export async function waitForHttp(
  url: string,
  {
    timeoutMs = 90_000,
    intervalMs = 250,
    requestTimeoutMs = 1_000
  }: WaitForHttpOptions = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

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
    `The local dsh service did not become ready within ${timeoutMs / 1_000} seconds.`,
    { cause: lastError }
  );
}
