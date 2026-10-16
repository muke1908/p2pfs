import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import { StateStore, type Access } from '../config/state.js';
import { lanAddress, parseGuestUrl } from '../config/network.js';
import { AppError, Sessions, digest } from '../security/auth.js';
import { Transport, tunnelHosts, publicUrl } from '../security/transport.js';
import { Shares } from '../shares/service.js';
import { browseFilesystem } from '../shares/browser.js';
import { Uploads, MAX_UPLOAD_BYTES } from '../shares/uploads.js';
import { Previews } from '../shares/previews.js';
import { Whitepad, MAX_WHITEPAD_LENGTH } from '../texts/service.js';
import { Tunnel } from '../tunnels/manager.js';
import { page } from '../dashboard/page.js';
import { LiveHub } from '../live/streams.js';
import { GuestLinks } from '../guest/access.js';
import { guestPage } from '../guest/page.js';

const text = { type: 'string', minLength: 1, maxLength: 1024 };
const identifier = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[a-zA-Z0-9_-]+$',
};
const passwordBody = {
  type: 'object',
  required: ['password'],
  additionalProperties: false,
  properties: { password: text },
};
const bodySchema = (
  properties: Record<string, unknown>,
  required: string[],
) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const browserAssets = new URL(
  import.meta.url.endsWith('.ts') ? '../../dist/src/' : '../',
  import.meta.url,
);

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface HostOptions {
  transferPort?: number;
  managementPort?: number;
  transport?: Transport;
  publicUrl?: string;
  lanAddress?: string;
  access?: Access;
  guestUrl?: string;
}
export class Host {
  readonly transfer: FastifyInstance;
  readonly management: FastifyInstance;
  readonly shares: Shares;
  private uploads: Uploads;
  private previews: Previews;
  readonly whitepad: Whitepad;
  readonly guestLinks: GuestLinks;
  readonly tunnel: Tunnel;
  transferUrl = '';
  managementUrl = '';
  private localSessions: Sessions;
  private transport: Transport;
  private closing = false;
  private cookieName: string;
  private localLive = new LiveHub();
  private guestLive = new LiveHub();
  private guestStreams = new Map<Readable, string>();
  private lastGuestLinks = '';
  private liveTimer?: NodeJS.Timeout;
  private lastLiveState = '';
  private lastLiveCatalog = '';
  private lanAddress?: string;
  private guestUrl?: URL;

