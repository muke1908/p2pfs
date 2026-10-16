import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  symlink,
  readdir,
} from 'node:fs/promises';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { StateStore } from '../src/config/state.js';
import { lanAddress } from '../src/config/network.js';
import { Sessions, passwordHash, secret } from '../src/security/auth.js';
import {
  Transport,
  isPublicAddress,
  publicUrl,
} from '../src/security/transport.js';
import { Host } from '../src/host/app.js';
import { parseEndpoint, Tunnel } from '../src/tunnels/manager.js';
import { browseFilesystem } from '../src/shares/browser.js';
import { Whitepad, MAX_WHITEPAD_LENGTH } from '../src/texts/service.js';
import type { IncomingMessage } from 'node:http';
import {
  GuestLinks,
  GUEST_LINK_LIFETIME,
  GUEST_PIN_LIFETIME,
  GUEST_PIN_COOLDOWN,
} from '../src/guest/access.js';
import { MAX_UPLOAD_BYTES } from '../src/shares/uploads.js';

const password = 'test-password-not-a-secret';
const transport = () => new Transport({ testLoopback: true });

async function fixture(publicUrl?: string) {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'p2pfs-test-')),
  );
  const store = await StateStore.open(path.join(directory, 'state'), password);
  const host = new Host(store, {
    access: 'tunnel',
    transferPort: 0,
    managementPort: 0,
    transport: transport(),
    publicUrl,
  });
  await host.listen();
  return {
    directory,
    store,
    host,
    close: async () => {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const localSessions = new WeakMap<Host, { cookie: string; csrf: string }>();
async function localSession(host: Host) {
  const existing = localSessions.get(host);
  if (existing) return existing;
  const response = await fetch(`${host.managementUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(response.status, 200);
  const { csrf } = await response.json();
  const session = {
    cookie: response.headers.get('set-cookie')!.split(';')[0]!,
    csrf: String(csrf),
  };
  localSessions.set(host, session);
  return session;
}

async function local(
  host: Host,
  route: string,
  method = 'GET',
  body?: unknown,
) {
  const session = await localSession(host);
  return fetch(`${host.managementUrl}${route}`, {
    method,
    headers: {
      cookie: session.cookie,
      'x-p2pfs-csrf': session.csrf,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function until(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 6000;
  while (!check()) {
    assert.ok(Date.now() < deadline, description);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function observeEvents(response: IncomingMessage) {
  const events = {
    data: '',
    ended: false,
    error: undefined as Error | undefined,
  };
  response.setEncoding('utf8');
  response.on('data', (chunk: string) => {
    events.data += chunk;
  });
  response.on('end', () => {
    events.ended = true;
  });
  response.on('error', (error: Error) => {
    events.error = error;
  });
  return events;
}

async function guestCookie(host: Host, token: string) {
  const response = await fetch(`${host.transferUrl}/guest/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  assert.equal(response.status, 200, await response.text());
  const cookie = response.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\/guest;/);
  return cookie.split(';')[0]!;
}

function guestStream(host: Host, cookie: string, route: string) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    http
      .get(`${host.transferUrl}${route}`, { headers: { cookie } }, resolve)
      .once('error', reject);
  });
}

