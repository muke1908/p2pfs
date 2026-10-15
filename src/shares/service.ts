import path from 'node:path';
import { lstat, readdir, realpath, open, constants } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { watch, type FSWatcher } from 'node:fs';
import type { StateStore, ShareDefinition } from '../config/state.js';
import { AppError } from '../security/auth.js';

export interface SharedFile {
  id: string;
  name: string;
  size: number;
  modified: number;
}
interface IndexedFile extends SharedFile {
  absolute: string;
}
interface Share {
  definition: ShareDefinition;
  name: string;
  kind: 'file' | 'directory';
  root: string;
  files: Map<string, IndexedFile>;
  warnings: string[];
  streams: Set<Readable>;
}

export async function assertNoLinks(input: string): Promise<void> {
  const absolute = path.resolve(input);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute
    .slice(root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new AppError(400, 'Symlink paths are not supported.');
  }
  if (
    path.normalize(await realpath(absolute)).toLowerCase() !==
    absolute.toLowerCase()
  )
    throw new AppError(400, 'Reparse or redirected paths are not supported.');
}

export class Shares {
  revision = 0;
  private entries = new Map<string, Share>();
  private unavailable = new Map<string, string>();
  private watchWarnings = new Map<string, string>();
  private watchers = new Map<string, FSWatcher[]>();
  private timers = new Map<string, NodeJS.Timeout>();
  private refreshing = new Set<string>();
  private dirty = new Set<string>();
  private closed = false;
  constructor(private store: StateStore) {}