  constructor(
    readonly store: StateStore,
    private options: HostOptions = {},
  ) {
    if (
      options.lanAddress !== undefined &&
      (options.publicUrl || options.access === 'tunnel')
    )
      throw new AppError(
        400,
        'An explicit LAN address cannot be combined with tunnel mode or a public URL.',
      );
    const access =
      options.lanAddress !== undefined
        ? 'lan'
        : options.publicUrl
          ? 'tunnel'
          : (options.access ?? store.access);
    if (access === 'lan')
      this.lanAddress = lanAddress(options.lanAddress ?? store.lanAddress);
    const guestUrl = options.guestUrl ?? store.guestUrl;
    if (guestUrl) {
      const parsed = new URL(parseGuestUrl(guestUrl));
      if (this.lanAddress) this.guestUrl = parsed;
    }
    this.transport =
      options.transport ??
      new Transport({
        allowedHosts: [...tunnelHosts, ...(store.state.allowedHosts ?? [])],
      });
    this.localSessions = new Sessions(store.state.verifier);
    this.cookieName = `p2pfs_${store.state.id}`;
    const createServer = () =>
      Fastify({
        bodyLimit: 16 * 1024,
        requestTimeout: 30_000,
        connectionTimeout: 120_000,
        keepAliveTimeout: 5000,
        ajv: { customOptions: { removeAdditional: false } },
        logger: {
          level: 'warn',
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'password',
            'token',
            'pin',
          ],
        },
      });
    this.transfer = createServer();
    this.management = createServer();
    for (const server of [this.transfer, this.management]) {
      server.setErrorHandler((error, _request, reply) => {
        const status =
          error instanceof Error &&
          'statusCode' in error &&
          typeof error.statusCode === 'number'
            ? error.statusCode
            : 500;
        if (status >= 500) server.log.error({ err: error }, 'Request failed');
        reply.code(status).send({
          error:
            status >= 500 && !(error instanceof AppError)
              ? 'Operation failed; check local server diagnostics.'
              : error instanceof Error
                ? error.message
                : 'Request rejected.',
        });
      });
      server.addHook('onSend', async (_request, reply, payload) => {
        reply.header('cache-control', 'no-store');
        reply.header('x-content-type-options', 'nosniff');
        return payload;
      });
    }
    this.shares = new Shares(store);
    this.uploads = new Uploads(store, this.shares);
    this.previews = new Previews(this.shares);
    this.whitepad = new Whitepad(store);
    this.guestLinks = new GuestLinks(store);
    this.tunnel = new Tunnel(this.transport, store.state.id);
    this.publicRoutes();
    this.localRoutes();
  }

  async listen(): Promise<void> {
    try {
      await this.uploads.initialize();
      await this.shares.initialize();
      this.transferUrl = await this.transfer.listen({
        host: this.lanAddress ?? '127.0.0.1',
        port: this.options.transferPort ?? 7331,
      });
      this.managementUrl = await this.management.listen({
        host: '127.0.0.1',
        port: this.options.managementPort ?? 7332,
      });
      await this.store.save();
      this.liveTimer = setInterval(() => this.sampleLive(), 200);
      this.liveTimer.unref();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async startTunnel(): Promise<void> {
    if (this.lanAddress)
      throw new AppError(409, 'LAN sharing does not use a public tunnel.');
    if (this.options.publicUrl)
      throw new AppError(409, 'This host uses an externally managed tunnel.');
    if (this.closing) throw new AppError(409, 'Host is stopping.');
    await this.tunnel.start(
      this.store.state.provider,
      Number(new URL(this.transferUrl).port),
    );
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.liveTimer);
    this.localLive.close();
    this.guestLive.close();
    for (const stream of this.guestStreams.keys()) stream.destroy();
    const failures: unknown[] = [];
    const finish = async (operation: () => Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    await finish(() => this.tunnel.stop());
    await finish(() => this.uploads.close());
    this.shares.close();
    await finish(() => this.transfer.close());
    await finish(() => this.management.close());
    if (failures.length)
      throw new AggregateError(failures, 'Host shutdown encountered errors.');
  }

  state() {
    return {
      id: this.store.state.id,
      pid: process.pid,
      name: this.store.state.name,
      managementUrl: this.managementUrl,
      shares: this.shares.list(true),
      configuredShares: this.store.state.shares.map((share) => ({
        ...share,
        copied: this.uploads.owns(share.path),
      })),
      whitepad: this.whitepad.get(),
      guestLinks: this.guestLinks.list(),
      guestOrigin: this.guestOrigin(),
      access: this.lanAddress ? 'lan' : 'tunnel',
      tunnel: {
        status: this.lanAddress
          ? 'LAN sharing'
          : this.options.publicUrl
            ? 'Externally managed'
            : this.tunnel.status,
        url: this.lanAddress
          ? this.transferUrl
          : (this.options.publicUrl ?? this.tunnel.url),
        external: Boolean(this.options.publicUrl),
        version: this.tunnel.version,
      },
      warnings: this.shares.warnings().slice(-100),
    };
  }

  private publicRoutes(): void {
    const prefix = this.guestUrl?.pathname.replace(/\/$/, '');
    this.transfer.addHook('onRequest', async (request) => {
      if (
        this.lanAddress &&
        request.headers.host !== new URL(this.transferUrl).host &&
        !(
          this.guestUrl &&
          request.headers.host === this.guestUrl.host &&
          request.url.split('?')[0]!.startsWith(`${prefix}/`)
        )
      )
        throw new AppError(403, 'LAN request Host rejected.');
    });
    this.transfer.get('/v1/health', async () => ({
      protocol: 1,
      id: this.store.state.id,
    }));
    this.transfer.get('/favicon.ico', async (_request, reply) =>
      reply.code(204).send(),
    );
    this.transfer.register(async (server) => this.guestRoutes(server));
    if (prefix)
      this.transfer.register(
        async (server) => this.guestRoutes(server, prefix),
        { prefix },
      );
  }

  private localRoutes(): void {
    this.management.addHook('onRequest', async (request, reply) => {
      const origin = this.managementUrl;
      const host = new URL(origin || 'http://127.0.0.1').host;
      if (
        request.headers.host !== host ||
        (request.headers.origin && request.headers.origin !== origin)
      )
        throw new AppError(403, 'Local management Host/Origin rejected.');
      reply.header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      );
      if (
        [
          '/',
          '/ui.js',
          '/shares/preview-ui.js',
          '/favicon.ico',
          '/api/login',
          '/api/csrf',
        ].includes(request.url.split('?')[0]!)
      )
        return;
      const cookie = this.cookie(request);
      this.localSessions.require(cookie);
      if (
        !['GET', 'HEAD'].includes(request.method) &&
        !sameSecret(
          String(request.headers['x-p2pfs-csrf'] ?? ''),
          digest(`csrf:${cookie}`),
        )
      )
        throw new AppError(403, 'CSRF token required.');
    });
    this.management.get('/', async (_request, reply) =>
      reply.type('text/html').send(page),
    );
    this.management.get('/favicon.ico', async (_request, reply) =>
      reply.code(204).send(),
    );
    this.management.get('/ui.js', async (_request, reply) =>
      reply
        .type('text/javascript')
        .send(
          await readFile(new URL('dashboard/ui.js', browserAssets), 'utf8'),
        ),
    );
    this.management.get('/shares/preview-ui.js', async (_request, reply) =>
      reply
        .type('text/javascript')
        .send(
          await readFile(
            new URL('shares/preview-ui.js', browserAssets),
            'utf8',
          ),
        ),
    );
    this.management.post<{ Body: { password: string } }>(
      '/api/login',
      { schema: { body: passwordBody } },
      async (request, reply) => {
        const token = await this.localSessions.login(request.body.password);
        reply.header(
          'set-cookie',
          `${this.cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
        );
        return { csrf: digest(`csrf:${token}`) };
      },
    );
    this.management.get('/api/csrf', async (request) => {
      const cookie = this.cookie(request);
      return {
        csrf: this.localSessions.valid(cookie)
          ? digest(`csrf:${cookie}`)
          : null,
      };
    });
    this.management.post('/api/logout', async (request, reply) => {
      const cookie = this.cookie(request);
      if (cookie) this.localSessions.logout(cookie);
      reply.header(
        'set-cookie',
        `${this.cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      );
      return { ok: true };
    });
    this.management.get('/api/state', async () => this.state());
    this.management.post<{
      Body: { label: string };
    }>(
      '/api/guest-links',
      {
        schema: {
          body: bodySchema(
            {
              label: { ...text, maxLength: 100 },
            },
            ['label'],
          ),
        },
      },
      async (request) => {
        const origin =
          this.guestUrl?.href.replace(/\/$/, '') ?? this.guestOrigin();
        if (!origin)
          throw new AppError(
            409,
            'Start a public tunnel before creating a guest link.',
          );
        const link = await this.guestLinks.create(
          request.body.label,
          Boolean(this.lanAddress),
        );
        return {
          id: link.id,
          expires: link.expires,
          url: `${origin}/receive#token=${link.token}`,
          joinUrl: this.lanAddress ? `${origin}/receive` : undefined,
          pin: link.pin,
          pinExpires: link.pinExpires,
        };
      },
    );
    this.management.post<{
      Params: { id: string };
      Body: { password: string };
    }>(
      '/api/guest-links/:id/pin',
      {
        schema: {
          params: bodySchema({ id: identifier }, ['id']),
          body: passwordBody,
        },
      },
      async (request) => {
        if (!this.lanAddress)
          throw new AppError(404, 'PIN joining is available only in LAN mode.');
        if (!(await this.localSessions.verify(request.body.password)))
          throw new AppError(403, 'Invalid host password.');
        this.localSessions.require(this.cookie(request));
        return this.guestLinks.revealPin(request.params.id);
      },
    );
    this.management.delete<{ Params: { id: string } }>(
      '/api/guest-links/:id',
      {
        schema: { params: bodySchema({ id: identifier }, ['id']) },
      },
      async (request) => {
        await this.guestLinks.revoke(request.params.id);
        this.guestLive.notify({ catalog: true });
        this.stopInvalidGuestStreams();
        return { ok: true };
      },
    );
    this.management.get('/api/events', async (request, reply) => {
      const cookie = this.cookie(request);
      this.localLive.connect(reply, () => this.localSessions.valid(cookie));
      return reply;
    });
    this.management.get('/api/whitepad', async () => this.whitepad.get());
    this.management.put<{ Body: { content: string; revision: number } }>(
      '/api/whitepad',
      {
        bodyLimit: MAX_WHITEPAD_LENGTH * 6 + 1024,
        schema: {
          body: bodySchema(
            {
              content: { type: 'string', maxLength: MAX_WHITEPAD_LENGTH },
              revision: {
                type: 'integer',
                minimum: 0,
                maximum: Number.MAX_SAFE_INTEGER - 1,
              },
            },
            ['content', 'revision'],
          ),
        },
      },
      async (request) =>
        this.whitepad.update(request.body.content, request.body.revision),
    );
    this.management.get<{
      Querystring: { path?: string; hidden?: boolean };
    }>(
      '/api/filesystem',
      {
        schema: {
          querystring: bodySchema(
            { path: { ...text, maxLength: 4096 }, hidden: { type: 'boolean' } },
            [],
          ),
        },
      },
      async (request) =>
        browseFilesystem(request.query.path, request.query.hidden),
    );
    this.management.post<{ Body: { path: string } }>(
      '/api/shares',
      {
        schema: { body: bodySchema({ path: text }, ['path']) },
      },
      async (request) => ({ id: await this.shares.add(request.body.path) }),
    );
    this.management.addContentTypeParser(
      'application/octet-stream',
      (_request, payload, done) => done(null, payload),
    );
    this.management.post<{ Body: Readable; Querystring: { name: string } }>(
      '/api/uploads',
      {
        bodyLimit: MAX_UPLOAD_BYTES,
        schema: {
          querystring: bodySchema({ name: { ...text, maxLength: 240 } }, [
            'name',
          ]),
        },
      },
      async (request) => {
        if (request.headers['content-type'] !== 'application/octet-stream')
          throw new AppError(415, 'Send a file as application/octet-stream.');
        if (Number(request.headers['content-length']) > MAX_UPLOAD_BYTES)
          throw new AppError(413, 'Dropped files must be 1 GiB or smaller.');
        const cookie = this.cookie(request);
        return {
          id: await this.uploads.add(request.body, request.query.name, () =>
            this.localSessions.require(cookie),
          ),
        };
      },
    );
    for (const format of ['preview', 'image'] as const)
      this.management.get<{ Params: { shareId: string; fileId: string } }>(
        `/api/shares/:shareId/files/:fileId/${format}`,
        {
          schema: {
            params: bodySchema({ shareId: identifier, fileId: identifier }, [
              'shareId',
              'fileId',
            ]),
          },
        },
        async (request, reply) => {
          const preview = await this.previews.create(
            request.params.shareId,
            request.params.fileId,
            format === 'image',
          );
          this.localSessions.require(this.cookie(request));
          return reply
            .type(format === 'image' ? 'image/png' : 'image/webp')
            .send(preview);
        },
      );
    this.management.post<{ Params: { id: string } }>(
      '/api/shares/:id/refresh',
      {
        schema: { params: bodySchema({ id: identifier }, ['id']) },
      },
      async (request) => {
        await this.shares.refresh(request.params.id);
        return { ok: true };
      },
    );
    this.management.delete<{ Params: { id: string } }>(
      '/api/shares/:id',
      {
        schema: { params: bodySchema({ id: identifier }, ['id']) },
      },
      async (request) => {
        await this.shares.remove(request.params.id);
        await this.uploads.cleanup();
        return { ok: true };
      },
    );
    this.management.post(
      '/api/tunnel/start',
      {
        schema: {
          body: bodySchema({}, []),
        },
      },
      async () => {
        await this.startTunnel();
        return { ok: true };
      },
    );
    this.management.post('/api/tunnel/stop', async () => {
      if (this.lanAddress)
        throw new AppError(409, 'LAN sharing does not use a public tunnel.');
      if (this.options.publicUrl)
        throw new AppError(409, 'Stop the external tunnel using its provider.');
      await this.tunnel.stop();
      return { ok: true };
    });
  }

  private guestOrigin(): string | undefined {
    if (this.guestUrl) return this.guestUrl.origin;
    if (this.lanAddress) return this.transferUrl || undefined;
    if (this.tunnel.url) return this.tunnel.url;
    if (this.options.publicUrl)
      return publicUrl(this.options.publicUrl, this.transport.options).origin;
    return this.transport.options.testLoopback
      ? this.transferUrl || undefined
      : undefined;
  }

  private stopInvalidGuestStreams(): void {
    for (const [stream, session] of this.guestStreams)
      if (!this.guestLinks.valid(session))
        stream.destroy(
          new Error('Guest link expired, revoked, or signed out.'),
        );
  }

  private guestRoutes(server: FastifyInstance, prefix = ''): void {
    const external =
      this.guestUrl?.pathname.replace(/\/$/, '') === prefix
        ? this.guestUrl
        : undefined;
    const cookieName = `p2pfs_guest_${this.store.state.id}`;
    const session = (request: FastifyRequest) =>
      this.readCookie(request, cookieName);
    const authorized = (request: FastifyRequest) =>
      this.guestLinks.require(session(request));
    const cookie = (value: string, age: number) =>
      `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=${prefix}/guest; Max-Age=${age}${external?.protocol === 'https:' || (!this.lanAddress && this.guestOrigin()?.startsWith('https:')) ? '; Secure' : ''}`;
    const accept = (
      reply: FastifyReply,
      access: { session: string; expires: number },
    ) => {
      reply.header(
        'set-cookie',
        cookie(
          access.session,
          Math.max(0, Math.floor((access.expires - Date.now()) / 1000)),
        ),
      );
      return { ok: true };
    };
    server.addHook('onRequest', async (request, reply) => {
      const pathname = request.url.split('?')[0]!.slice(prefix.length);
      if (
        pathname !== '/' &&
        pathname !== '/receive' &&
        pathname !== '/receive.js' &&
        !pathname?.startsWith('/guest/')
      )
        return;
      reply.header('referrer-policy', 'no-referrer');
      reply.header('x-robots-tag', 'noindex, nofollow, noarchive');
      reply.header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      if (
        pathname.startsWith('/guest/') &&
        (request.headers['sec-fetch-site'] === 'cross-site' ||
          (request.headers.origin &&
            ![
              external?.origin ??
                (this.lanAddress ? undefined : this.guestOrigin()),
              this.transferUrl,
            ].includes(request.headers.origin)))
      )
        throw new AppError(403, 'Guest request Origin rejected.');
    });
    if (prefix)
      server.get('/', async (_request, reply) =>
        reply.type('text/html').send(guestPage(Boolean(this.lanAddress))),
      );
    server.get('/receive', async (_request, reply) =>
      reply.type('text/html').send(guestPage(Boolean(this.lanAddress))),
    );
    server.get('/receive.js', async (_request, reply) =>
      reply.redirect(`${prefix}/guest/ui.js`),
    );
    server.get('/guest/ui.js', async (_request, reply) =>
      reply
        .type('text/javascript')
        .send(await readFile(new URL('guest/ui.js', browserAssets), 'utf8')),
    );
    server.get('/shares/preview-ui.js', async (_request, reply) =>
      reply
        .type('text/javascript')
        .send(
          await readFile(
            new URL('shares/preview-ui.js', browserAssets),
            'utf8',
          ),
        ),
    );
    server.post<{ Body: { token: string } }>(
      '/guest/session',
      {
        schema: {
          body: bodySchema(
            { token: { type: 'string', pattern: '^[a-zA-Z0-9_-]{43}$' } },
            ['token'],
          ),
        },
      },
      async (request, reply) =>
        accept(reply, this.guestLinks.exchange(request.body.token)),
    );
    server.get('/guest/session', async (request) => ({
      authenticated: Boolean(this.guestLinks.valid(session(request))),
    }));
    if (this.lanAddress)
      server.post<{ Body: { pin: string } }>(
        '/guest/pin',
        {
          schema: {
            body: bodySchema(
              { pin: { type: 'string', pattern: '^[0-9]{4}$' } },
              ['pin'],
            ),
          },
        },
        async (request, reply) =>
          accept(reply, this.guestLinks.exchangePin(request.body.pin)),
      );
    server.post('/guest/logout', async (request, reply) => {
      authorized(request);
      this.guestLinks.logout(session(request));
      reply.header('set-cookie', cookie('', 0));
      this.guestLive.notify({ catalog: true });
      this.stopInvalidGuestStreams();
      return { ok: true };
    });
    server.get('/guest/catalog', async (request) => {
      const link = authorized(request);
      return {
        name: this.store.state.name,
        label: link.label,
        expires: link.expires,
        scope: link.scope ?? 'selected',
        shares: this.shares
          .list()
          .filter(
            (share) =>
              link.scope === 'session' || link.shareIds.includes(share.id),
          ),
        whitepad: link.scope === 'session' ? this.whitepad.get() : null,
      };
    });
    server.get('/guest/events', async (request, reply) => {
      authorized(request);
      const value = session(request);
      this.guestLive.connect(reply, () =>
        Boolean(this.guestLinks.valid(value)),
      );
      return reply;
    });
    server.get('/guest/whitepad', async (request) => {
      const link = authorized(request);
      if (link.scope !== 'session')
        throw new AppError(
          404,
          'The whitepad requires a new session link from the host.',
        );
      return this.whitepad.get();
    });
    server.get<{
      Params: { shareId: string };
      Querystring: { offset?: number };
    }>(
      '/guest/shares/:shareId/files',
      {
        schema: {
          params: bodySchema({ shareId: identifier }, ['shareId']),
          querystring: bodySchema(
            { offset: { type: 'integer', minimum: 0, maximum: 10_000 } },
            [],
          ),
        },
      },
      async (request) => {
        const link = authorized(request);
        if (
          link.scope !== 'session' &&
          !link.shareIds.includes(request.params.shareId)
        )
          throw new AppError(404, 'Share not available through this link.');
        return this.shares.files(request.params.shareId, request.query.offset);
      },
    );
    for (const format of ['preview', 'image'] as const)
      server.get<{ Params: { shareId: string; fileId: string } }>(
        `/guest/shares/:shareId/files/:fileId/${format}`,
        {
          schema: {
            params: bodySchema({ shareId: identifier, fileId: identifier }, [
              'shareId',
              'fileId',
            ]),
          },
        },
        async (request, reply) => {
          const link = authorized(request);
          if (
            link.scope !== 'session' &&
            !link.shareIds.includes(request.params.shareId)
          )
            throw new AppError(404, 'Share not available through this link.');
          const preview = await this.previews.create(
            request.params.shareId,
            request.params.fileId,
            format === 'image',
          );
          authorized(request);
          return reply
            .type(format === 'image' ? 'image/png' : 'image/webp')
            .send(preview);
        },
      );
    server.get<{ Params: { shareId: string; fileId: string } }>(
      '/guest/shares/:shareId/files/:fileId/content',
      {
        schema: {
          params: bodySchema({ shareId: identifier, fileId: identifier }, [
            'shareId',
            'fileId',
          ]),
        },
      },
      async (request, reply) => {
        const link = authorized(request);
        if (
          link.scope !== 'session' &&
          !link.shareIds.includes(request.params.shareId)
        )
          throw new AppError(404, 'Share not available through this link.');
        const { file, stream } = await this.shares.stream(
          request.params.shareId,
          request.params.fileId,
        );
        if (
          !this.guestLinks.valid(session(request)) ||
          this.guestStreams.size >= 64
        ) {
          stream.destroy();
          throw new AppError(
            403,
            'Guest access ended or transfer capacity reached.',
          );
        }
        this.guestStreams.set(stream, session(request)!);
        stream.once('close', () => this.guestStreams.delete(stream));
        reply.raw.once('close', () => stream.destroy());
        const filename = Buffer.from(
          file.name.split(/[/\\]/).at(-1)!,
          'utf8',
        ).toString('utf8');
        const fallback =
          filename.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'download';
        const encoded = encodeURIComponent(filename).replace(
          /['()*]/g,
          (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
        );
        reply.header('content-length', file.size);
        reply.header(
          'content-disposition',
          `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
        );
        return reply.type('application/octet-stream').send(stream);
      },
    );
  }

  private sampleLive(): void {
    if (this.closing) return;
    const catalog = JSON.stringify({
      shares: this.shares.revision,
      whitepad: this.whitepad.get().revision,
    });
    if (catalog !== this.lastLiveCatalog) {
      this.lastLiveCatalog = catalog;
      this.localLive.notify({ catalog: true });
      this.guestLive.notify({ catalog: true });
    }
    const guestLinks = JSON.stringify(
      this.guestLinks
        .list()
        .map(({ id, expires }) => [id, expires > Date.now()]),
    );
    if (guestLinks !== this.lastGuestLinks) {
      this.lastGuestLinks = guestLinks;
      this.guestLive.notify({ catalog: true });
      this.localLive.notify({ state: true });
    }
    this.stopInvalidGuestStreams();
    const snapshot = JSON.stringify(this.state());
    if (snapshot !== this.lastLiveState) {
      this.lastLiveState = snapshot;
      this.localLive.notify({ state: true });
    }
  }

  private cookie(request: FastifyRequest): string | undefined {
    return this.readCookie(request, this.cookieName);
  }

  private readCookie(
    request: FastifyRequest,
    name: string,
  ): string | undefined {
    const prefix = `${name}=`;
    return request.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix))
      ?.slice(prefix.length);
  }
}
