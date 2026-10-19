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
import { isPrivateIPv4, parseGuestUrl } from './network.js';

export type Provider = 'devtunnel' | 'ngrok' | 'zrok';
export type Access = 'lan' | 'tunnel';
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

async function configuredHost(
  directory: string,
  previous: Provider,
): Promise<{
  provider: Provider;
  access: Access;
  lanAddress?: string;
  guestUrl?: string;
  proxyOnly: boolean;
}> {
  const filename = path.join(directory, 'host.json');
  try {
    await writeFile(
      filename,
      `${JSON.stringify({ access: 'lan', provider: previous }, null, 2)}\n`,
      {
        mode: 0o600,
        flag: 'wx',
      },
    );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
      throw error;
  }
  let config: unknown;
  try {
    config = JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read host configuration ${filename}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).some(
      (key) =>
        !['access', 'provider', 'lanAddress', 'guestUrl', 'proxyOnly'].includes(
          key,
        ),
    ) ||
    Object.keys(config).length === 0 ||
    ('lanAddress' in config && typeof config.lanAddress !== 'string') ||
    ('guestUrl' in config && typeof config.guestUrl !== 'string') ||
    ('proxyOnly' in config && typeof config.proxyOnly !== 'boolean')
  )
    throw new Error(
      `Invalid host configuration ${filename}: use "access" ("lan" or "tunnel"), optional "provider" ("ngrok", "devtunnel", or "zrok"), optional "lanAddress" (a private IPv4 address), optional "guestUrl" (the LAN reverse proxy's HTTP(S) address and path prefix), and optional "proxyOnly" (a boolean requiring LAN mode and guestUrl). No other fields are allowed.`,
    );
  let access: Access = 'lan';
  if ('access' in config) {
    if (config.access !== 'lan' && config.access !== 'tunnel')
      throw new Error(
        `Invalid host configuration ${filename}: "access" must be "lan" or "tunnel".`,
      );
    access = config.access;
  }
  let provider = previous;
  if ('provider' in config) {
    if (
      config.provider !== 'devtunnel' &&
      config.provider !== 'ngrok' &&
      config.provider !== 'zrok'
    )
      throw new Error(
        `Invalid host configuration ${filename}: "provider" must be "ngrok", "devtunnel", or "zrok".`,
      );
    provider = config.provider;
  }
  let address: string | undefined;
  if ('lanAddress' in config && typeof config.lanAddress === 'string') {
    if (!isPrivateIPv4(config.lanAddress))
      throw new Error(
        `Invalid host configuration ${filename}: "lanAddress" must be a private IPv4 address.`,
      );
    address = config.lanAddress;
  }
  let guestUrl: string | undefined;
  if ('guestUrl' in config && typeof config.guestUrl === 'string') {
    try {
      guestUrl = parseGuestUrl(config.guestUrl);
    } catch (error) {
      throw new Error(
        `Invalid host configuration ${filename}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    provider,
    access,
    lanAddress: address,
    guestUrl,
    proxyOnly: 'proxyOnly' in config && config.proxyOnly === true,
  };
}

export class StateStore {
  private tail: Promise<void> = Promise.resolve();
  constructor(
    readonly directory: string,
    readonly state: State,
    readonly lanAddress?: string,
    readonly access: Access = 'lan',
    readonly guestUrl?: string,
    readonly proxyOnly = false,
  ) {}

  static async open(
    directory: string,
    password: string,
    initial: Partial<Pick<State, 'name' | 'allowedHosts'>> = {},
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
    const config = await configuredHost(directory, state.provider);
    state.provider = config.provider;
    Object.assign(state, initial);
    const store = new StateStore(
      directory,
      state,
      config.lanAddress,
      config.access,
      config.guestUrl,
      config.proxyOnly,
    );
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
