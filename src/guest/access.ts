import { randomInt, randomUUID } from 'node:crypto';
import type { StateStore } from '../config/state.js';
import { AppError, digest, secret } from '../security/auth.js';

export const MAX_GUEST_LINKS = 50;
export const GUEST_LINK_LIFETIME = 24 * 60 * 60 * 1000;
export const GUEST_PIN_LIFETIME = 5 * 60 * 1000;
export const GUEST_PIN_COOLDOWN = 60 * 1000;
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
export type GuestLinkSummary = Omit<GuestLink, 'tokenHash'> & {
  pinExpires?: number;
};

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
  private pin?: { code: string; hash: string; linkId: string; expires: number };
  private pinFailures: number[] = [];
  private pinBlockedUntil = 0;

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
        pinExpires:
          this.pin?.linkId === id &&
          this.pin.expires > Date.now() &&
          expires > Date.now()
            ? this.pin.expires
            : undefined,
      }),
    );
  }

  async create(label: string, withPin = false) {
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
    let pin: string | undefined;
    await this.change((entries) => {
      if (withPin) {
        this.checkPinCooldown(Date.now());
        do {
          pin = String(randomInt(10_000)).padStart(4, '0');
        } while (digest(pin) === this.pin?.hash);
      }
      const active = entries.filter((link) => link.expires > Date.now());
      if (active.length >= MAX_GUEST_LINKS)
        throw new AppError(
          400,
          'Guest link limit reached (50). Revoke a link before creating another.',
        );
      return [entry, ...active];
    });
    const pinExpires =
      pin === undefined ? undefined : created + GUEST_PIN_LIFETIME;
    if (pin !== undefined && pinExpires !== undefined)
      this.pin = {
        code: pin,
        hash: digest(pin),
        linkId: entry.id,
        expires: pinExpires,
      };
    return { id: entry.id, token, expires: entry.expires, pin, pinExpires };
  }

  revealPin(id: string): { pin: string; expires: number } {
    const invitation = this.pin;
    if (
      !invitation ||
      invitation.linkId !== id ||
      invitation.expires <= Date.now() ||
      !this.entries.some((link) => link.id === id && link.expires > Date.now())
    )
      throw new AppError(
        404,
        'No unused, unexpired PIN is available for this link.',
      );
    return { pin: invitation.code, expires: invitation.expires };
  }

  async revoke(id: string): Promise<void> {
    await this.change((entries) => {
      if (!entries.some((link) => link.id === id))
        throw new AppError(404, 'Guest link not found.');
      return entries.filter((link) => link.id !== id);
    });
    if (this.pin?.linkId === id) this.pin = undefined;
  }

  exchange(token: string): { session: string; expires: number } {
    const now = Date.now();
    this.checkCapacity(now);
    const hash = digest(token);
    const link = this.entries.find(
      (entry) => entry.tokenHash === hash && entry.expires > now,
    );
    if (!link)
      throw new AppError(
        401,
        'This guest link is invalid, expired, or revoked.',
      );
    return this.createSession(link);
  }

  exchangePin(pin: string): { session: string; expires: number } {
    const now = Date.now();
    this.checkPinCooldown(now);
    this.checkCapacity(now);
    this.pinFailures = this.pinFailures.filter(
      (time) => now - time < GUEST_PIN_COOLDOWN,
    );
    const invitation = this.pin;
    const link =
      /^\d{4}$/.test(pin) &&
      invitation &&
      invitation.expires > now &&
      invitation.hash === digest(pin)
        ? this.entries.find(
            (entry) => entry.id === invitation.linkId && entry.expires > now,
          )
        : undefined;
    if (!link) {
      this.pinFailures.push(now);
      if (this.pinFailures.length >= 5) {
        this.pin = undefined;
        this.pinBlockedUntil = now + GUEST_PIN_COOLDOWN;
        this.checkPinCooldown(now);
      }
      throw new AppError(
        401,
        'This PIN is incorrect, expired, already used, or replaced. Ask the host for a new PIN.',
      );
    }
    this.pin = undefined;
    return this.createSession(link);
  }

  private checkPinCooldown(now: number): void {
    if (now < this.pinBlockedUntil)
      throw new AppError(
        429,
        `PIN joining is temporarily locked. Wait ${Math.ceil((this.pinBlockedUntil - now) / 1000)} seconds and ask the host for a new PIN.`,
      );
  }

  private checkCapacity(now: number): void {
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
  }

  private createSession(link: GuestLink): { session: string; expires: number } {
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
