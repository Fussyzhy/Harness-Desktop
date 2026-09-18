const fs = require("node:fs");
const path = require("node:path");

const PACKAGE_NAME = "@deepseek-ai/dsh-host-directory-picker-native";
const SUPPORTED_VERSION = "0.1.6-alpha.2";
const WORKER_PATH = path.join(
  __dirname,
  "..",
  "node_modules",
  "@deepseek-ai",
  "dsh-host-directory-picker-native",
  "lib",
  "worker.cjs"
);
const PACKAGE_JSON_PATH = path.join(
  __dirname,
  "..",
  "node_modules",
  "@deepseek-ai",
  "dsh-host-directory-picker-native",
  "package.json"
);

const VULNERABLE_READ_UTF16 = `function readUtf16(koffi, address) {
	const bytes = Buffer.from(koffi.view(address, 32768));
	let end = 0;
	while (end + 1 < bytes.length && bytes[end] !== 0) end += 2;
	return bytes.toString("utf16le", 0, end);
}`;

const EXTERNAL_VIEW_READ_UTF16 = `function readUtf16(koffi, address) {
	const kernel32 = koffi.load("kernel32.dll");
	const lstrlenW = kernel32.func("__stdcall", "lstrlenW", "int", ["void *"]);
	const length = lstrlenW(address);
	if (length === 0) return "";
	const bytes = Buffer.from(koffi.view(address, length * 2));
	return bytes.toString("utf16le");
}`;

const PATCHED_READ_UTF16 = `function readUtf16(koffi, address) {
	return koffi.decode.string16(address);
}`;

const UPSTREAM_SAFE_READ_UTF16 = `function readUtf16(koffi, address, pointerSize) {
	const pointer = Buffer.alloc(8);
	pointer.writeBigUInt64LE(BigInt(address));
	return koffi.decode(pointer.subarray(0, pointerSize), "str16");
}`;

function patchWorkerSource(source) {
  if (
    source.includes(PATCHED_READ_UTF16) ||
    source.includes(UPSTREAM_SAFE_READ_UTF16)
  ) {
    return source;
  }

  for (const unsafeImplementation of [
    VULNERABLE_READ_UTF16,
    EXTERNAL_VIEW_READ_UTF16
  ]) {
    if (source.includes(unsafeImplementation)) {
      return source.replace(unsafeImplementation, PATCHED_READ_UTF16);
    }
  }

  throw new Error(
    `${PACKAGE_NAME}: worker source changed; review the directory-picker patch`
  );
}

function patchInstalledWorker() {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
  if (packageJson.version !== SUPPORTED_VERSION) {
    throw new Error(
      `${PACKAGE_NAME}: expected ${SUPPORTED_VERSION}, found ${String(packageJson.version)}`
    );
  }

  const source = fs.readFileSync(WORKER_PATH, "utf8");
  const patched = patchWorkerSource(source);
  if (patched === source) {
    console.log(`${PACKAGE_NAME}: Windows directory-picker patch already applied`);
    return;
  }

  fs.writeFileSync(WORKER_PATH, patched, "utf8");
  console.log(`${PACKAGE_NAME}: applied Windows directory-picker crash patch`);
}

if (require.main === module) {
  patchInstalledWorker();
}

module.exports = {
  EXTERNAL_VIEW_READ_UTF16,
  PATCHED_READ_UTF16,
  UPSTREAM_SAFE_READ_UTF16,
  VULNERABLE_READ_UTF16,
  patchInstalledWorker,
  patchWorkerSource
};
