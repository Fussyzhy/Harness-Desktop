import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import {
  buildDshArguments,
  extractDshUrl,
  getAvailablePort,
  resolveAsarUnpackedPath,
  waitForDshStartup,
  waitForHttp
} from "../src/dsh-server.js";

test("dsh uses the physical unpacked path in packaged applications", () => {
  const packedPath = [
    "C:",
    "Harness Desktop",
    "resources",
    "app.asar",
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "lib",
    "bin.js"
  ].join(path.sep);

  assert.equal(
    resolveAsarUnpackedPath(packedPath),
    packedPath.replace("app.asar", "app.asar.unpacked")
  );
});

test("dsh starts Electron's Node runtime with internal modules exposed", () => {
  assert.deepEqual(
    buildDshArguments({
      cliPath: "C:\\app\\dsh\\lib\\bin.js",
      host: "127.0.0.1",
      port: 12345
    }),
    [
      "--expose-internals",
      "C:\\app\\dsh\\lib\\bin.js",
      "web",
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      "12345"
    ]
  );
});

test("extractDshUrl reads the authenticated Web URL from dsh output", () => {
  assert.equal(
    extractDshUrl(
      "dsh web: http://127.0.0.1:30123/?token=abc123\n"
    ),
    "http://127.0.0.1:30123/?token=abc123"
  );
  assert.equal(extractDshUrl("dsh starting\n"), undefined);
});

test("getAvailablePort returns a bindable local port", async (t) => {
  const port = await getAvailablePort();
  const server = net.createServer();
  t.after(() => {
    server.close();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.port, port);
});

test("waitForHttp resolves when a local server is ready", async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.close();
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await waitForHttp(`http://127.0.0.1:${address.port}`, {
    timeoutMs: 1_000,
    intervalMs: 20
  });
});

test("waitForHttp rejects after the timeout", async () => {
  await assert.rejects(
    waitForHttp("http://127.0.0.1:1", {
      timeoutMs: 80,
      intervalMs: 10,
      requestTimeoutMs: 20
    }),
    /did not become ready/
  );
});

test("waitForDshStartup rejects as soon as the child exits", async () => {
  const child = new EventEmitter();
  setTimeout(() => child.emit("exit", 1, null), 10);

  await assert.rejects(
    waitForDshStartup(
      child as unknown as ChildProcess,
      "http://127.0.0.1:1",
      {
        timeoutMs: 1_000,
        intervalMs: 20,
        requestTimeoutMs: 20
      }
    ),
    /exited before startup/
  );
});
