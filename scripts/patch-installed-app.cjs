const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");

const asar = require("@electron/asar");
const { Pickle } = require("@electron/asar/lib/pickle");
const { getFileIntegrity } = require("@electron/asar/lib/integrity");

const REPO_ROOT = path.join(__dirname, "..");

/**
 * Mirrors electron-builder.yml's `files` list: app.asar holds only these paths,
 * the whole node_modules tree lives unpacked in app.asar.unpacked beside it.
 * Pushing a rebuilt payload into an installed app therefore rewrites a single
 * ~5 MB archive instead of re-running electron-builder over 150 MB.
 *
 * `package.json` is deliberately absent: electron-builder prunes it (no
 * scripts, no devDependencies) before packing, so the repository copy is not a
 * drop-in replacement. A version bump still needs a real repackage.
 */
const PACKED_SOURCES = [
  "dist",
  "src/loading.html",
  "src/pet-overlay.html",
  "src/pet-overlay-page.js",
  "src/pet-overlay-preload.cjs",
  "src/modlens-config.html",
  "src/modlens-config-preload.cjs",
  "build/icon.png"
];

const DEFAULT_RESOURCES = path.join(
  process.env.LOCALAPPDATA ?? process.env.HOME ?? "",
  "Programs",
  "Harness Desktop",
  "resources"
);

function usage() {
  return [
    "Usage: node scripts/patch-installed-app.cjs [options]",
    "",
    "把仓库当前构建出的 dist / src 页面资源 / icon 写进已安装客户端的 app.asar。",
    "已存在的文件就地替换，本版本新增的文件会被追加进去。",
    "必须在 Harness Desktop 完全退出后运行。",
    "",
    "Options:",
    "  --resources <dir>  Electron resources 目录。",
    `                     默认：${DEFAULT_RESOURCES}`,
    "  --dry-run          只报告将要修改的文件，不写入。",
    "  --help             显示本帮助。"
  ].join("\n");
}

function parseArgs(argv) {
  const options = { resources: DEFAULT_RESOURCES, dryRun: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--resources") {
      index += 1;
      if (!argv[index]) {
        throw new Error("--resources 需要一个目录参数。");
      }
      options.resources = path.resolve(argv[index]);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }

  return options;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

/** Read an asar archive and decode its JSON header. */
function readArchive(archivePath) {
  const buffer = fs.readFileSync(archivePath);
  const headerSize = buffer.readUInt32LE(4);
  const headerBuffer = buffer.subarray(8, 8 + headerSize);
  const jsonLength = headerBuffer.readUInt32LE(4);
  const header = JSON.parse(headerBuffer.subarray(8, 8 + jsonLength).toString("utf8"));

  return { buffer, header, headerSize, dataStart: 8 + headerSize };
}

/** Collect every file leaf of an asar header tree. */
function collectLeaves(header) {
  const leaves = [];

  const walk = (directory, prefix) => {
    for (const [name, entry] of Object.entries(directory.files ?? {})) {
      const entryPath = prefix ? `${prefix}/${name}` : name;
      if (entry.files) {
        walk(entry, entryPath);
      } else {
        leaves.push({ path: entryPath, entry });
      }
    }
  };

  walk(header, "");
  return leaves;
}

/**
 * Splice a file this archive has never carried into its header tree, creating
 * whatever directories the path needs. An asar header is plain nested `files`
 * maps, so a new leaf is just another key — only its `offset` has to line up
 * with the payload appended behind the existing entries.
 */
function insertLeaf(header, asarPath, entry) {
  const parts = asarPath.split("/");
  let directory = header;

  for (const name of parts.slice(0, -1)) {
    if (!directory.files) {
      directory.files = {};
    }
    if (!directory.files[name]) {
      directory.files[name] = { files: {} };
    }
    directory = directory.files[name];
  }

  if (!directory.files) {
    directory.files = {};
  }
  directory.files[parts[parts.length - 1]] = entry;
}

/** Read the packed payload straight from the repository working tree. */
function collectRepoFiles() {
  const files = new Map();

  const addPath = (absolutePath, asarPath) => {
    if (!fs.existsSync(absolutePath)) {
      return;
    }

    const stats = fs.statSync(absolutePath);
    if (stats.isFile()) {
      files.set(asarPath, fs.readFileSync(absolutePath));
      return;
    }

    for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
      addPath(path.join(absolutePath, entry.name), `${asarPath}/${entry.name}`);
    }
  };

  for (const source of PACKED_SOURCES) {
    addPath(path.join(REPO_ROOT, source), source);
  }

  return files;
}

function newestMtime(directory) {
  let newest = 0;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(absolutePath));
    } else if (entry.isFile()) {
      newest = Math.max(newest, fs.statSync(absolutePath).mtimeMs);
    }
  }

  return newest;
}

/**
 * Rebuild one archive from the repository payload plus whatever the installed
 * archive already carries. Packed entries keep their original order; offsets and
 * SHA256 integrity blocks are recomputed because a size change shifts every
 * following byte. Files the installed archive has never carried are appended,
 * so a release that only adds assets does not force a full repackage.
 */
