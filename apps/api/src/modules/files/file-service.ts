/**
 * Server file manager.
 *
 * Path traversal is the entire threat model here. Defence is layered:
 *   1. Zod rejects `..`, absolute paths and NUL bytes at the edge.
 *   2. `resolveWithin` re-resolves against the server root and refuses
 *      anything that escapes it - this is the authoritative check.
 *   3. Symlinks are resolved before the containment check, so a link planted
 *      inside the volume cannot point out of it.
 *   4. Writes are restricted to an extension allowlist, and a deny-list blocks
 *      names like `.ssh` and `.env` outright.
 */

import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FILE_MANAGER } from '@asp/shared';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  sizeBytes: number;
  modifiedAt: string;
  editable: boolean;
}

/**
 * Resolves `relativePath` inside `root` and proves the result stays there.
 *
 * `realpath` is applied to whichever ancestor exists so that a symlink cannot
 * be used to step outside after the string check passes.
 */
export async function resolveWithin(root: string, relativePath: string): Promise<string> {
  if (relativePath.includes('\0')) throw badRequest('Invalid path.');

  const rootReal = await realpath(root).catch(() => path.resolve(root));
  const candidate = path.resolve(rootReal, relativePath);

  // String-level containment first.
  if (candidate !== rootReal && !candidate.startsWith(rootReal + path.sep)) {
    logger.warn({ root, relativePath }, 'Blocked path traversal attempt');
    throw forbidden('That path is outside the server directory.');
  }

  // Then resolve symlinks on the deepest existing ancestor and re-check, so a
  // link planted inside the volume cannot point out of it.
  //
  // The walk is clamped at the root: if the target does not exist yet, its
  // ancestors above the root are irrelevant, and continuing past it would
  // reject every write to a not-yet-created file.
  let existing = candidate;
  for (;;) {
    try {
      await stat(existing);
      break;
    } catch {
      if (existing === rootReal) break;
      const parent = path.dirname(existing);
      if (parent === existing || parent.length < rootReal.length) {
        existing = rootReal;
        break;
      }
      existing = parent;
    }
  }

  const existingReal = await realpath(existing).catch(() => existing);
  if (existingReal !== rootReal && !existingReal.startsWith(rootReal + path.sep)) {
    logger.warn({ root, relativePath, existingReal }, 'Blocked symlink escape attempt');
    throw forbidden('That path is outside the server directory.');
  }

  return candidate;
}

function isDenied(name: string): boolean {
  const lower = name.toLowerCase();
  return FILE_MANAGER.deniedNames.some((denied) => lower === denied || lower.startsWith(`${denied}.`));
}

export function isEditable(name: string): boolean {
  if (isDenied(name)) return false;
  const ext = path.extname(name).toLowerCase();
  return FILE_MANAGER.editableExtensions.includes(ext);
}

export async function listDirectory(root: string, relativePath: string): Promise<FileEntry[]> {
  const target = await resolveWithin(root, relativePath);

  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('That folder does not exist.');
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') throw badRequest('That is not a folder.');
    throw error;
  }

  const results: FileEntry[] = [];

  for (const entry of entries) {
    if (isDenied(entry.name)) continue;
    // Symlinks are not listed at all - following them is the escape vector,
    // and a game server has no legitimate need for them here.
    if (entry.isSymbolicLink()) continue;

    const entryPath = path.join(target, entry.name);
    const stats = await stat(entryPath).catch(() => null);
    if (!stats) continue;

    results.push({
      name: entry.name,
      path: path.posix.join(relativePath.replace(/\\/g, '/'), entry.name).replace(/^\/+/, ''),
      type: entry.isDirectory() ? 'directory' : 'file',
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      editable: entry.isFile() && isEditable(entry.name),
    });
  }

  // Directories first, then alphabetical.
  return results.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function readTextFile(root: string, relativePath: string): Promise<string> {
  const target = await resolveWithin(root, relativePath);
  const name = path.basename(target);

  if (isDenied(name)) throw forbidden('That file cannot be opened.');

  const stats = await stat(target).catch(() => null);
  if (!stats) throw notFound('That file does not exist.');
  if (!stats.isFile()) throw badRequest('That is not a file.');
  if (stats.size > FILE_MANAGER.maxEditableBytes) {
    throw badRequest(
      `That file is too large to open in the editor (${Math.round(stats.size / 1024 / 1024)} MB). Download it instead.`,
    );
  }

  return readFile(target, 'utf8');
}

export async function writeTextFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const target = await resolveWithin(root, relativePath);
  const name = path.basename(target);

  if (!isEditable(name)) {
    throw forbidden(
      `Only these file types can be edited: ${FILE_MANAGER.editableExtensions.join(', ')}`,
    );
  }
  if (Buffer.byteLength(content, 'utf8') > FILE_MANAGER.maxEditableBytes) {
    throw badRequest('That content is too large to save.');
  }

  await mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
  // 0640: readable by the container's group, never world-readable.
  await writeFile(target, content, { mode: 0o640 });
}

export async function createDirectory(root: string, relativePath: string): Promise<void> {
  const target = await resolveWithin(root, relativePath);
  if (isDenied(path.basename(target))) throw forbidden('That name is not allowed.');
  await mkdir(target, { recursive: true, mode: 0o750 });
}

export async function deletePath(root: string, relativePath: string): Promise<void> {
  if (relativePath === '' || relativePath === '/' || relativePath === '.') {
    throw forbidden('The server root cannot be deleted.');
  }

  const target = await resolveWithin(root, relativePath);
  const rootReal = await realpath(root).catch(() => path.resolve(root));

  if (target === rootReal) throw forbidden('The server root cannot be deleted.');
  if (isDenied(path.basename(target))) throw forbidden('That path cannot be deleted.');

  await rm(target, { recursive: true, force: false }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('That path does not exist.');
    throw error;
  });
}

export async function movePath(
  root: string,
  fromRelative: string,
  toRelative: string,
): Promise<void> {
  const from = await resolveWithin(root, fromRelative);
  const to = await resolveWithin(root, toRelative);

  if (isDenied(path.basename(from)) || isDenied(path.basename(to))) {
    throw forbidden('That path cannot be moved.');
  }

  await mkdir(path.dirname(to), { recursive: true, mode: 0o750 });
  await rename(from, to).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('That path does not exist.');
    throw error;
  });
}

/** Opens a read stream for download, after the same containment checks. */
export async function openDownloadStream(
  root: string,
  relativePath: string,
): Promise<{ stream: NodeJS.ReadableStream; size: number; name: string }> {
  const target = await resolveWithin(root, relativePath);
  const name = path.basename(target);

  if (isDenied(name)) throw forbidden('That file cannot be downloaded.');

  const stats = await stat(target).catch(() => null);
  if (!stats) throw notFound('That file does not exist.');
  if (!stats.isFile()) throw badRequest('That is not a file.');

  return { stream: createReadStream(target), size: stats.size, name };
}

/** Recursively sums a directory's size, with a node budget to bound the walk. */
export async function directorySize(root: string, budget = 200_000): Promise<number> {
  let total = 0;
  let visited = 0;
  const queue: string[] = [root];

  while (queue.length > 0 && visited < budget) {
    const current = queue.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      visited += 1;
      if (visited >= budget) break;
      if (entry.isSymbolicLink()) continue;

      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
      } else {
        const stats = await stat(entryPath).catch(() => null);
        if (stats) total += stats.size;
      }
    }
  }

  return total;
}
