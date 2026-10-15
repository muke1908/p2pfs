import { randomUUID } from 'node:crypto';
import type { StateStore } from '../config/state.js';
import { AppError, digest, secret } from '../security/auth.js';

export const MAX_GUEST_LINKS = 50;
export const GUEST_LINK_LIFETIME = 24 * 60 * 60 * 1000;
export interface GuestLink {
  id: string;
  label: string;
  tokenHash: string;
  created: number;
  expires: number;
  // Missing scope identifies older item-specific links; never widen them.
  scope?: 'session' | 'selected';
  shareIds: string[];
  textIds: string[];
}
export type GuestLinkSummary = Omit<GuestLink, 'tokenHash'>;

export function isGuestLink(value: unknown): value is GuestLink {
  if (!value || typeof value !== 'object') return false;
  const link = value as Record<string, unknown>;
  const ids = (items: unknown, max: number): items is string[] =>
    Array.isArray(items) &&
    items.length <= max &&
    new Set(items).size === items.length &&
    items.every(
      (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id),
    );
  return (
    typeof link.id === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(link.id) &&
    typeof link.label === 'string' &&
    link.label.trim().length > 0 &&
    link.label.length <= 100 &&
    typeof link.tokenHash === 'string' &&
    /^[a-f0-9]{64}$/.test(link.tokenHash) &&
    Number.isSafeInteger(link.created) &&
    Number(link.created) > 0 &&
    Number.isSafeInteger(link.expires) &&
    Number(link.expires) > Number(link.created) &&
    Number(link.expires) - Number(link.created) <= GUEST_LINK_LIFETIME &&
    ids(link.shareIds, 100) &&
    ids(link.textIds, 50) &&
    (link.scope === undefined ||
      link.scope === 'selected' ||
      link.scope === 'session') &&
    (link.scope === 'session' || link.shareIds.length + link.textIds.length > 0)
  );
}

export class GuestLinks {
  private entries: GuestLink[];
  private tail: Promise<void> = Promise.resolve();
  private sessions = new Map<string, { linkId: string; expires: number }>();
  private attempts: number[] = [];

  constructor(private store: StateStore) {
    this.entries = store.state.guestLinks ?? [];
  }

  list(): GuestLinkSummary[] {
    return this.entries.map(
      ({ id, label, created, expires, scope, shareIds, textIds }) => ({
        id,
        label,
        created,
        expires,
        scope: scope ?? 'selected',
        shareIds: [...shareIds],
        textIds: [...textIds],
      }),
    );
  }

  async create(label: string) {
    const token = secret();
    const created = Date.now();
    const entry: GuestLink = {
      id: randomUUID(),
      label: label.trim(),
      tokenHash: digest(token),
      created,
      expires: created + GUEST_LINK_LIFETIME,
      scope: 'session',
      shareIds: [],
      textIds: [],
    };
    if (!isGuestLink(entry))
      throw new AppError(
        400,
        'Provide a session name of up to 100 characters.',
      );
    await this.change((entries) => {
      const active = entries.filter((link) => link.expires > Date.now());
      if (active.length >= MAX_GUEST_LINKS)
        throw new AppError(
          400,
          'Guest link limit reached (50). Revoke a link before creating another.',
        );
      return [entry, ...active];
    });
    return { id: entry.id, token, expires: entry.expires };
  }

  async revoke(id: string): Promise<void> {
    await this.change((entries) => {
      if (!entries.some((link) => link.id === id))
        throw new AppError(404, 'Guest link not found.');
      return entries.filter((link) => link.id !== id);
    });
  }

  exchange(token: string): { session: string; expires: number } {
    const now = Date.now();
    this.attempts = this.attempts.filter((time) => now - time < 60_000);
    for (const [hash, session] of this.sessions)
      if (
        session.expires <= now ||
        !this.entries.some(
          (link) => link.id === session.linkId && link.expires > now,
        )
      )
        this.sessions.delete(hash);
    if (this.attempts.length >= 200 || this.sessions.size >= 1000)
      throw new AppError(429, 'Guest access capacity reached; retry later.');
    this.attempts.push(now);
    const hash = digest(token);
    const link = this.entries.find(
      (entry) => entry.tokenHash === hash && entry.expires > now,
    );
    if (!link)
      throw new AppError(
        401,
        'This guest link is invalid, expired, or revoked.',
      );
    const session = secret();
    const expires = link.expires;
    this.sessions.set(digest(session), { linkId: link.id, expires });
    return { session, expires };
  }

  valid(session: string | undefined): GuestLink | undefined {
    const hash = digest(session ?? '');
    const entry = this.sessions.get(hash);
    if (!entry) return undefined;
    const link =
      entry.expires > Date.now()
        ? this.entries.find(
            (link) => link.id === entry.linkId && link.expires > Date.now(),
          )
        : undefined;
    if (!link) this.sessions.delete(hash);
    return link;
  }

  require(session: string | undefined): GuestLink {
    const link = this.valid(session);
    if (!link)
      throw new AppError(
        401,
        'Guest access ended. Reopen the original link, or ask the host for a new one.',
      );
    return link;
  }

  logout(session: string | undefined): void {
    this.sessions.delete(digest(session ?? ''));
  }

  private async change(
    update: (entries: GuestLink[]) => GuestLink[],
  ): Promise<void> {
    const operation = this.tail.then(async () => {
      const previous = this.store.state.guestLinks;
      const next = update(this.entries);
      this.store.state.guestLinks = next;
      try {
        await this.store.save();
        this.entries = next;
      } catch (error) {
        this.store.state.guestLinks = previous;
        throw error;
      }
    });
    this.tail = operation.catch(() => {});
    await operation;
  }
}