async function upload(host: Host, name: string, contents: string | Buffer) {
  const { cookie, csrf } = await localSession(host);
  return fetch(
    `${host.managementUrl}/api/uploads?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        cookie,
        'x-p2pfs-csrf': csrf,
        'content-type': 'application/octet-stream',
      },
      body: typeof contents === 'string' ? contents : new Uint8Array(contents),
    },
  );
}

test('dropped files are private copies, survive restart and are removed without touching originals', async () => {
  const f = await fixture();
  let restarted: Host | undefined;
  try {
    const original = path.join(f.directory, 'photo.txt');
    await writeFile(original, 'original');
    const responses = await Promise.all([
      upload(f.host, 'photo.txt', 'first copy'),
      upload(f.host, 'photo.txt', 'second copy'),
    ]);
    for (const response of responses)
      assert.equal(response.status, 200, await response.clone().text());
    const state = await (await local(f.host, '/api/state')).json();
    assert.equal(state.configuredShares.length, 2);
    assert.equal(
      state.configuredShares.every(
        (share: { copied: boolean }) => share.copied,
      ),
      true,
    );
    assert.notEqual(
      state.configuredShares[0].path,
      state.configuredShares[1].path,
    );
    const id = state.configuredShares[0].id;
    const copied = state.configuredShares[0].path;
    const link = await f.host.guestLinks.create('Dropped files');
    const cookie = await guestCookie(f.host, link.token);
    const file = f.host.shares.files(id).files[0]!;
    const route = `/guest/shares/${id}/files/${file.id}/content`;
    assert.equal(
      await (
        await fetch(f.host.transferUrl + route, { headers: { cookie } })
      ).text(),
      await readFile(copied, 'utf8'),
    );
    await f.host.close();
    const store = await StateStore.open(
      path.relative(process.cwd(), f.store.directory),
      password,
    );
    restarted = new Host(store, {
      access: 'tunnel',
      transferPort: 0,
      managementPort: 0,
      transport: transport(),
    });
    await restarted.listen();
    assert.equal(restarted.shares.list().length, 2);
    assert.equal(
      (await local(restarted, `/api/shares/${id}`, 'DELETE')).status,
      200,
    );
    await assert.rejects(readFile(copied), { code: 'ENOENT' });
    assert.equal(await readFile(original, 'utf8'), 'original');
    assert.equal(
      (await readdir(path.join(store.directory, 'uploads'))).length,
      1,
    );
  } finally {
    await restarted?.close();
    await f.close();
  }
});

test('file drops enforce local auth, CSRF, filename boundaries and size limits', async () => {
  const f = await fixture();
  try {
    const route = '/api/uploads?name=file.txt';
    const headers = { 'content-type': 'application/octet-stream' };
    assert.equal(
      (
        await fetch(f.host.managementUrl + route, {
          method: 'POST',
          headers,
          body: 'test',
        })
      ).status,
      401,
    );
    const session = await localSession(f.host);
    assert.equal(
      (
        await fetch(f.host.managementUrl + route, {
          method: 'POST',
          headers: { ...headers, cookie: session.cookie },
          body: 'test',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(f.host.transferUrl + route, {
          method: 'POST',
          headers,
          body: 'test',
        })
      ).status,
      404,
    );
    for (const name of [
      '../escape',
      'dir/file',
      'dir\\file',
      '.',
      '..',
      'bad\u0000name',
    ]) {
      const response = await upload(f.host, name, 'test');
      assert.equal(response.status, 400, `${name}: ${await response.text()}`);
    }
    const tooLarge = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        f.host.managementUrl + route,
        {
          method: 'POST',
          headers: {
            ...headers,
            cookie: session.cookie,
            'x-p2pfs-csrf': session.csrf,
            'content-length': MAX_UPLOAD_BYTES + 1,
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      request.on('error', reject);
      request.end();
    });
    assert.equal(tooLarge, 413);
    const empty = await upload(f.host, 'empty.txt', '');
    assert.equal(empty.status, 200);
    assert.equal(f.host.shares.list()[0]!.file!.size, 0);
  } finally {
    await f.close();
  }
});

test('interrupted and failed drops are cleaned up, including leftovers after a crash', async () => {
  const f = await fixture();
  let restarted: Host | undefined;
  try {
    const session = await localSession(f.host);
    const root = path.join(f.store.directory, 'uploads');
    const request = http.request(
      `${f.host.managementUrl}/api/uploads?name=unfinished.txt`,
      {
        method: 'POST',
        headers: {
          cookie: session.cookie,
          'x-p2pfs-csrf': session.csrf,
          'content-type': 'application/octet-stream',
        },
      },
    );
    request.on('error', () => {});
    request.write('partial bytes');
    let sawPartial = false;
    for (let i = 0; i < 100 && !sawPartial; i++) {
      sawPartial = (await readdir(root)).length > 0;
      if (!sawPartial) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(sawPartial, true);
    request.destroy();
    let clean = false;
    for (let i = 0; i < 100 && !clean; i++) {
      clean = (await readdir(root)).length === 0;
      if (!clean) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(clean, true);
    const save = f.store.save.bind(f.store);
    f.store.save = async () => {
      throw new Error('Synthetic disk failure');
    };
    assert.equal(
      (await upload(f.host, 'failed.txt', 'not committed')).status,
      500,
    );
    f.store.save = save;
    assert.equal(f.store.state.shares.length, 0);
    assert.deepEqual(await readdir(root), []);
    const orphan = path.join(root, randomUUID());
    await mkdir(orphan);
    await writeFile(path.join(orphan, 'leftover'), 'partial');
    const unrelated = path.join(root, 'keep-me.txt');
    await writeFile(unrelated, 'not an app upload');
    await f.host.close();
    restarted = new Host(await StateStore.open(f.store.directory, password), {
      access: 'tunnel',
      transferPort: 0,
      managementPort: 0,
      transport: transport(),
    });
    await restarted.listen();
    await assert.rejects(readdir(orphan), { code: 'ENOENT' });
    assert.equal(await readFile(unrelated, 'utf8'), 'not an app upload');
  } finally {
    await restarted?.close();
    await f.close();
  }
});

test('small image previews use existing access boundaries and leave original downloads intact', async () => {
  const f = await fixture();
  try {
    const original = await sharp({
      create: { width: 640, height: 320, channels: 3, background: '#2d6756' },
    })
      .withMetadata()
      .png()
      .toBuffer();
    const created = await upload(f.host, 'picture.png', original);
    assert.equal(created.status, 200);
    const { id } = await created.json();
    const file = f.host.shares.files(id).files[0]!;
    assert.equal(file.preview, true);
    const localRoute = `/api/shares/${id}/files/${file.id}/preview`;
    const guestRoute = `/guest/shares/${id}/files/${file.id}/preview`;
    assert.equal((await fetch(f.host.managementUrl + localRoute)).status, 401);
    assert.equal((await fetch(f.host.transferUrl + guestRoute)).status, 401);
    const link = await f.host.guestLinks.create('Images');
    const cookie = await guestCookie(f.host, link.token);
    const previews = await Promise.all([
      local(f.host, localRoute),
      ...Array.from({ length: 4 }, () =>
        fetch(f.host.transferUrl + guestRoute, { headers: { cookie } }),
      ),
    ]);
    for (const response of previews) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/webp');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(bytes.length < original.length);
      const metadata = await sharp(bytes).metadata();
      assert.equal(metadata.width, 128);
      assert.equal(metadata.height, 64);
      assert.equal(metadata.exif, undefined);
    }
    const localImage = localRoute.replace('/preview', '/image');
    const guestImage = guestRoute.replace('/preview', '/image');
    assert.equal((await fetch(f.host.managementUrl + localImage)).status, 401);
    assert.equal((await fetch(f.host.transferUrl + guestImage)).status, 401);
    for (const response of await Promise.all([
      local(f.host, localImage),
      fetch(f.host.transferUrl + guestImage, { headers: { cookie } }),
    ])) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(
        response.headers.get('content-disposition') ?? '',
        /attachment/,
      );
      const metadata = await sharp(
        Buffer.from(await response.arrayBuffer()),
      ).metadata();
      assert.equal(metadata.width, 640);
      assert.equal(metadata.height, 320);
      assert.equal(metadata.exif, undefined);
    }
    const download = await fetch(
      f.host.transferUrl + guestRoute.replace('/preview', '/content'),
      { headers: { cookie } },
    );
    assert.match(download.headers.get('content-disposition')!, /attachment;/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);
    const stored = f.store.state.guestLinks!.find(
      (entry) => entry.id === link.id,
    )!;
    stored.scope = 'selected';
    stored.shareIds = [];
    assert.equal(
      (await fetch(f.host.transferUrl + guestImage, { headers: { cookie } }))
        .status,
      404,
    );
    assert.equal(
      (await fetch(f.host.transferUrl + guestRoute, { headers: { cookie } }))
        .status,
      404,
    );
    stored.scope = 'session';
    await f.host.guestLinks.revoke(link.id);
    assert.equal(
      (await fetch(f.host.transferUrl + guestImage, { headers: { cookie } }))
        .status,
      401,
    );
    assert.equal(
      (await fetch(f.host.transferUrl + guestRoute, { headers: { cookie } }))
        .status,
      401,
    );
    await f.host.shares.remove(id);
    assert.equal((await local(f.host, localImage)).status, 404);
    assert.equal((await local(f.host, localRoute)).status, 404);
  } finally {
    await f.close();
  }
});

test('folder images get previews while unsupported, corrupt and disguised images remain downloadable', async () => {
  const f = await fixture();
  try {
    const folder = path.join(f.directory, 'images');
    await mkdir(folder);
    await writeFile(
      path.join(folder, 'small.jpg'),
      await sharp({
        create: { width: 20, height: 10, channels: 3, background: '#ffffff' },
      })
        .jpeg()
        .toBuffer(),
    );
    await writeFile(path.join(folder, 'broken.png'), 'not an image');
    await writeFile(
      path.join(folder, 'disguised.png'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    );
    await writeFile(path.join(folder, 'text.txt'), 'plain text');
    const id = await f.host.shares.add(folder);
    const files = f.host.shares.files(id).files;
    for (const file of files) {
      const fullSize = await local(
        f.host,
        `/api/shares/${id}/files/${file.id}/image`,
      );
      assert.equal(fullSize.status, file.name === 'small.jpg' ? 200 : 415);
      const response = await local(
        f.host,
        `/api/shares/${id}/files/${file.id}/preview`,
      );
      assert.equal(response.status, file.name === 'small.jpg' ? 200 : 415);
      if (file.name === 'text.txt') assert.equal(file.preview, undefined);
      if (file.name === 'small.jpg') {
        assert.equal(
          (await sharp(Buffer.from(await response.arrayBuffer())).metadata())
            .width,
          20,
        );
      }
    }
  } finally {
    await f.close();
  }
});

test('catalogs distinguish standalone files from one-file folders and support direct downloads', async () => {
  const a = await fixture();
  try {
    const source = path.join(a.directory, 'standalone.txt');
    const folder = path.join(a.directory, 'one-file-folder');
    await writeFile(source, 'Direct file bytes.\n');
    await mkdir(folder);
    await writeFile(path.join(folder, 'inside.txt'), 'Folder file bytes.\n');
    const fileId = await a.host.shares.add(source);
    const folderId = await a.host.shares.add(folder);
    const link = await a.host.guestLinks.create('Files and folders');
    const cookie = await guestCookie(a.host, link.token);
    const guestCatalog = async () =>
      (
        await fetch(`${a.host.transferUrl}/guest/catalog`, {
          headers: { cookie },
        })
      ).json();
    const expected = a.host.shares.list();
    assert.equal(expected[0]?.kind, 'file');
    assert.equal(expected[0]?.count, 1);
    assert.deepEqual(expected[0]?.file, a.host.shares.files(fileId).files[0]);
    assert.equal(expected[1]?.kind, 'directory');
    assert.equal(expected[1]?.count, 1);
    assert.equal('file' in expected[1]!, false);
    assert.equal(JSON.stringify(expected).includes(a.directory), false);
    const guest = await guestCatalog();
    assert.deepEqual(guest.shares, expected);
    const state = await (await local(a.host, '/api/state')).json();
    assert.equal(state.shares[0].kind, 'file');
    assert.equal(state.shares[1].kind, 'directory');
    const file = expected[0]!.file!;
    const content = await fetch(
      `${a.host.transferUrl}/guest/shares/${fileId}/files/${file.id}/content`,
      { headers: { cookie } },
    );
    assert.equal(content.status, 200);
    assert.match(content.headers.get('content-disposition')!, /attachment;/);
    assert.equal(await content.text(), 'Direct file bytes.\n');
    await writeFile(source, 'Changed standalone file bytes.\n');
    await until(
      () => a.host.shares.list()[0]?.file?.id !== file.id,
      'Standalone download metadata did not update',
    );
    const updated = await guestCatalog();
    assert.equal(updated.shares[0].file.size, 31);
    const changed = await fetch(
      `${a.host.transferUrl}/guest/shares/${fileId}/files/${updated.shares[0].file.id}/content`,
      { headers: { cookie } },
    );
    assert.equal(await changed.text(), 'Changed standalone file bytes.\n');
    await rm(folder, { recursive: true });
    await writeFile(folder, 'Now a standalone file.');
    await until(
      () =>
        a.host.shares.list().find((share) => share.id === folderId)?.kind ===
        'file',
      'A replaced folder retained its old kind',
    );
    assert.equal(
      (await guestCatalog()).shares.find(
        (share: { id: string }) => share.id === folderId,
      ).file.name,
      'one-file-folder',
    );
  } finally {
    await a.close();
  }
});

test('browser session links expose shared files and plain text without management access', async () => {
  const f = await fixture();
  try {
    const filename = path.join(f.directory, 'report-✓.txt');
    await writeFile(filename, 'A browser-only download.\n');
    const shareId = await f.host.shares.add(filename);
    const otherFile = path.join(f.directory, 'another-share.txt');
    await writeFile(otherFile, 'Also available in this session.');
    const otherId = await f.host.shares.add(otherFile);
    await f.host.whitepad.update('<script>notExecuted()</script>\nHello ✓', 0);
    assert.equal(
      (
        await local(f.host, '/api/guest-links', 'POST', {
          label: '   ',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await local(f.host, '/api/guest-links', 'POST', {
          label: 'Unknown',
          shareIds: ['unknown'],
          textIds: [],
        })
      ).status,
      400,
    );
    const created = await local(f.host, '/api/guest-links', 'POST', {
      label: 'Session delivery',
    });
    assert.equal(created.status, 200);
    const link: { id: string; url: string; expires: number } =
      await created.json();
    const url = new URL(link.url);
    assert.equal(url.pathname, '/receive');
    assert.equal(url.search, '');
    const token = new URLSearchParams(url.hash.slice(1)).get('token')!;
    assert.match(token, /^[\w-]{43}$/);
    const persisted = await readFile(
      path.join(f.store.directory, 'state.json'),
      'utf8',
    );
    assert.equal(persisted.includes(token), false);
    assert.equal(JSON.stringify(f.host.state()).includes('tokenHash'), false);
    const page = await fetch(`${f.host.transferUrl}/receive`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(
      page.headers.get('content-security-policy')!,
      /frame-ancestors 'none'/,
    );
    assert.equal((await page.text()).includes('Another session note'), false);
    assert.equal((await fetch(`${f.host.transferUrl}/receive.js`)).status, 200);
    assert.equal(
      (await fetch(`${f.host.transferUrl}/guest/catalog?token=${token}`))
        .status,
      401,
    );
    const cookie = await guestCookie(f.host, token);
    const headers = { cookie };
    const catalog = await (
      await fetch(`${f.host.transferUrl}/guest/catalog`, { headers })
    ).json();
    assert.deepEqual(
      catalog.shares.map((share: { id: string }) => share.id),
      [shareId, otherId],
    );
    assert.equal(
      catalog.whitepad.content,
      '<script>notExecuted()</script>\nHello ✓',
    );
    assert.equal(catalog.scope, 'session');
    assert.equal(JSON.stringify(catalog).includes(f.directory), false);
    assert.equal(
      (
        await fetch(`${f.host.transferUrl}/guest/whitepad`, {
          headers,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${f.host.transferUrl}/guest/shares/${otherId}/files`, {
          headers,
        })
      ).status,
      200,
    );
    const snippet = await (
      await fetch(`${f.host.transferUrl}/guest/whitepad`, { headers })
    ).json();
    assert.equal(snippet.content, '<script>notExecuted()</script>\nHello ✓');
    const files = f.host.shares.files(shareId).files;
    const content = await fetch(
      `${f.host.transferUrl}/guest/shares/${shareId}/files/${files[0]!.id}/content`,
      { headers },
    );
    assert.equal(content.status, 200);
    assert.match(
      content.headers.get('content-disposition')!,
      /attachment; filename="report-_.txt"; filename\*=UTF-8''report-%E2%9C%93.txt/,
    );
    assert.match(
      content.headers.get('content-type')!,
      /application\/octet-stream/,
    );
    assert.equal(content.headers.get('cache-control'), 'no-store');
    assert.equal(await content.text(), 'A browser-only download.\n');
    for (const route of [
      '/api/state',
      '/v1/shares',
      '/v1/texts',
      '/v1/events',
      '/v1/registry/peers',
    ])
      assert.equal(
        (await fetch(`${f.host.transferUrl}${route}`, { headers })).status,
        404,
        route,
      );
    assert.equal(
      (await fetch(`${f.host.managementUrl}/api/state`, { headers })).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${f.host.transferUrl}/guest/catalog`, {
          headers: { ...headers, origin: 'https://evil.test' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${f.host.transferUrl}/guest/session`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://evil.test',
          },
          body: JSON.stringify({ token }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${f.host.transferUrl}/guest/whitepad`, {
          method: 'PUT',
          headers,
        })
      ).status,
      404,
    );
    await f.host.guestLinks.revoke(link.id);
    assert.equal(
      (await fetch(`${f.host.transferUrl}/guest/catalog`, { headers })).status,
      401,
    );
  } finally {
    await f.close();
  }
});

test('guest links use the configured HTTPS origin and Secure cookies behind an external tunnel', async () => {
  const f = await fixture('https://guest.example.org');
  try {
    const response = await local(f.host, '/api/guest-links', 'POST', {
      label: 'HTTPS delivery',
    });
    assert.equal(response.status, 200);
    const invitation = await response.json();
    const { url } = invitation;
    assert.equal(invitation.pin, undefined);
    assert.equal(invitation.joinUrl, undefined);
    assert.equal(
      (
        await fetch(`${f.host.transferUrl}/guest/pin`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pin: '1234' }),
        })
      ).status,
      404,
    );
    const page = await (await fetch(`${f.host.transferUrl}/receive`)).text();
    assert.match(page, /id="pin-form" hidden/);
    assert.equal(new URL(url).origin, 'https://guest.example.org');
    const token = new URLSearchParams(new URL(url).hash.slice(1)).get('token');
    const session = await fetch(`${f.host.transferUrl}/guest/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://guest.example.org',
      },
      body: JSON.stringify({ token }),
    });
    assert.equal(session.status, 200);
    assert.match(session.headers.get('set-cookie')!, /; Secure$/);
    assert.equal((await session.json()).ok, true);
  } finally {
    await f.close();
  }
});