async function rebakeArchive(original, repoFiles) {
  const chunks = [];
  const contents = new Map();
  const changed = [];
  const added = [];
  const absent = new Set(repoFiles.keys());
  let offset = 0;

  for (const leaf of collectLeaves(original.header)) {
    if (leaf.entry.unpacked === true) {
      continue;
    }

    const start = original.dataStart + Number(leaf.entry.offset);
    const packaged = original.buffer.subarray(start, start + leaf.entry.size);
    const replacement = repoFiles.get(leaf.path);
    const content = replacement ?? packaged;

    absent.delete(leaf.path);
    if (replacement !== undefined && !replacement.equals(packaged)) {
      changed.push(leaf.path);
    }

    leaf.entry.size = content.length;
    leaf.entry.offset = String(offset);
    if (leaf.entry.integrity) {
      leaf.entry.integrity = await getFileIntegrity(Readable.from(content));
    }

    offset += content.length;
    chunks.push(content);
    contents.set(leaf.path, content);
  }

  // Anything left in `absent` is a file this release adds. electron-builder's
  // `files` globs grow over time, and the desktop pet brings three page assets
  // the installed archive predates; appending them keeps "install this build"
  // a rewrite of the ~5 MB archive instead of a 150 MB repackage.
  const mirroredIntegrity = collectLeaves(original.header).some((leaf) => leaf.entry.integrity);

  for (const asarPath of [...absent].sort()) {
    const content = repoFiles.get(asarPath);
    const entry = { size: content.length, offset: String(offset) };
    if (mirroredIntegrity) {
      entry.integrity = await getFileIntegrity(Readable.from(content));
    }

    insertLeaf(original.header, asarPath, entry);
    absent.delete(asarPath);
    added.push(asarPath);
    offset += content.length;
    chunks.push(content);
    contents.set(asarPath, content);
  }

  const headerPickle = Pickle.createEmpty();
  headerPickle.writeString(JSON.stringify(original.header));
  const headerBuffer = headerPickle.toBuffer();

  const sizePickle = Pickle.createEmpty();
  sizePickle.writeUInt32(headerBuffer.length);
  const sizeBuffer = sizePickle.toBuffer();

  return {
    archive: Buffer.concat([sizeBuffer, headerBuffer, ...chunks]),
    contents,
    changed,
    added,
    // Files the repository builds that this archive still cannot carry.
    absent: [...absent]
  };
}

/**
 * Prove the rewritten archive is readable and every packed entry round-trips to
 * the intended bytes before it is allowed near the installed application.
 */
function verifyArchive(archivePath, contents) {
  const entries = collectLeaves(readArchive(archivePath).header).filter(
    (leaf) => leaf.entry.unpacked !== true
  );

  for (const { path: entryPath } of entries) {
    const expected = contents.get(entryPath);
    const extracted = asar.extractFile(archivePath, entryPath);
    if (expected === undefined) {
      throw new Error(`校验失败：${entryPath} 不在预期内容中。`);
    }
    if (!extracted.equals(expected)) {
      throw new Error(`校验失败：${entryPath} 读回来的内容不一致。`);
    }
  }

  return entries.length;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(usage());
    return 0;
  }

  const archivePath = path.join(options.resources, "app.asar");
  if (!fs.existsSync(archivePath)) {
    console.error(`找不到已安装客户端的 app.asar：${archivePath}`);
    console.error("用 --resources <dir> 指定 Electron 的 resources 目录。");
    return 1;
  }

  const distMain = path.join(REPO_ROOT, "dist", "main.js");
  if (fs.existsSync(distMain) && fs.statSync(distMain).mtimeMs < newestMtime(path.join(REPO_ROOT, "src"))) {
    console.warn("警告：dist/ 比 src/ 旧，先运行 npm run build 再打补丁。");
  }

  const original = readArchive(archivePath);
  const repoFiles = collectRepoFiles();
  const result = await rebakeArchive(original, repoFiles);

  console.log(`目标安装：${archivePath}`);
  console.log(`原 app.asar：${original.buffer.length} 字节，sha256 ${sha256(original.buffer)}`);
  console.log(`打包文件：${result.contents.size} 个`);

  if (result.added.length > 0) {
    console.log(`新增文件：${result.added.length} 个`);
    for (const added of result.added) {
      console.log(`  + ${added}`);
    }
  }

  if (result.absent.length > 0) {
    console.warn(`警告：仓库里有 ${result.absent.length} 个文件无法写入 app.asar：`);
    for (const absent of result.absent.slice(0, 10)) {
      console.warn(`  ${absent}`);
    }
  }

  if (result.changed.length === 0 && result.added.length === 0) {
    console.log("已安装客户端的内容就是最新的，无需修改。");
    return 0;
  }

  if (result.changed.length > 0) {
    console.log("将要更新：");
    for (const changed of result.changed) {
      console.log(`  ${changed}`);
    }
  }

  if (options.dryRun) {
    console.log("--dry-run：未写入任何文件。");
    return 0;
  }

  const stagingPath = `${archivePath}.new`;
  const backupPath = `${archivePath}.bak`;
  fs.writeFileSync(stagingPath, result.archive);

  try {
    const entryCount = verifyArchive(stagingPath, result.contents);
    console.log(`新 app.asar 校验通过：${entryCount} 个打包条目，sha256 ${sha256(result.archive)}`);

    try {
      fs.renameSync(archivePath, backupPath);
    } catch (error) {
      console.error(`无法替换 app.asar（${error.code ?? error.message}）。`);
      console.error("请先完全退出 Harness Desktop（含右下角托盘图标）再重新运行。");
      return 1;
    }

    try {
      fs.renameSync(stagingPath, archivePath);
    } catch (error) {
      fs.renameSync(backupPath, archivePath);
      throw error;
    }

    fs.rmSync(backupPath, { force: true });
    console.log("已写入。重新启动 Harness Desktop 后生效。");
    return 0;
  } finally {
    fs.rmSync(stagingPath, { force: true });
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`打补丁失败，已保持原安装不变：${error.message}`);
    process.exitCode = 1;
  });
