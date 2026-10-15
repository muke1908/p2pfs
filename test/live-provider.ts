import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { StateStore, type Provider } from '../src/config/state.js';
import { Host } from '../src/host/app.js';

const provider = process.argv[2] as Provider;
if (!['devtunnel', 'ngrok', 'zrok'].includes(provider))
  throw new Error('Specify devtunnel, ngrok, or zrok.');
const root = await realpath(
  await mkdtemp(path.join(os.tmpdir(), 'p2pfs-live-')),
);
const store = await StateStore.open(
  path.join(root, 'host'),
  'synthetic-provider-smoke-password',
  { name: 'synthetic-source', provider },
);
const host = new Host(store, { transferPort: 0, managementPort: 0 });
try {
  await host.listen();
  const file = path.join(root, 'synthetic.txt');
  const content = 'Synthetic p2pfs public transfer test. No user data.\n';
  await writeFile(file, content);
  const shareId = await host.shares.add(file);
  await host.startTunnel(provider);
  assert.equal(host.tunnel.status, 'Ready');
  const origin = host.tunnel.url!;
  const request = (route: string, options: RequestInit = {}) =>
    fetch(`${origin}${route}`, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'ngrok-skip-browser-warning': 'p2pfs',
        'x-tunnel-skip-antiphishing-page': 'true',
        ...options.headers,
      },
    });
  assert.equal((await request('/api/state')).status, 404);
  assert.equal((await request('/guest/catalog')).status, 401);
  assert.equal((await request('/receive')).status, 200);
  const link = await host.guestLinks.create('Public browser smoke test');
  const exchange = await request('/guest/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: link.token }),
  });
  assert.equal(exchange.status, 200);
  assert.match(exchange.headers.get('set-cookie')!, /; Secure/);
  const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!;
  const catalog = await (
    await request('/guest/catalog', { headers: { cookie } })
  ).json();
  assert.equal(catalog.shares[0].id, shareId);
  assert.equal(catalog.shares[0].kind, 'file');
  const download = await request(
    `/guest/shares/${shareId}/files/${catalog.shares[0].file.id}/content`,
    { headers: { cookie } },
  );
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition')!, /attachment;/);
  assert.equal(await download.text(), content);
  await host.guestLinks.revoke(link.id);
  assert.equal(
    (await request('/guest/catalog', { headers: { cookie } })).status,
    401,
  );
  console.log(
    JSON.stringify({
      provider,
      version: host.tunnel.version,
      guestAccess: 'passed',
      publicDownload: 'passed',
      revocation: 'passed',
      managementIsolation: 'passed',
    }),
  );
} finally {
  try {
    await host.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