test('LAN guest proxy URLs preserve PIN access, path-scoped sessions and native links without exposing management', async (t) => {
  const address = '192.168.50.25';
  t.mock.method(os, 'networkInterfaces', () => ({
    ethernet: [
      {
        address,
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: '00:11:22:33:44:55',
        internal: false,
        cidr: `${address}/24`,
      },
    ],
  }));
  const f = await fixture();
  let host: Host | undefined;
  try {
    await f.host.close();
    const prefix = '/apps/p2pfs';
    const origin = 'http://mukecz.home.arpa';
    await writeFile(
      path.join(f.store.directory, 'host.json'),
      JSON.stringify({ guestUrl: `${origin}${prefix}/` }),
    );
    const store = await StateStore.open(f.store.directory, password);
    assert.equal(store.guestUrl, `${origin}${prefix}`);
    host = new Host(store);
    host.transferUrl = `http://${address}:7331`;
    host.managementUrl = 'http://127.0.0.1:7332';
    const guest = (route: string, cookie?: string) =>
      host!.transfer.inject({
        url: `${prefix}${route}`,
        headers: {
          host: 'mukecz.home.arpa',
          origin,
          ...(cookie ? { cookie } : {}),
        },
      });
    const filename = path.join(f.directory, 'proxy-photo.png');
    const image = await sharp({
      create: { width: 2, height: 2, channels: 3, background: 'blue' },
    })
      .png()
      .toBuffer();
    await writeFile(filename, image);
    const share = await host.shares.add(filename);
    await host.whitepad.update('Guest proxy text', 0);
    const login = await host.management.inject({
      method: 'POST',
      url: '/api/login',
      headers: { host: '127.0.0.1:7332' },
      payload: { password },
    });
    assert.equal(login.statusCode, 200);
    const invitation = await host.management.inject({
      method: 'POST',
      url: '/api/guest-links',
      headers: {
        host: '127.0.0.1:7332',
        cookie: String(login.headers['set-cookie']).split(';')[0],
        'x-p2pfs-csrf': login.json().csrf,
      },
      payload: { label: 'Proxy session' },
    });
    assert.equal(invitation.statusCode, 200, invitation.body);
    const link = invitation.json();
    assert.equal(link.joinUrl, `${origin}${prefix}/receive`);
    assert.ok(link.url.startsWith(`${link.joinUrl}#token=`));
    for (const route of [
      '/',
      '/receive',
      '/guest/ui.js',
      '/shares/preview-ui.js',
    ])
      assert.equal((await guest(route)).statusCode, 200, route);
    assert.match((await guest('/')).body, /src="\.\/guest\/ui.js"/);
    assert.equal(
      (await guest('/receive.js')).headers.location,
      `${prefix}/guest/ui.js`,
    );
    assert.equal((await guest('/guest/catalog')).statusCode, 401);
    const joined = await host.transfer.inject({
      method: 'POST',
      url: `${prefix}/guest/pin`,
      headers: { host: 'mukecz.home.arpa', origin },
      payload: { pin: link.pin },
    });
    assert.equal(joined.statusCode, 200, joined.body);
    const setCookie = String(joined.headers['set-cookie']);
    assert.match(
      setCookie,
      /HttpOnly; SameSite=Strict; Path=\/apps\/p2pfs\/guest;/,
    );
    assert.equal(setCookie.includes('Secure'), false);
    const cookie = setCookie.split(';')[0]!;
    assert.equal(
      (await guest('/guest/catalog', cookie)).json().whitepad.content,
      'Guest proxy text',
    );
    const file = host.shares.files(share).files[0]!;
    const content = await guest(
      `/guest/shares/${share}/files/${file.id}/content`,
      cookie,
    );
    assert.equal(content.statusCode, 200);
    assert.deepEqual(content.rawPayload, image);
    assert.equal(
      (await guest(`/guest/shares/${share}/files/${file.id}/preview`, cookie))
        .headers['content-type'],
      'image/webp',
    );
    for (const route of ['/api/state', '/api/login', '/guest/whitepad/unknown'])
      assert.equal((await guest(route, cookie)).statusCode, 404, route);
    for (const headers of [
      { host: 'evil.test', origin },
      { host: 'mukecz.home.arpa', origin: 'http://evil.test' },
      { host: 'mukecz.home.arpa', origin, 'sec-fetch-site': 'cross-site' },
    ])
      assert.equal(
        (
          await host.transfer.inject({
            method: 'POST',
            url: `${prefix}/guest/session`,
            headers,
            payload: {
              token: new URLSearchParams(new URL(link.url).hash.slice(1)).get(
                'token',
              ),
            },
          })
        ).statusCode,
        403,
      );
    assert.equal(
      (
        await host.transfer.inject({
          url: '/receive',
          headers: { host: 'mukecz.home.arpa' },
        })
      ).statusCode,
      403,
    );
    const nativeSession = await host.transfer.inject({
      method: 'POST',
      url: '/guest/session',
      headers: { host: `${address}:7331`, origin: host.transferUrl },
      payload: {
        token: new URLSearchParams(new URL(link.url).hash.slice(1)).get(
          'token',
        ),
      },
    });
    assert.equal(nativeSession.statusCode, 200);
    assert.match(String(nativeSession.headers['set-cookie']), /Path=\/guest;/);
    assert.equal(
      (
        await host.management.inject({
          url: '/api/state',
          headers: { host: 'mukecz.home.arpa', origin, cookie },
        })
      ).statusCode,
      403,
    );
    await host.guestLinks.revoke(link.id);
    assert.equal((await guest('/guest/catalog', cookie)).statusCode, 401);
  } finally {
    await host?.close();
    await f.close();
  }
});

