import path from 'node:path';
import os from 'node:os';
import { lstat, opendir } from 'node:fs/promises';
import { AppError } from '../security/auth.js';
import { assertNoLinks } from './service.js';

export async function browseFilesystem(input = os.homedir(), hidden = false) {
  try {
    if (!path.isAbsolute(input))
      throw new AppError(400, 'Enter an absolute file or folder path.');
    await assertNoLinks(input);
    const stat = await lstat(input);
    if (!stat.isFile() && !stat.isDirectory())
      throw new AppError(
        400,
        'Only regular files and folders can be selected.',
      );
    const selected = stat.isFile() ? path.normalize(input) : null;
    const current = selected ? path.dirname(selected) : path.normalize(input);
    const entries: {
      name: string;
      path: string;
      kind: 'directory' | 'file';
    }[] = [];
    let omitted = 0;
    let truncated = false;
    let visited = 0;
    const directory = await opendir(current);
    for await (const entry of directory) {
      if (++visited > 1000) {
        truncated = true;
        break;
      }
      if (!hidden && entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() && !entry.isFile()) {
        omitted++;
        continue;
      }
      entries.push({
        name: entry.name,
        path: path.join(current, entry.name),
        kind: entry.isDirectory() ? 'directory' : 'file',
      });
    }
    entries.sort(
      (a, b) =>
        Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
        a.name.localeCompare(b.name),
    );
    return {
      path: current,
      parent: path.dirname(current) === current ? null : path.dirname(current),
      selected,
      entries,
      omitted,
      truncated,
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (['EACCES', 'EPERM'].includes(String(error.code)))
        throw new AppError(
          403,
          'This location cannot be read by the host process.',
        );
      if (['ENOENT', 'ENOTDIR'].includes(String(error.code)))
        throw new AppError(
          404,
          'This location no longer exists. Check the path and try again.',
        );
    }
    throw error;
  }
}
