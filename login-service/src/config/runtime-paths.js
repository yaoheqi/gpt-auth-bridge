import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repositoryRoot = path.resolve(serverDir, '..');

export const RUNTIME_DIRECTORY_NAMES = Object.freeze([
  'config', 'state', 'credentials', 'sessions', 'exports', 'logs', 'jobs', 'inbox',
]);

function resolveConfiguredPath(value, fallback, base = repositoryRoot) {
  const configured = String(value || '').trim();
  if (!configured) return path.resolve(fallback);
  return path.resolve(base, configured);
}

function assertWithinRuntime(runtimeDir, target, label) {
  const relative = path.relative(path.resolve(runtimeDir), path.resolve(target));
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside RUNTIME_DIR`);
  }
  return target;
}

export function createRuntimePaths(env = process.env) {
  const runtimeDir = resolveConfiguredPath(env.RUNTIME_DIR, path.join(repositoryRoot, 'runtime'));
  const directories = Object.fromEntries(RUNTIME_DIRECTORY_NAMES.map(name => [name, path.join(runtimeDir, name)]));
  const paths = {
    repositoryRoot, serverDir, runtimeDir, ...directories,
    sqliteDbFile: ':memory:',
    settingsFile: '',
    desktopSettingsFile: path.join(directories.state, 'desktop', 'settings.json'),
    desktopStateDir: path.join(directories.state, 'desktop'),
  };
  for (const name of RUNTIME_DIRECTORY_NAMES) assertWithinRuntime(runtimeDir, paths[name], name);
  for (const name of [
    'desktopSettingsFile', 'desktopStateDir',
  ]) assertWithinRuntime(runtimeDir, paths[name], name);
  return Object.freeze(paths);
}

export async function ensureRuntimeDirectories(paths) {
  const directories = [paths.runtimeDir, ...RUNTIME_DIRECTORY_NAMES.map(name => paths[name]), paths.desktopStateDir];
  await Promise.all(directories.map(directory => fs.mkdir(directory, { recursive: true })));
  const realRoot = await fs.realpath(paths.runtimeDir);
  for (const directory of directories.slice(1)) {
    const realDirectory = await fs.realpath(directory);
    assertWithinRuntime(realRoot, realDirectory, directory);
  }
  return paths;
}

export const runtimePaths = createRuntimePaths();