test('guest links persist only hashes, enforce expiry and roll back failed creation or revocation', async (t) => {
  const f = await fixture();
  try {
    const link = await f.host.guestLinks.create('Original');
    const restoredStore = await StateStore.open(f.store.directory, password);
    const restored = new GuestLinks(restoredStore);
    const { session } = restored.exchange(link.token);
    assert.equal(restored.require(session).id, link.id);
    assert.equal(restored.require(session).scope, 'session');
    assert.throws(
      () => restored.exchange(secret()),
      /invalid, expired, or revoked/,
    );
    const save = restoredStore.save.bind(restoredStore);
    restoredStore.save = async () => {
      throw new Error('Synthetic guest state write failure');
    };
    await assert.rejects(restored.create('Failed'), /write failure/);
    assert.equal(restored.list().length, 1);
    await assert.rejects(restored.revoke(link.id), /write failure/);
    assert.equal(restored.require(session).id, link.id);
    restoredStore.save = save;
    await restored.revoke(link.id);
    assert.throws(() => restored.require(session), /Guest access ended/);
    assert.throws(
      () => restored.exchange(link.token),
      /invalid, expired, or revoked/,
    );
    const expired = new GuestLinks(
      await StateStore.open(f.store.directory, password),
    );
    assert.deepEqual(expired.list(), []);
    const active = await expired.create('Expires');
    const entry = expired.exchange(active.token);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.tick(GUEST_LINK_LIFETIME + 1);
    assert.equal(expired.valid(entry.session), undefined);
    assert.throws(
      () => expired.exchange(active.token),
      /invalid, expired, or revoked/,
    );
    t.mock.timers.reset();
  } finally {
    await f.close();
  }
});

test('guest link creation serializes concurrent capacity checks and throttles invalid exchanges', async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 51 }, (_, index) =>
        f.host.guestLinks.create(`Link ${index}`),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      50,
    );
    assert.equal(
      results.filter((result) => result.status === 'rejected').length,
      1,
    );
    assert.equal(f.host.guestLinks.list().length, 50);
    for (let attempt = 0; attempt < 200; attempt++)
      assert.throws(
        () => f.host.guestLinks.exchange(secret()),
        /invalid, expired, or revoked/,
      );
    assert.throws(
      () => f.host.guestLinks.exchange(secret()),
      /capacity reached/,
    );
  } finally {
    await f.close();
  }
});

test('LAN PINs are single-use, expire and rotate without shortening joined guest access', async (t) => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const links = f.host.guestLinks;
    const first = await links.create('First PIN', true);
    assert.match(first.pin!, /^[0-9]{4}$/);
    assert.deepEqual(links.revealPin(first.id), {
      pin: first.pin,
      expires: first.pinExpires,
    });
    assert.equal(
      links.list().find((link) => link.id === first.id)?.pinExpires,
      first.pinExpires,
    );
    assert.ok(
      links.list().every((link) => !('pin' in link) && !('code' in link)),
    );
    const replacement = await links.create('Replacement PIN', true);
    assert.notEqual(replacement.pin, first.pin);
    assert.throws(() => links.revealPin(first.id), /No unused/);
    assert.throws(() => links.exchangePin(first.pin!), /incorrect, expired/);
    const access = links.exchangePin(replacement.pin!);
    assert.throws(() => links.revealPin(replacement.id), /No unused/);
    assert.equal(access.expires, replacement.expires);
    assert.equal(links.require(access.session).id, replacement.id);
    assert.throws(() => links.exchangePin(replacement.pin!), /already used/);
    const expires = await links.create('Expires unused', true);
    t.mock.timers.tick(GUEST_PIN_LIFETIME);
    assert.throws(() => links.revealPin(expires.id), /No unused/);
    assert.ok(links.list().every((link) => link.pinExpires === undefined));
    assert.throws(() => links.exchangePin(expires.pin!), /expired/);
    assert.equal(links.require(access.session).id, replacement.id);
    const revoked = await links.create('Revoked before use', true);
    await links.revoke(revoked.id);
    assert.throws(() => links.revealPin(revoked.id), /No unused/);
    assert.throws(() => links.exchangePin(revoked.pin!), /revoked|incorrect/);
    await links.revoke(replacement.id);
    assert.equal(links.valid(access.session), undefined);
    const restart = await links.create('Before restart', true);
    const reopened = new GuestLinks(
      await StateStore.open(f.store.directory, password),
    );
    assert.throws(() => reopened.revealPin(restart.id), /No unused/);
    assert.throws(() => reopened.exchangePin(restart.pin!), /incorrect/);
    assert.equal(
      reopened.require(reopened.exchange(restart.token).session).id,
      restart.id,
    );
    const stored = JSON.parse(
      await readFile(path.join(f.store.directory, 'state.json'), 'utf8'),
    );
    assert.ok(
      stored.guestLinks.every(
        (link: Record<string, unknown>) =>
          !('pin' in link) && !('pinHash' in link) && !('pinExpires' in link),
      ),
    );
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test('PIN reveal requires a local session, CSRF and host password and is unavailable in tunnel mode', async (t) => {
  const f = await fixture();
  let lan: Host | undefined;
  try {
    t.mock.method(os, 'networkInterfaces', () => ({
      ethernet: [
        {
          address: '192.168.50.25',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:11:22:33:44:55',
          internal: false,
          cidr: '192.168.50.25/24',
        },
      ],
    }));
    lan = new Host(f.store, { access: 'lan' });
    const host = lan;
    const invitation = await host.guestLinks.create('Reveal', true);
    const url = `/api/guest-links/${invitation.id}/pin`;
    const headers: Record<string, string> = { host: '127.0.0.1' };
    const send = (body = { password }) =>
      host.management.inject({
        method: 'POST',
        url,
        headers,
        payload: body,
      });
    assert.equal((await send()).statusCode, 401);
    const login = await host.management.inject({
      method: 'POST',
      url: '/api/login',
      headers,
      payload: { password },
    });
    assert.equal(login.statusCode, 200);
    headers.cookie = String(login.headers['set-cookie']).split(';')[0]!;
    assert.equal((await send()).statusCode, 403);
    headers['x-p2pfs-csrf'] = login.json<{ csrf: string }>().csrf;
    assert.equal((await send({ password: 'wrong-password' })).statusCode, 403);
    const revealed = await send();
    assert.equal(revealed.statusCode, 200);
    assert.deepEqual(revealed.json(), {
      pin: invitation.pin,
      expires: invitation.pinExpires,
    });
    assert.equal(revealed.headers['cache-control'], 'no-store');
    assert.equal((await send()).statusCode, 200);
    const snapshot = await host.management.inject({
      url: '/api/state',
      headers,
    });
    assert.ok(!snapshot.body.includes(`"pin":"${invitation.pin}"`));
    host.guestLinks.exchangePin(invitation.pin!);
    assert.equal((await send()).statusCode, 404);
    assert.equal((await local(f.host, url, 'POST', { password })).status, 404);
    assert.equal(
      (
        await fetch(f.host.transferUrl + url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password }),
        })
      ).status,
      404,
    );
  } finally {
    await lan?.close();
    await f.close();
  }
});

test('PIN guessing limits are host-wide, cancel the code and cannot be reset by issuing another', async (t) => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const links = f.host.guestLinks;
    let invitation = await links.create('Initial PIN', true);
    const wrongPin = () =>
      String((Number(invitation.pin) + 1) % 10_000).padStart(4, '0');
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt === 2) invitation = await links.create('Rotated PIN', true);
      assert.throws(() => links.exchangePin(wrongPin()), /incorrect/);
    }
    assert.throws(() => links.exchangePin(wrongPin()), /temporarily locked/);
    assert.throws(
      () => links.exchangePin(invitation.pin!),
      /temporarily locked/,
    );
    const count = links.list().length;
    await assert.rejects(
      links.create('Cannot reset cooldown', true),
      /temporarily locked/,
    );
    assert.equal(links.list().length, count);
    const tokenAccess = links.exchange(invitation.token);
    assert.equal(links.require(tokenAccess.session).id, invitation.id);
    t.mock.timers.tick(GUEST_PIN_COOLDOWN - 1);
    assert.throws(
      () => links.exchangePin(invitation.pin!),
      /temporarily locked/,
    );
    t.mock.timers.tick(1);
    assert.throws(() => links.exchangePin(invitation.pin!), /incorrect/);
    const fresh = await links.create('After cooldown', true);
    assert.equal(
      links.require(links.exchangePin(fresh.pin!).session).id,
      fresh.id,
    );
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test('failed PIN creation or revocation preserves the previous invitation', async (t) => {
  const f = await fixture();
  try {
    const links = f.host.guestLinks;
    const original = await links.create('Working PIN', true);
    const save = t.mock.method(f.store, 'save', async () => {
      throw new Error('Synthetic PIN persistence failure');
    });
    await assert.rejects(
      links.create('Failed PIN', true),
      /persistence failure/,
    );
    await assert.rejects(links.revoke(original.id), /persistence failure/);
    assert.equal(links.list().length, 1);
    save.mock.restore();
    assert.equal(
      links.require(links.exchangePin(original.pin!).session).id,
      original.id,
    );
  } finally {
    await f.close();
  }
});

