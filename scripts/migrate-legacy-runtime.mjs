import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const USAGE = `用法: node scripts/migrate-legacy-runtime.mjs [选项]

选项:
  --source-root PATH  旧版运行时目录（默认: 当前仓库根目录）
  --runtime-dir PATH  新运行时目录（默认: <仓库>/runtime）
  --execute           执行复制；省略时仅预览
  --overwrite         允许覆盖目标中的冲突文件
  -h, --help          显示此帮助信息`;

export function parseArgs(argv = [], cwd = process.cwd()) {
  const options = { execute: false, overwrite: false, sourceRoot: REPOSITORY_ROOT, runtimeDir: path.join(REPOSITORY_ROOT, 'runtime') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') options.execute = true;
    else if (arg === '--overwrite') options.overwrite = true;
    else if (arg === '--source-root') options.sourceRoot = path.resolve(cwd, argv[++i]);
    else if (arg === '--runtime-dir') options.runtimeDir = path.resolve(cwd, argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

async function walk(root) {
  const result = [];
  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${absolute}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  }
  await visit(root);
  return result;
}

function destinationFor(sourceRoot, file, runtimeDir) {
  const relative = path.relative(sourceRoot, file);
  const category = relative.startsWith(`credentials${path.sep}`) ? 'credentials'
    : relative.startsWith(`session-json${path.sep}`) ? 'inbox'
      : path.basename(relative).startsWith('aliases-') ? path.join('inbox', 'aliases') : 'inbox';
  const targetRelative = category === 'credentials' ? path.join(category, relative.slice(`credentials${path.sep}`.length))
    : path.join(category, relative);
  return path.join(runtimeDir, targetRelative);
}

async function sha256(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

export async function migrate(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot === undefined ? path.join(REPOSITORY_ROOT, 'legacy-runtime') : options.sourceRoot);
  const runtimeDir = path.resolve(options.runtimeDir || path.join(REPOSITORY_ROOT, 'runtime'));
  if (sourceRoot === runtimeDir || sourceRoot.startsWith(`${runtimeDir}${path.sep}`) || runtimeDir.startsWith(`${sourceRoot}${path.sep}`)) throw new Error('source-root and runtime-dir must differ and not overlap');
  const files = (await walk(sourceRoot)).filter((file) => {
    const relative = path.relative(sourceRoot, file);
    return relative.startsWith(`credentials${path.sep}`) || relative.startsWith(`session-json${path.sep}`) || path.basename(relative).startsWith('aliases-');
  });
  const entries = files.map((source) => ({ source, target: destinationFor(sourceRoot, source, runtimeDir), relative: path.relative(sourceRoot, source) }));
  const categories = { credentials: { identical: 0, copied: 0, overwritten: 0 }, sessions: { identical: 0, copied: 0, overwritten: 0 }, aliases: { identical: 0, copied: 0, overwritten: 0 } };
  for (const entry of entries) {
    try {
      const target = await fs.readFile(entry.target);
      const source = await fs.readFile(entry.source);
      const category = entry.target.includes(`${path.sep}credentials${path.sep}`) ? 'credentials' : entry.target.includes(`${path.sep}aliases${path.sep}`) ? 'aliases' : 'sessions';
      if (Buffer.compare(source, target) === 0) categories[category].identical += 1;
      else if (!options.overwrite) throw new Error(`target conflict: ${entry.target}`);
      else categories[category].overwritten += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const category = entry.target.includes(`${path.sep}credentials${path.sep}`) ? 'credentials' : entry.target.includes(`${path.sep}aliases${path.sep}`) ? 'aliases' : 'sessions';
      categories[category].copied += 1;
    }
  }
  const result = { mode: options.execute ? 'execute' : 'dry-run', files: entries.length, verifiedFiles: 0, categories, manifest: entries.map((entry) => ({ source: entry.relative, target: path.relative(runtimeDir, entry.target) })) };
  if (!options.execute) return result;
  const runtimeStat = await fs.lstat(runtimeDir).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (runtimeStat?.isSymbolicLink()) throw new Error(`runtime-dir cannot be a symbolic link: ${runtimeDir}`);
  let runtimeParent = path.dirname(runtimeDir);
  while (runtimeParent && runtimeParent !== path.dirname(runtimeParent)) {
    const stat = await fs.lstat(runtimeParent).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (stat?.isSymbolicLink()) throw new Error(`runtime-dir parent cannot be a symbolic link: ${runtimeParent}`);
    runtimeParent = path.dirname(runtimeParent);
  }
  const staging = path.join(path.dirname(runtimeDir), `.migration-staging-${process.pid}-${Date.now()}`);
  const backups = [];
  const writtenTargets = [];
  try {
    await fs.mkdir(staging, { recursive: true });
    for (const entry of entries) {
      let parent = path.dirname(entry.target);
      while (parent !== runtimeDir && parent.startsWith(`${runtimeDir}${path.sep}`)) {
        try {
          const stat = await fs.lstat(parent);
          if (stat.isSymbolicLink()) throw new Error(`target path cannot contain symbolic links: ${parent}`);
          if (!stat.isDirectory()) throw new Error(`target conflict: ${parent}`);
        } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        parent = path.dirname(parent);
      }
    }
    const manifest = [];
    for (const entry of entries) {
      try { backups.push({ target: entry.target, data: await fs.readFile(entry.target) }); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    for (const entry of entries) {
      const staged = path.join(staging, path.relative(runtimeDir, entry.target));
      await fs.mkdir(path.dirname(staged), { recursive: true });
      await fs.copyFile(entry.source, staged);
      await fs.chmod(staged, 0o600);
      manifest.push({ source: entry.relative, target: path.relative(runtimeDir, entry.target), sha256: await sha256(entry.source) });
    }
    await fs.mkdir(path.dirname(path.join(staging, 'inbox', 'migration-manifest.json')), { recursive: true });
    await fs.writeFile(path.join(staging, 'inbox', 'migration-manifest.json'), `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), files: manifest }, null, 2)}\n`);
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.chmod(runtimeDir, 0o700);
    for (const entry of entries) {
      const target = entry.target;
      const staged = path.join(staging, path.relative(runtimeDir, target));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.chmod(path.dirname(target), 0o700);
      await fs.copyFile(staged, target);
      await fs.chmod(target, 0o600);
      writtenTargets.push(target);
      if ((await sha256(target)) !== await sha256(entry.source)) throw new Error(`verification failed: ${target}`);
      result.verifiedFiles += 1;
    }
    const manifestTarget = path.join(runtimeDir, 'inbox', 'migration-manifest.json');
    await fs.chmod(path.dirname(manifestTarget), 0o700);
    await fs.copyFile(path.join(staging, 'inbox', 'migration-manifest.json'), manifestTarget);
    await fs.chmod(manifestTarget, 0o600);
    result.manifest = manifest;
    return result;
  } catch (error) {
    for (const backup of backups) {
      await fs.mkdir(path.dirname(backup.target), { recursive: true }).catch(() => {});
      await fs.writeFile(backup.target, backup.data).catch(() => {});
    }
    const backedUp = new Set(backups.map((item) => item.target));
    for (const target of writtenTargets) if (!backedUp.has(target)) await fs.rm(target, { force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
  } else {
    migrate(options).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
