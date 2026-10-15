import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { isWhitepad, type SharedWhitepad } from '../texts/service.js';
import {
  isGuestLink,
  MAX_GUEST_LINKS,
  type GuestLink,
} from '../guest/access.js';
import { AppError, passwordHash, verifyPassword } from '../security/auth.js';

export type Provider = 'devtunnel' | 'ngrok' | 'zrok';
export interface ShareDefinition {
  id: string;
  path: string;
}
export interface State {
  version: 3;
  id: string;
  name: string;
  verifier: string;
  shares: ShareDefinition[];
  whitepad: SharedWhitepad;
  guestLinks?: GuestLink[];
  provider: Provider;
  allowedHosts?: string[];
}

export function defaultStateDir(): string {
  const base =
    process.platform === 'win32'
      ? (process.env.LOCALAPPDATA ??
        path.join(os.homedir(), 'AppData', 'Local'))
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : (process.env.XDG_STATE_HOME ??
          path.join(os.homedir(), '.local', 'state'));
  return path.join(base, 'p2pfs');
}

export class StateStore {
  private tail: Promise<void> = Promise.resolve();
  constructor(
    readonly directory: string,
    readonly state: State,
  ) {}

  static async open(
    directory: string,
    password: string,
    initial: Partial<Pick<State, 'name' | 'provider' | 'allowedHosts'>> = {},
  ): Promise<StateStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    let state: State;
    try {
      const parsed: unknown = JSON.parse(
        await readFile(path.join(directory, 'state.json'), 'utf8'),
      );
      if (!isStoredState(parsed))
        throw new Error('Invalid persisted state schema.');
      state = {
        version: 3,
        id: parsed.id,
        name: parsed.name,
        verifier: parsed.verifier,
        shares: parsed.shares,
        whitepad:
          parsed.version === 3 ? parsed.whitepad : migrateTexts(parsed.texts),
        guestLinks: parsed.guestLinks,
        provider: parsed.provider,
        allowedHosts: parsed.allowedHosts,
      };
      if (!(await verifyPassword(password, state.verifier)))
        throw new AppError(401, 'Password does not match this installation.');
    } catch (error) {
      if (!isMissing(error)) throw error;
      state = {
        version: 3,
        id: randomUUID(),
        name: os.hostname(),
        verifier: await passwordHash(password),
        shares: [],
        whitepad: { content: '', revision: 0, updated: 0 },
        provider: 'ngrok',
      };
    }
    Object.assign(state, initial);
    const store = new StateStore(directory, state);
    await store.save();
    return store;
  }

  async save(): Promise<void> {
    const contents = JSON.stringify(this.state, null, 2);
    const operation = this.tail.then(async () => {
      const temporary = path.join(this.directory, `state-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
        await rename(temporary, path.join(this.directory, 'state.json'));
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.tail = operation.catch(() => {});
    await operation;
  }
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

interface LegacyText {
  id: string;
  title: string;
  content: string;
  created: number;
}

function isLegacyText(value: unknown): value is LegacyText {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(item.id) &&
    typeof item.title === 'string' &&
    item.title.length <= 120 &&
    item.title.trim().length > 0 &&
    typeof item.content === 'string' &&
    item.content.length <= 16_000 &&
    item.content.trim().length > 0 &&
    Number.isSafeInteger(item.created) &&
    Number(item.created) > 0
  );
}

function migrateTexts(texts: LegacyText[] = []): SharedWhitepad {
  return {
    content: texts
      .map((entry) => `${entry.title}\n\n${entry.content}`)
      .join('\n\n---\n\n'),
    revision: texts.length ? 1 : 0,
    updated: Math.max(0, ...texts.map((entry) => entry.created)),
  };
}

function isStoredState(value: unknown): value is
  | State
  | (Omit<State, 'version' | 'whitepad'> & {
      version: 1 | 2;
      texts?: LegacyText[];
    }) {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    (v.version === 1 || v.version === 2 || v.version === 3) &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.verifier === 'string' &&
    /^[a-f0-9]{32}:[a-f0-9]{128}$/.test(v.verifier) &&
    ['devtunnel', 'ngrok', 'zrok'].includes(String(v.provider)) &&
    Array.isArray(v.shares) &&
    (v.version === 3
      ? isWhitepad(v.whitepad)
      : v.texts === undefined ||
        (Array.isArray(v.texts) &&
          v.texts.length <= 50 &&
          v.texts.every(isLegacyText))) &&
    (v.guestLinks === undefined ||
      (Array.isArray(v.guestLinks) &&
        v.guestLinks.length <= MAX_GUEST_LINKS &&
        v.guestLinks.every(isGuestLink) &&
        new Set(v.guestLinks.map((link) => link.id)).size ===
          v.guestLinks.length &&
        new Set(v.guestLinks.map((link) => link.tokenHash)).size ===
          v.guestLinks.length)) &&
    v.shares.every(
      (s: unknown) =>
        !!s &&
        typeof s === 'object' &&
        'id' in s &&
        typeof s.id === 'string' &&
        'path' in s &&
        typeof s.path === 'string',
    ) &&
    (v.allowedHosts === undefined ||
      (Array.isArray(v.allowedHosts) &&
        v.allowedHosts.every(
          (host) => typeof host === 'string' && /^[a-z0-9.-]+$/.test(host),
        )))
  );
}