test('empty session links receive future shares, folder files and text live until revoked', async () => {
  const f = await fixture();
  let stream: IncomingMessage | undefined;
  try {
    const response = await local(f.host, '/api/guest-links', 'POST', {
      label: 'Live session',
    });
    assert.equal(response.status, 200);
    const link: { id: string; url: string } = await response.json();
    const token = new URLSearchParams(new URL(link.url).hash.slice(1)).get(
      'token',
    )!;
    const cookie = await guestCookie(f.host, token);
    const headers = { cookie };
    const initial = await (
      await fetch(`${f.host.transferUrl}/guest/catalog`, { headers })
    ).json();
    assert.deepEqual(initial.shares, []);
    assert.equal(initial.whitepad.content, '');
    assert.equal(initial.scope, 'session');
    stream = await guestStream(f.host, cookie, '/guest/events');
    assert.equal(stream.statusCode, 200);
    const events = observeEvents(stream);
    await until(
      () => events.data.includes('"catalog":true'),
      'Guest initial live event missing',
    );
    events.data = '';
    const folder = path.join(f.directory, 'session-folder');
    await mkdir(folder);
    await writeFile(path.join(folder, 'first.txt'), 'First\n');
    const shareId = await f.host.shares.add(folder);
    await f.host.whitepad.update('Text', 0);
    await until(
      () => events.data.includes('"catalog":true'),
      'New session share/text live event missing',
    );
    events.data = '';
    await writeFile(path.join(folder, 'new.txt'), 'New file\n');
    await until(
      () => f.host.shares.files(shareId).files.length === 2,
      'Guest folder did not re-index',
    );
    await until(
      () => events.data.includes('"catalog":true'),
      'Guest live change missing',
    );
    const files = await (
      await fetch(`${f.host.transferUrl}/guest/shares/${shareId}/files`, {
        headers,
      })
    ).json();
    assert.deepEqual(
      files.files.map((file: { name: string }) => file.name).sort(),
      ['first.txt', 'new.txt'],
    );
    const laterFile = path.join(f.directory, 'later-share.txt');
    await writeFile(laterFile, 'Shared after creating the session link.\n');
    const laterShareId = await f.host.shares.add(laterFile);
    await f.host.whitepad.update('Visible through the same link', 1);
    const catalog = await (
      await fetch(`${f.host.transferUrl}/guest/catalog`, { headers })
    ).json();
    assert.deepEqual(
      catalog.shares.map((share: { id: string }) => share.id),
      [shareId, laterShareId],
    );
    assert.equal(catalog.whitepad.content, 'Visible through the same link');
    assert.equal(
      (
        await fetch(`${f.host.transferUrl}/guest/whitepad`, {
          headers,
        })
      ).status,
      200,
    );
    const laterFileId = f.host.shares.files(laterShareId).files[0]!.id;
    const download = await fetch(
      `${f.host.transferUrl}/guest/shares/${laterShareId}/files/${laterFileId}/content`,
      { headers },
    );
    assert.equal(
      await download.text(),
      'Shared after creating the session link.\n',
    );
    events.data = '';
    await f.host.whitepad.update('', 2);
    await until(
      () => events.data.includes('"catalog":true'),
      'Whitepad clear was not pushed',
    );
    assert.equal(
      (
        await (
          await fetch(`${f.host.transferUrl}/guest/whitepad`, { headers })
        ).json()
      ).content,
      '',
    );
    assert.equal(
      (await local(f.host, `/api/guest-links/${link.id}`, 'DELETE')).status,
      200,
    );
    await until(
      () => events.ended,
      'Revoked guest live connection remained open',
    );
    assert.equal(
      (await fetch(`${f.host.transferUrl}/guest/catalog`, { headers })).status,
      401,
    );
  } finally {
    stream?.destroy();
    await f.close();
  }
});

test('older item-specific guest links remain restricted after reopening persisted state', async () => {
  const f = await fixture();
  let restored: Host | undefined;
  try {
    const allowedFile = path.join(f.directory, 'allowed.txt');
    const excludedFile = path.join(f.directory, 'excluded.txt');
    await writeFile(allowedFile, 'Allowed');
    await writeFile(excludedFile, 'Not granted');
    const allowedId = await f.host.shares.add(allowedFile);
    const excludedId = await f.host.shares.add(excludedFile);
    await f.host.whitepad.update('Combined content', 0);
    const link = await f.host.guestLinks.create('Older selected link');
    const legacy = f.store.state.guestLinks![0]!;
    delete legacy.scope;
    legacy.shareIds = [allowedId];
    legacy.textIds = ['old-note'];
    await f.store.save();
    await f.host.close();
    const store = await StateStore.open(f.store.directory, password);
    restored = new Host(store, {
      access: 'tunnel',
      transferPort: 0,
      managementPort: 0,
      transport: transport(),
    });
    await restored.listen();
    const cookie = await guestCookie(restored, link.token);
    const headers = { cookie };
    await restored.whitepad.update('Not granted', 1);
    const catalog = await (
      await fetch(`${restored.transferUrl}/guest/catalog`, { headers })
    ).json();
    assert.equal(catalog.scope, 'selected');
    assert.deepEqual(
      catalog.shares.map((share: { id: string }) => share.id),
      [allowedId],
    );
    assert.equal(catalog.whitepad, null);
    assert.equal(
      (
        await fetch(
          `${restored.transferUrl}/guest/shares/${excludedId}/files`,
          { headers },
        )
      ).status,
      404,
    );
    const fileId = restored.shares.files(excludedId).files[0]!.id;
    assert.equal(
      (
        await fetch(
          `${restored.transferUrl}/guest/shares/${excludedId}/files/${fileId}/content`,
          { headers },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${restored.transferUrl}/guest/whitepad`, {
          headers,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${restored.transferUrl}/guest/texts/old-note`, {
          headers,
        })
      ).status,
      404,
    );
  } finally {
    await restored?.close();
    await f.close();
  }
});

test('revoking a guest link aborts its active file transfer', async () => {
  const f = await fixture();
  let response: IncomingMessage | undefined;
  try {
    const input = path.join(f.directory, 'large-guest.bin');
    await writeFile(input, Buffer.alloc(16 * 1024 * 1024, 3));
    const shareId = await f.host.shares.add(input);
    const fileId = f.host.shares.files(shareId).files[0]!.id;
    const link = await f.host.guestLinks.create('Revoke running transfer');
    const cookie = await guestCookie(f.host, link.token);
    response = await guestStream(
      f.host,
      cookie,
      `/guest/shares/${shareId}/files/${fileId}/content`,
    );
    response.on('error', () => {});
    response.pause();
    assert.equal(response.statusCode, 200);
    assert.equal(
      (await local(f.host, `/api/guest-links/${link.id}`, 'DELETE')).status,
      200,
    );
    response.resume();
    await until(
      () => response!.destroyed,
      'Revoked guest download stayed open',
    );
    assert.equal(response.complete, false);
  } finally {
    response?.destroy();
    await f.close();
  }
});

test('password sessions reject wrong and expired credentials and throttle expensive work', async () => {
  const verifier = await passwordHash(password);
  const sessions = new Sessions(verifier, 20);
  await assert.rejects(sessions.login('wrong-password'), /Invalid password/);
  const token = await sessions.login(password);
  sessions.require(token);
  assert.throws(() => sessions.require(secret()), /Authentication/);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.throws(() => sessions.require(token), /expired/);
  await assert.rejects(passwordHash('short'), /12/);
  const limited = new Sessions(verifier);
  const concurrent = [limited.login(password), limited.login(password)];
  await assert.rejects(limited.login(password), /capacity/);
  await Promise.all(concurrent);
  for (let index = 0; index < 18; index++)
    assert.equal(await limited.verify('wrong-password'), false);
  await assert.rejects(limited.verify(password), /capacity/);
});

test('tunnel URL validation rejects credentials, paths and private networks', () => {
  for (const value of [
    'http://example.com',
    'https://user:pw@example.com',
    'https://example.com/private',
    'https://example.com:8443',
  ])
    assert.throws(() => publicUrl(value));
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.1.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    '100.64.0.1',
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
});

