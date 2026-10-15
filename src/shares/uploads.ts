import { mkdir, readdir, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../security/auth.js';
import type { StateStore } from '../config/state.js';
import { assertNoLinks, type Shares } from './service.js';

export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

export class Uploads {
  private root: string;
  private active = new Map<string, AbortController>();
  private tasks = new Set<Promise<string>>();
  private closed = false;

  constructor(
    private store: StateStore,
    private shares: Shares,
  ) {
    this.root = path.resolve(store.directory, 'uploads');
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertNoLinks(this.root);
    await this.cleanup();
  }

  async cleanup(): Promise<void> {
    await assertNoLinks(this.root);
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const directory = path.join(this.root, entry.name);
      if (this.active.has(directory)) continue;
      const referenced = this.store.state.shares.some(
        ({ path: source }) =>
          source === directory ||
          source.startsWith(directory + path.sep) ||
          directory.startsWith(path.resolve(source) + path.sep),
      );
      if (!referenced) await rm(directory, { recursive: true, force: true });
    }
  }

  owns(filename: string): boolean {
    return /^[a-f0-9-]{36}[/\\][^/\\]+$/.test(
      path.relative(this.root, filename),
    );
  }

  add(input: Readable, name: string, authorize: () => void): Promise<string> {
    if (this.closed) throw new AppError(503, 'Host is stopping.');
    if (this.store.state.shares.length >= 100)
      throw new AppError(400, 'Share limit reached.');
    if (this.active.size >= 2)
      throw new AppError(
        429,
        'Two files are already being copied; try again shortly.',
      );
    if (
      !name.trim() ||
      name === '.' ||
      name === '..' ||
      // eslint-disable-next-line no-control-regex
      /[/\\\u0000-\u001f\u007f]/.test(name) ||
      Buffer.byteLength(name) > 240
    )
      throw new AppError(400, 'Choose a plain filename of at most 240 bytes.');
    const directory = path.join(this.root, randomUUID());
    const controller = new AbortController();
    this.active.set(directory, controller);
    const task = this.copy(
      input,
      name,
      directory,
      controller.signal,
      authorize,
    );
    this.tasks.add(task);
    void task
      .finally(() => {
        this.tasks.delete(task);
        this.active.delete(directory);
      })
      .catch(() => {});
    return task;
  }

  private async copy(
    input: Readable,
    name: string,
    directory: string,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<string> {
    let committed = false;
    try {
      await assertNoLinks(this.root);
      await mkdir(directory, { mode: 0o700 });
      const filename = path.join(directory, name);
      let bytes = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > MAX_UPLOAD_BYTES
              ? new AppError(413, 'Dropped files must be 1 GiB or smaller.')
              : null,
            chunk,
          );
        },
      });
      await pipeline(
        input,
        limit,
        createWriteStream(filename, { flags: 'wx', mode: 0o600 }),
        { signal },
      );
      authorize();
      signal.throwIfAborted();
      const id = await this.shares.add(filename);
      committed = true;
      return id;
    } finally {
      if (!committed) await rm(directory, { recursive: true, force: true });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled(this.tasks);
  }
}