  async initialize(): Promise<void> {
    for (const definition of this.store.state.shares) {
      try {
        this.entries.set(definition.id, await this.index(definition));
      } catch (error) {
        this.unavailable.set(
          definition.id,
          `Share ${definition.id} unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await this.observe(definition);
    }
  }

  list(local = false) {
    return [...this.entries.values()].map((entry) => ({
      id: entry.definition.id,
      name: entry.name,
      kind: entry.kind,
      count: entry.files.size,
      ...(entry.kind === 'file'
        ? { file: this.files(entry.definition.id).files[0]! }
        : {}),
      ...(local
        ? { path: entry.definition.path, warnings: entry.warnings }
        : {}),
    }));
  }

  warnings(): string[] {
    return [...this.unavailable.values(), ...this.watchWarnings.values()];
  }

  async add(input: string): Promise<string> {
    if (this.store.state.shares.length >= 100)
      throw new AppError(400, 'Share limit reached.');
    const definition = { id: randomUUID(), path: path.resolve(input) };
    const indexed = await this.index(definition);
    this.store.state.shares.push(definition);
    await this.store.save();
    this.entries.set(definition.id, indexed);
    await this.observe(definition);
    this.revision++;
    return definition.id;
  }

  async refresh(id: string): Promise<void> {
    const old = this.get(id);
    const next = await this.index(old.definition);
    this.cancel(old);
    this.entries.set(id, next);
    this.unavailable.delete(id);
    await this.observe(next.definition);
    this.revision++;
  }

  async remove(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry && !this.store.state.shares.some((share) => share.id === id))
      throw new AppError(404, 'Share not found.');
    if (entry) this.cancel(entry);
    this.entries.delete(id);
    this.stopWatching(id);
    this.unavailable.delete(id);
    this.watchWarnings.delete(id);
    this.store.state.shares = this.store.state.shares.filter(
      (share) => share.id !== id,
    );
    await this.store.save();
    this.revision++;
  }

  files(id: string, offset = 0): { files: SharedFile[]; next: number | null } {
    const files = [...this.get(id).files.values()];
    return {
      files: files
        .slice(offset, offset + 100)
        .map(({ id, name, size, modified }) => ({ id, name, size, modified })),
      next: offset + 100 < files.length ? offset + 100 : null,
    };
  }

  async stream(
    shareId: string,
    fileId: string,
  ): Promise<{ file: SharedFile; stream: Readable }> {
    const entry = this.get(shareId);
    const file = entry.files.get(fileId);
    if (!file) throw new AppError(404, 'File not found; refresh the catalog.');
    if (entry.streams.size >= 8)
      throw new AppError(429, 'Share transfer capacity reached.');
    await assertNoLinks(file.absolute);
    const relative = path.relative(entry.root, file.absolute);
    if (
      relative.startsWith(`..${path.sep}`) ||
      relative === '..' ||
      path.isAbsolute(relative)
    )
      throw new AppError(403, 'File escaped its share.');
    const handle = await open(
      file.absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size !== file.size ||
      stat.mtimeMs !== file.modified
    ) {
      await handle.close();
      throw new AppError(409, 'Source changed; refresh the share.');
    }
    const source = handle.createReadStream({ autoClose: false });
    const stream = Readable.from(
      (async function* () {
        try {
          for await (const chunk of source) yield chunk;
          const final = await handle.stat();
          if (final.size !== stat.size || final.mtimeMs !== stat.mtimeMs)
            throw new Error('Source changed during transfer.');
        } finally {
          source.destroy();
          await handle.close();
        }
      })(),
    );
    // Closing before the generator starts must also release the descriptor.
    stream.once('close', () => {
      entry.streams.delete(stream);
      source.destroy();
      void handle
        .close()
        .catch((error: unknown) => stream.emit('error', error));
    });
    entry.streams.add(stream);
    return { file, stream };
  }

  close(): void {
    this.closed = true;
    for (const id of this.watchers.keys()) this.stopWatching(id);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const entry of this.entries.values()) this.cancel(entry);
  }

  private stopWatching(id: string): void {
    for (const watcher of this.watchers.get(id) ?? []) watcher.close();
    this.watchers.delete(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.dirty.delete(id);
  }

  private async observe(definition: ShareDefinition): Promise<void> {
    if (this.closed) return;
    const watchers: FSWatcher[] = [];
    const problem = (error: unknown) => {
      if (
        this.closed ||
        !this.store.state.shares.some((entry) => entry.id === definition.id)
      )
        return;
      this.watchWarnings.set(
        definition.id,
        `Live updates unavailable for ${definition.path}; re-index manually: ${error instanceof Error ? error.message : String(error)}`,
      );
    };
    try {
      const parent = path.dirname(definition.path);
      await assertNoLinks(parent);
      if (
        this.closed ||
        !this.store.state.shares.some((entry) => entry.id === definition.id)
      )
        return;
      const guardian = watch(parent, (_event, filename) => {
        if (
          !filename ||
          path.resolve(parent, filename.toString()) === definition.path
        )
          this.scheduleRefresh(definition.id);
      });
      guardian.on('error', problem);
      watchers.push(guardian);
      const entry = this.entries.get(definition.id);
      if (entry && entry.root === definition.path) {
        const folder = watch(definition.path, { recursive: true }, () =>
          this.scheduleRefresh(definition.id),
        );
        folder.on('error', problem);
        watchers.push(folder);
      }
      this.watchWarnings.delete(definition.id);
    } catch (error) {
      problem(error);
    }
    for (const watcher of this.watchers.get(definition.id) ?? [])
      watcher.close();
    this.watchers.set(definition.id, watchers);
  }

  private scheduleRefresh(id: string): void {
    if (this.closed) return;
    clearTimeout(this.timers.get(id));
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.refreshLive(id);
    }, 100);
    timer.unref();
    this.timers.set(id, timer);
  }

  private async refreshLive(id: string): Promise<void> {
    if (this.closed) return;
    if (this.refreshing.has(id)) {
      this.dirty.add(id);
      return;
    }
    const definition = this.store.state.shares.find((entry) => entry.id === id);
    if (!definition) return;
    this.refreshing.add(id);
    const previous = this.entries.get(id);
    try {
      const next = await this.index(definition);
      if (
        this.closed ||
        !this.store.state.shares.some((entry) => entry.id === id) ||
        this.entries.get(id) !== previous
      )
        return;
      if (previous) {
        const oldFiles = new Map(
          [...previous.files.values()].map((file) => [file.absolute, file]),
        );
        const files = new Map<string, IndexedFile>();
        for (const file of next.files.values()) {
          const old = oldFiles.get(file.absolute);
          if (old && old.size === file.size && old.modified === file.modified)
            file.id = old.id;
          files.set(file.id, file);
        }
        next.files = files;
        next.streams = previous.streams;
      }
      this.entries.set(id, next);
      this.unavailable.delete(id);
      await this.observe(definition);
      this.revision++;
    } catch (error) {
      if (
        this.closed ||
        !this.store.state.shares.some((entry) => entry.id === id)
      )
        return;
      if (previous) this.cancel(previous);
      this.entries.delete(id);
      this.unavailable.set(
        id,
        `Share ${definition.path} unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.observe(definition);
      this.revision++;
    } finally {
      this.refreshing.delete(id);
      if (this.dirty.delete(id) && !this.closed) this.scheduleRefresh(id);
    }
  }

  private get(id: string): Share {
    const value = this.entries.get(id);
    if (!value) throw new AppError(404, 'Share not found.');
    return value;
  }

  private cancel(entry: Share): void {
    for (const stream of entry.streams)
      stream.destroy(new Error('Share revoked or refreshed.'));
  }

  private async index(definition: ShareDefinition): Promise<Share> {
    await assertNoLinks(definition.path);
    const stat = await lstat(definition.path);
    if (!stat.isFile() && !stat.isDirectory())
      throw new AppError(400, 'Only regular files and folders can be shared.');
    const entry: Share = {
      definition,
      name: path.basename(definition.path),
      kind: stat.isDirectory() ? 'directory' : 'file',
      root: stat.isDirectory()
        ? definition.path
        : path.dirname(definition.path),
      files: new Map(),
      warnings: [],
      streams: new Set(),
    };
    let visited = 0;
    const visit = async (absolute: string, depth: number): Promise<void> => {
      if (++visited > 10_000 || depth > 64)
        throw new AppError(
          400,
          'Share is too large or deeply nested (10,000 entries, depth 64).',
        );
      const item = await lstat(absolute);
      if (item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())) {
        entry.warnings.push(
          `Skipped unsupported entry: ${path.relative(entry.root, absolute)}`,
        );
      } else if (item.isDirectory()) {
        for (const child of await readdir(absolute))
          await visit(path.join(absolute, child), depth + 1);
      } else {
        const id = randomUUID();
        entry.files.set(id, {
          id,
          absolute,
          name: path.relative(entry.root, absolute).split(path.sep).join('/'),
          size: item.size,
          modified: item.mtimeMs,
        });
      }
    };
    await visit(definition.path, 0);
    return entry;
  }
}