test('public listener has no legacy APIs or management; dashboard checks password, Host, Origin and CSRF', async () => {
  const f = await fixture();
  try {
    for (const route of [
      '/v1/shares',
      '/v1/texts',
      '/v1/events',
      '/v1/registry/peers',
      '/api/state',
    ])
      assert.equal((await fetch(`${f.host.transferUrl}${route}`)).status, 404);
    assert.equal(
      (
        await fetch(`${f.host.transferUrl}/v1/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password }),
        })
      ).status,
      404,
    );
    for (const [route, method] of [
      ['/api/catalog', 'GET'],
      ['/api/peer-texts', 'GET'],
      ['/api/discovery/refresh', 'POST'],
      ['/api/downloads', 'POST'],
    ])
      assert.equal((await local(f.host, route!, method)).status, 404);
    assert.equal(
      (
        await fetch(`${f.host.managementUrl}/api/state`, {
          headers: { authorization: `Bearer ${secret()}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (await fetch(`${f.host.managementUrl}/api/state`)).status,
      401,
    );
    const session = await fetch(`${f.host.managementUrl}/api/csrf`);
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { csrf: null });
    assert.equal(
      (await fetch(`${f.host.managementUrl}/favicon.ico`)).status,
      204,
    );
    assert.equal(
      (
        await fetch(`${f.host.managementUrl}/api/login`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://evil.test',
          },
          body: JSON.stringify({ password }),
        })
      ).status,
      403,
    );
    const login = await fetch(`${f.host.managementUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const { csrf } = (await login.json()) as { csrf: string };
    assert.equal(
      (
        await fetch(`${f.host.managementUrl}/api/state`, {
          headers: { cookie },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${f.host.managementUrl}/api/logout`, {
          method: 'POST',
          headers: { cookie },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${f.host.managementUrl}/api/logout`, {
          method: 'POST',
          headers: { cookie, 'x-p2pfs-csrf': csrf },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${f.host.managementUrl}/api/state`, {
          headers: { cookie },
        })
      ).status,
      401,
    );
    const spoofed = await f.host.management.inject({
      url: '/api/state',
      headers: {
        host: 'evil.test',
      },
    });
    assert.equal(spoofed.statusCode, 403);
  } finally {
    await f.close();
  }
});

test('share indexing excludes symlinks, detects changed sources and revokes access', async () => {
  const f = await fixture();
  try {
    const folder = path.join(f.directory, 'source');
    await mkdir(folder);
    await writeFile(path.join(folder, 'good.txt'), 'selected');
    await writeFile(path.join(f.directory, 'private.txt'), 'private');
    await symlink(
      path.join(f.directory, 'private.txt'),
      path.join(folder, 'escape'),
    );
    const id = await f.host.shares.add(folder);
    const listing = f.host.shares.files(id);
    assert.equal(listing.files.length, 1);
    assert.ok(f.host.shares.list(true)[0]?.warnings?.length);
    const file = listing.files[0]!;
    const { stream: response } = await f.host.shares.stream(id, file.id);
    let content = '';
    for await (const chunk of response) content += String(chunk);
    assert.equal(content, 'selected');
    await writeFile(path.join(folder, 'good.txt'), 'changed content');
    await assert.rejects(f.host.shares.stream(id, file.id), /Source changed/);
    await f.host.shares.refresh(id);
    await f.host.shares.remove(id);
    assert.throws(() => f.host.shares.files(id), /not found/);
    await assert.rejects(
      f.host.shares.add(path.join(folder, 'escape')),
      /Symlink/,
    );
  } finally {
    await f.close();
  }
});

test('local file picker navigates folders, selects typed files and excludes links and hidden entries', async () => {
  const f = await fixture();
  try {
    const folder = path.join(f.directory, 'picker');
    await mkdir(path.join(folder, 'z-folder'), { recursive: true });
    await writeFile(path.join(folder, 'a-file.txt'), 'selected');
    await writeFile(path.join(folder, '.hidden'), 'hidden');
    await symlink(f.directory, path.join(folder, 'escape'));
    const response = await local(
      f.host,
      `/api/filesystem?path=${encodeURIComponent(folder)}`,
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(
      result.entries.map((entry: { name: string }) => entry.name),
      ['z-folder', 'a-file.txt'],
    );
    assert.equal(result.omitted, 1);
    assert.equal(result.parent, f.directory);
    const selected = await browseFilesystem(
      path.join(folder, 'a-file.txt'),
      true,
    );
    assert.equal(selected.path, folder);
    assert.equal(selected.selected, path.join(folder, 'a-file.txt'));
    assert.ok(selected.entries.some((entry) => entry.name === '.hidden'));
    await assert.rejects(
      browseFilesystem(path.join(folder, 'escape')),
      /Symlink/,
    );
    await assert.rejects(browseFilesystem('relative'), /absolute/);
    await assert.rejects(
      browseFilesystem(path.join(folder, 'missing')),
      /no longer exists/,
    );
    assert.equal(
      (
        await fetch(
          `${f.host.managementUrl}/api/filesystem?path=${encodeURIComponent(folder)}`,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await local(
          f.host,
          `/api/filesystem?path=${encodeURIComponent(folder)}&hidden=invalid`,
        )
      ).status,
      400,
    );
    assert.equal(
      (await fetch(`${f.host.transferUrl}/api/filesystem`)).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test('local file picker caps directory traversal and reports partial listings', async () => {
  const f = await fixture();
  try {
    const folder = path.join(f.directory, 'large-picker');
    await mkdir(folder);
    await Promise.all(
      Array.from({ length: 1002 }, (_, i) =>
        writeFile(path.join(folder, `file-${i}`), ''),
      ),
    );
    const result = await browseFilesystem(folder);
    assert.equal(result.entries.length, 1000);
    assert.equal(result.truncated, true);
  } finally {
    await f.close();
  }
});

test('whitepad authenticates writes, preserves literal text and clearing across restart', async () => {
  const f = await fixture();
  try {
    const content = 'First line\n<img src=x onerror="alert(1)">\n  café 👋\n';
    assert.equal(
      (await fetch(`${f.host.transferUrl}/guest/catalog`)).status,
      401,
    );
    assert.equal(
      (await fetch(`${f.host.managementUrl}/api/whitepad`)).status,
      401,
    );
    for (const body of [
      { content: 'text' },
      { content: 'text', revision: -1 },
      { content: 'x'.repeat(MAX_WHITEPAD_LENGTH + 1), revision: 0 },
      { content: 'text', revision: 0, unexpected: true },
    ])
      assert.equal(
        (await local(f.host, '/api/whitepad', 'PUT', body)).status,
        400,
      );
    const response = await local(f.host, '/api/whitepad', 'PUT', {
      revision: 0,
      content,
    });
    assert.equal(response.status, 200);
    const { revision } = await response.json();
    assert.equal(revision, 1);
    const link = await f.host.guestLinks.create('Text');
    const cookie = await guestCookie(f.host, link.token);
    const shared = (
      await (
        await fetch(`${f.host.transferUrl}/guest/catalog`, {
          headers: { cookie },
        })
      ).json()
    ).whitepad;
    assert.equal(shared.content, content);
    assert.equal(shared.revision, 1);
    const note = await (
      await fetch(`${f.host.transferUrl}/guest/whitepad`, {
        headers: { cookie },
      })
    ).json();
    assert.equal(note.content, content);
    assert.equal((await local(f.host, '/api/whitepad')).status, 200);
    const reopened = await StateStore.open(f.store.directory, password);
    assert.equal(new Whitepad(reopened).get().content, content);
    const login = await fetch(`${f.host.managementUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const managementCookie = login.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal(
      (
        await fetch(`${f.host.managementUrl}/api/whitepad`, {
          method: 'PUT',
          headers: {
            cookie: managementCookie,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ content: '', revision: 1 }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await local(f.host, '/api/whitepad', 'PUT', {
          content: 'stale',
          revision: 0,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await local(f.host, '/api/whitepad', 'PUT', {
          content: '',
          revision: 1,
        })
      ).status,
      200,
    );
    assert.equal(
      new Whitepad(await StateStore.open(f.store.directory, password)).get()
        .content,
      '',
    );
    const maximum = '\u0000'.repeat(MAX_WHITEPAD_LENGTH);
    assert.equal(
      (
        await local(f.host, '/api/whitepad', 'PUT', {
          revision: 2,
          content: maximum,
        })
      ).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test('whitepad serializes concurrent revisions and rolls back failed persistence', async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled([
      f.host.whitepad.update('First', 0),
      f.host.whitepad.update('Second', 0),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ['fulfilled', 'rejected'],
    );
    assert.equal(f.host.whitepad.get().content, 'First');
    const first = f.host.whitepad.get();
    assert.deepEqual(await f.host.whitepad.update('First', 1), first);
    const save = f.store.save.bind(f.store);
    f.store.save = async () => {
      throw new Error('Synthetic disk failure');
    };
    await assert.rejects(
      f.host.whitepad.update('not published', 1),
      /disk failure/,
    );
    assert.deepEqual(f.host.whitepad.get(), first);
    assert.deepEqual(f.store.state.whitepad, first);
    f.store.save = save;
    await f.host.whitepad.update(' \n ', 1);
    assert.deepEqual(
      new Whitepad(await StateStore.open(f.store.directory, password)).get(),
      f.host.whitepad.get(),
    );
  } finally {
    await f.close();
  }
});

test('shared folders update automatically, preserve unchanged streams and recover safely after deletion', async () => {
  const f = await fixture();
  try {
    const folder = path.join(f.directory, 'live-share');
    await mkdir(folder);
    await writeFile(path.join(folder, 'keep.txt'), 'unchanged');
    const id = await f.host.shares.add(folder);
    const file = f.host.shares.files(id).files[0]!;
    const open = await f.host.shares.stream(id, file.id);
    await mkdir(path.join(folder, 'nested'));
    await writeFile(path.join(folder, 'nested', 'added.txt'), 'new');
    await until(
      () => f.host.shares.files(id).files.length === 2,
      'New nested file was not indexed live.',
    );
    assert.ok(
      f.host.shares.files(id).files.some((entry) => entry.id === file.id),
    );
    let body = '';
    for await (const chunk of open.stream) body += String(chunk);
    assert.equal(body, 'unchanged');
    await writeFile(path.join(folder, 'keep.txt'), 'changed source');
    await until(
      () =>
        f.host.shares
          .files(id)
          .files.some(
            (entry) => entry.name === 'keep.txt' && entry.size === 14,
          ),
      'Modified file metadata was not updated.',
    );
    await rm(folder, { recursive: true });
    await until(
      () => !f.host.shares.list().length,
      'Deleted share remained published.',
    );
    await symlink(f.directory, folder);
    await until(
      () =>
        f.host.shares.warnings().some((warning) => warning.includes('Symlink')),
      'Unsafe replacement was not reported.',
    );
    assert.equal(f.host.shares.list().length, 0);
    await rm(folder);
    await mkdir(folder);
    await writeFile(path.join(folder, 'restored.txt'), 'restored');
    await until(
      () => f.host.shares.list()[0]?.count === 1,
      'Recreated share was not recovered.',
    );
    assert.equal(f.host.shares.files(id).files[0]?.name, 'restored.txt');
  } finally {
    await f.close();
  }
});

test('live feeds require authentication, push changes and close after logout', async () => {
  const f = await fixture();
  let response: IncomingMessage | undefined;
  try {
    assert.equal(
      (await fetch(`${f.host.managementUrl}/api/events`)).status,
      401,
    );
    const { cookie } = await localSession(f.host);
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      http
        .get(
          `${f.host.managementUrl}/api/events`,
          { headers: { cookie } },
          resolve,
        )
        .once('error', reject);
    });
    assert.match(
      String(response.headers['content-type']),
      /text\/event-stream/,
    );
    const events = observeEvents(response);
    await until(
      () => events.data.includes('catalog'),
      'Initial live synchronization was not sent.',
    );
    events.data = '';
    await f.host.whitepad.update('This notification should be pushed.', 0);
    await until(
      () => events.data.includes('"catalog":true'),
      'Text creation was not pushed.',
    );
    events.data = '';
    assert.equal((await local(f.host, '/api/logout', 'POST')).status, 200);
    await f.host.whitepad.update('The expired stream must close.', 1);
    await until(() => events.ended, 'Logged-out live session remained open.');
    assert.equal(events.error, undefined);
  } finally {
    response?.destroy();
    await f.close();
  }
});

test('provider output parsing handles split/colored output without accepting unrelated URLs', () => {
  assert.equal(
    parseEndpoint(
      'devtunnel',
      '\x1b[32mHosting port 7331 at https://abc-7331.eun1.devtunnels.ms/\x1b[0m\n',
    ),
    'https://abc-7331.eun1.devtunnels.ms',
  );
  assert.equal(
    parseEndpoint('devtunnel', 'Hosting port 7331 at htt'),
    undefined,
  );
  assert.equal(
    parseEndpoint(
      'zrok',
      'Login at https://example.com\naccess your zrok share at the following endpoints:\n https://abc.share.zrok.io',
    ),
    'https://abc.share.zrok.io',
  );
  assert.equal(
    parseEndpoint('zrok', 'Log in at https://example.com'),
    undefined,
  );
});

test('state rejects wrong passwords and preserves configuration across restart', async () => {
  const f = await fixture();
  try {
    f.store.state.name = 'Saved name';
    await f.store.save();
    await assert.rejects(
      StateStore.open(f.store.directory, 'wrong-password'),
      /does not match/,
    );
    const reopened = await StateStore.open(f.store.directory, password);
    assert.equal(reopened.state.id, f.store.state.id);
    assert.equal(reopened.state.name, 'Saved name');
  } finally {
    await f.close();
  }
});

test('host configuration controls provider selection and rejects invalid edits without rewriting state', async () => {
  const f = await fixture();
  try {
    await f.host.close();
    const config = path.join(f.store.directory, 'host.json');
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), {
      access: 'lan',
      provider: 'ngrok',
    });
    await writeFile(config, '{"provider":"devtunnel"}\n');
    const reopened = await StateStore.open(f.store.directory, password);
    assert.equal(reopened.state.provider, 'devtunnel');
    assert.equal(reopened.access, 'lan');
    assert.equal(await readFile(config, 'utf8'), '{"provider":"devtunnel"}\n');
    await writeFile(config, '{"access":"tunnel","provider":"devtunnel"}\n');
    assert.equal(
      (await StateStore.open(f.store.directory, password)).access,
      'tunnel',
    );
    const stateFile = path.join(f.store.directory, 'state.json');
    const saved = await readFile(stateFile, 'utf8');
    for (const invalid of [
      '{',
      '{}',
      '{"provider":"unknown"}',
      '{"provider":["ngrok"]}',
      '{"provider":"zrok","typo":true}',
      '{"access":"public"}',
      '{"access":false}',
      '{"lanAddress":null}',
      '{"lanAddress":"0.0.0.0"}',
      '{"lanAddress":"127.0.0.1"}',
      '{"lanAddress":"8.8.8.8"}',
      '{"guestUrl":null}',
      '{"guestUrl":"not a URL"}',
      '{"guestUrl":"file:///tmp/guest"}',
      '{"guestUrl":"http://user:password@home.arpa/apps/p2pfs"}',
      '{"guestUrl":"http://home.arpa/apps/p2pfs?token=secret"}',
      '{"guestUrl":"http://home.arpa/apps/p2pfs#token=secret"}',
      '{"guestUrl":"http://home.arpa/apps/%22unsafe%22"}',
    ]) {
      await writeFile(config, invalid);
      await assert.rejects(
        StateStore.open(f.store.directory, password),
        /host configuration/,
      );
      assert.equal(await readFile(config, 'utf8'), invalid);
      assert.equal(await readFile(stateFile, 'utf8'), saved);
    }
  } finally {
    await f.close();
  }
});

test('LAN configuration accepts only a private IPv4 address assigned to a network interface', async (t) => {
  const address = '192.168.50.25';
  t.mock.method(
    os,
    'networkInterfaces',
    (): ReturnType<typeof os.networkInterfaces> => ({
      ethernet: [
        {
          address,
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: `${address}/24`,
        },
      ],
    }),
  );
  assert.equal(lanAddress(address), address);
  for (const invalid of [
    '0.0.0.0',
    '127.0.0.1',
    '8.8.8.8',
    '::1',
    '192.168.50.25:7331',
    'http://192.168.50.25',
  ])
    assert.throws(() => lanAddress(invalid), /private IPv4/);
  assert.throws(
    () => lanAddress('192.168.50.26'),
    /not assigned to this computer/,
  );
  const f = await fixture();
  try {
    const config = path.join(f.store.directory, 'host.json');
    await writeFile(config, JSON.stringify({ lanAddress: address }));
    const reopened = await StateStore.open(f.store.directory, password);
    assert.equal(reopened.lanAddress, address);
    assert.equal(reopened.state.provider, 'ngrok');
    assert.throws(
      () =>
        new Host(reopened, {
          publicUrl: 'https://example.ngrok.app',
          lanAddress: address,
        }),
      /cannot be combined/,
    );
    await writeFile(
      config,
      JSON.stringify({ provider: 'zrok', lanAddress: address }),
    );
    const withProvider = await StateStore.open(f.store.directory, password);
    assert.equal(withProvider.lanAddress, address);
    assert.equal(withProvider.state.provider, 'zrok');
    const saved = await readFile(
      path.join(f.store.directory, 'state.json'),
      'utf8',
    );
    await writeFile(config, JSON.stringify({ lanAddress: '192.168.50.26' }));
    const unavailable = await StateStore.open(f.store.directory, password);
    assert.throws(() => new Host(unavailable), /not assigned/);
    assert.equal(
      await readFile(path.join(f.store.directory, 'state.json'), 'utf8'),
      saved,
    );
    await writeFile(config, '{"provider":"zrok"}');
    assert.equal(
      (await StateStore.open(f.store.directory, password)).lanAddress,
      undefined,
    );
  } finally {
    await f.close();
  }
});

test('default LAN address selection prefers a network interface over a point-to-point interface and never uses a public or loopback address', (t) => {
  let interfaces: ReturnType<typeof os.networkInterfaces> = {
    loopback: [
      {
        address: '127.0.0.1',
        netmask: '255.0.0.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: true,
        cidr: '127.0.0.1/8',
      },
    ],
    vpn: [
      {
        address: '10.10.10.10',
        netmask: '255.255.255.255',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: false,
        cidr: '10.10.10.10/32',
      },
    ],
    ethernet: [
      {
        address: '192.168.8.100',
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: '00:11:22:33:44:55',
        internal: false,
        cidr: '192.168.8.100/24',
      },
    ],
  };
  t.mock.method(os, 'networkInterfaces', () => interfaces);
  assert.equal(lanAddress(), '192.168.8.100');
  assert.equal(lanAddress('10.10.10.10'), '10.10.10.10');
  interfaces = { loopback: interfaces.loopback, vpn: interfaces.vpn };
  assert.equal(lanAddress(), '10.10.10.10');
  interfaces = {
    loopback: interfaces.loopback,
    public: [
      {
        address: '8.8.8.8',
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: '00:11:22:33:44:55',
        internal: false,
        cidr: '8.8.8.8/24',
      },
    ],
  };
  assert.throws(() => lanAddress(), /No private IPv4.*--tunnel/);
});

test('dashboard starts only the configured provider and cannot override it', async () => {
  const f = await fixture();
  try {
    const calls: unknown[] = [];
    f.host.tunnel.start = async (provider, port) => {
      calls.push([provider, port]);
      return 'https://synthetic.example.org';
    };
    assert.equal(
      (await local(f.host, '/api/tunnel/start', 'POST', { provider: 'zrok' }))
        .status,
      400,
    );
    assert.deepEqual(calls, []);
    assert.equal(
      (await local(f.host, '/api/tunnel/start', 'POST', {})).status,
      200,
    );
    assert.deepEqual(calls, [
      ['ngrok', Number(new URL(f.host.transferUrl).port)],
    ]);
    const html = await (await fetch(f.host.managementUrl)).text();
    assert.equal(html.includes('id="provider"'), false);
    assert.equal(html.includes('<option'), false);
  } finally {
    await f.close();
  }
});

test('legacy state migrates without losing content, link restrictions or unrelated files', async () => {
  const f = await fixture();
  let restored: Host | undefined;
  try {
    const source = path.join(f.directory, 'kept.txt');
    await writeFile(source, 'Preserved file');
    const shareId = await f.host.shares.add(source);
    const selected = await f.host.guestLinks.create('Older selected link');
    const session = await f.host.guestLinks.create('Whole session');
    const older = f.store.state.guestLinks!.find(
      (entry) => entry.id === selected.id,
    )!;
    delete older.scope;
    older.shareIds = [shareId];
    const previous = {
      ...f.store.state,
      version: 1,
      texts: [
        {
          id: 'first',
          title: 'Preserved note',
          content: 'Keep this text',
          created: Date.now(),
        },
        {
          id: 'second',
          title: 'Another note',
          content: '  <b>literal</b>\n',
          created: Date.now(),
        },
      ],
      managementToken: secret(),
      registryEnabled: true,
      registryUrl: 'https://old-registry.example.org',
      cachedPeers: [
        {
          id: 'old',
          name: 'Old peer',
          url: 'https://old.example.org',
          lastSeen: Date.now(),
        },
      ],
      registrations: { old: 'synthetic-obsolete-owner' },
      downloadDir: path.join(f.directory, 'old-downloads'),
      provider: 'zrok',
      allowedHosts: ['custom.example.org'],
    };
    await f.host.close();
    await mkdir(previous.downloadDir);
    await writeFile(
      path.join(previous.downloadDir, 'saved.txt'),
      'Already downloaded',
    );
    const database = path.join(f.store.directory, 'registry.sqlite');
    await writeFile(database, 'Synthetic old registry marker');
    const stateFile = path.join(f.store.directory, 'state.json');
    const contents = JSON.stringify(previous);
    await writeFile(stateFile, contents);
    await rm(path.join(f.store.directory, 'host.json'));
    await assert.rejects(
      StateStore.open(f.store.directory, 'wrong-password'),
      /does not match/,
    );
    assert.equal(await readFile(stateFile, 'utf8'), contents);
    await assert.rejects(readFile(path.join(f.store.directory, 'host.json')), {
      code: 'ENOENT',
    });
    const store = await StateStore.open(f.store.directory, password);
    assert.equal(store.state.version, 3);
    assert.equal(store.state.id, previous.id);
    assert.equal(store.state.verifier, previous.verifier);
    assert.equal(store.state.provider, 'zrok');
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(f.store.directory, 'host.json'), 'utf8'),
      ),
      { access: 'lan', provider: 'zrok' },
    );
    assert.deepEqual(store.state.allowedHosts, previous.allowedHosts);
    assert.deepEqual(store.state.shares, previous.shares);
    assert.equal(
      store.state.whitepad.content,
      'Preserved note\n\nKeep this text\n\n---\n\nAnother note\n\n  <b>literal</b>\n',
    );
    assert.deepEqual(store.state.guestLinks, previous.guestLinks);
    const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
    for (const key of [
      'registryEnabled',
      'registryUrl',
      'registrations',
      'cachedPeers',
      'downloadDir',
      'managementToken',
      'texts',
    ])
      assert.equal(key in persisted, false);
    assert.equal(
      await readFile(database, 'utf8'),
      'Synthetic old registry marker',
    );
    assert.equal(
      await readFile(path.join(previous.downloadDir, 'saved.txt'), 'utf8'),
      'Already downloaded',
    );
    restored = new Host(store, {
      access: 'tunnel',
      managementPort: 0,
      transferPort: 0,
      transport: transport(),
    });
    await restored.listen();
    assert.equal(
      (
        await fetch(`${restored.managementUrl}/api/state`, {
          headers: { authorization: `Bearer ${previous.managementToken}` },
        })
      ).status,
      401,
    );
    const limitedCookie = await guestCookie(restored, selected.token);
    assert.equal(
      (
        await fetch(`${restored.transferUrl}/guest/whitepad`, {
          headers: { cookie: limitedCookie },
        })
      ).status,
      404,
    );
    const cookie = await guestCookie(restored, session.token);
    assert.equal(
      (
        await fetch(`${restored.transferUrl}/guest/whitepad`, {
          headers: { cookie },
        })
      ).status,
      200,
    );
    await restored.close();
    const invalid = JSON.stringify({ ...persisted, version: 99 });
    await writeFile(stateFile, invalid);
    await assert.rejects(
      StateStore.open(f.store.directory, password),
      /Invalid persisted state/,
    );
    assert.equal(await readFile(stateFile, 'utf8'), invalid);
  } finally {
    await restored?.close();
    await f.close();
  }
});

test('v2 migration fits every legacy snippet and rejects malformed whitepads without rewriting state', async () => {
  const f = await fixture();
  try {
    await f.host.close();
    const texts = Array.from({ length: 50 }, (_, index) => ({
      id: `note-${index}`,
      title: `Note ${index}`,
      content: `${index}:` + 'x'.repeat(15_997),
      created: Date.now(),
    }));
    const file = path.join(f.store.directory, 'state.json');
    await writeFile(
      file,
      JSON.stringify({ ...f.store.state, version: 2, texts }),
    );
    const migrated = await StateStore.open(f.store.directory, password);
    assert.equal(migrated.state.version, 3);
    assert.equal(
      migrated.state.whitepad.content,
      texts
        .map(({ title, content }) => `${title}\n\n${content}`)
        .join('\n\n---\n\n'),
    );
    assert.ok(migrated.state.whitepad.content.length <= MAX_WHITEPAD_LENGTH);
    for (const whitepad of [
      { content: 'x', revision: -1, updated: 0 },
      { content: 'x'.repeat(MAX_WHITEPAD_LENGTH + 1), revision: 1, updated: 1 },
    ]) {
      const invalid = JSON.stringify({ ...migrated.state, whitepad });
      await writeFile(file, invalid);
      await assert.rejects(
        StateStore.open(f.store.directory, password),
        /Invalid persisted state/,
      );
      assert.equal(await readFile(file, 'utf8'), invalid);
    }
  } finally {
    await f.close();
  }
});

test('failed tunnel prerequisites leave an explicit stopped state and permit retry', async () => {
  const tunnel = new Tunnel(transport(), 'test-host', {
    devtunnel: path.join(os.tmpdir(), `p2pfs-nonexistent-${secret()}`),
  });
  await assert.rejects(tunnel.start('devtunnel', 1));
  assert.match(tunnel.status, /Failed/);
  await tunnel.stop();
  assert.equal(tunnel.url, undefined);
});

test('large-file streaming uses bounded memory and revocation aborts an active download', async () => {
  const a = await fixture();
  let active: IncomingMessage | undefined;
  try {
    const input = path.join(a.directory, 'stream.bin');
    const handle = await import('node:fs/promises').then((fs) =>
      fs.open(input, 'w'),
    );
    const size = 256 * 1024 * 1024;
    await handle.truncate(size);
    await handle.close();
    const id = await a.host.shares.add(input);
    const file = a.host.shares.files(id).files[0]!;
    const link = await a.host.guestLinks.create('Large file');
    const cookie = await guestCookie(a.host, link.token);
    const route = `/guest/shares/${id}/files/${file.id}/content`;
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sample = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 5);
    try {
      active = await guestStream(a.host, cookie, route);
      let bytes = 0;
      for await (const chunk of active) bytes += Buffer.byteLength(chunk);
      assert.equal(bytes, size);
      assert.equal(active.complete, true);
      assert.ok(
        peak - baseline < size / 2,
        `RSS growth ${peak - baseline} was not bounded below half the 256 MiB payload`,
      );
    } finally {
      clearInterval(sample);
    }
    active = await guestStream(a.host, cookie, route);
    active.on('error', () => {});
    active.pause();
    assert.equal(active.statusCode, 200);
    await a.host.shares.remove(id);
    active.resume();
    await until(() => active!.destroyed, 'Revoked share stream stayed open');
    assert.equal(active.complete, false);
    assert.equal(
      (await fetch(`${a.host.transferUrl}${route}`, { headers: { cookie } }))
        .status,
      404,
    );
  } finally {
    active?.destroy();
    await a.close();
  }
});

test('HTTPS health probes refuse private resolution before connecting', async () => {
  await assert.rejects(
    new Transport().request('https://127.0.0.1', '/v1/health'),
    /non-public/,
  );
});
