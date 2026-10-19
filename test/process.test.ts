import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { isPrivateIPv4, lanAddress } from '../src/config/network.js';
import { availablePort } from '../src/tunnels/manager.js';

const password = 'test-password-not-a-secret';
interface Ready {
  id: string;
  transferUrl: string;
  managementUrl: string;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<number | null>((resolve) =>
    child.once('close', resolve),
  );
  child.kill('SIGTERM');
  const forced = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    assert.equal(await closed, 0);
  } finally {
    clearTimeout(forced);
  }
}

async function launch(directory: string) {
  const child = fork('dist/test/host-worker.js', [directory], { silent: true });
  let errors = '';
  child.stderr?.on('data', (data: Buffer) => {
    errors += data.toString();
  });
  try {
    const info = await new Promise<Ready>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Host startup timed out: ${errors}`)),
        10_000,
      );
      child.once('message', (message) => {
        clearTimeout(timer);
        resolve(message as Ready);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Host exited (${code}): ${errors}`));
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return { child, info };
  } catch (error) {
    await stop(child);
    throw error;
  }
}

async function management(origin: string) {
  const login = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const { csrf } = await login.json();
  return async (route: string, method = 'GET', body?: unknown) =>
    fetch(origin + route, {
      method,
      headers: {
        cookie,
        'x-p2pfs-csrf': csrf,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

test('a separate host process serves browser links, persists them across restart and revokes access', async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'p2pfs-process-')),
  );
  let running: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    running = await launch(root);
    let local = await management(running.info.managementUrl);
    const source = path.join(root, 'source');
    await mkdir(path.join(source, 'nested'), { recursive: true });
    await writeFile(
      path.join(source, 'nested', 'payload.txt'),
      'real-process-transfer',
    );
    const share = await local('/api/shares', 'POST', { path: source });
    assert.equal(share.status, 200);
    const { id } = await share.json();
    const created = await local('/api/guest-links', 'POST', {
      label: 'Browser session',
    });
    assert.equal(created.status, 200);
    const link = await created.json();
    const token = new URLSearchParams(new URL(link.url).hash.slice(1)).get(
      'token',
    );
    const exchange = async () => {
      const response = await fetch(
        `${running!.info.transferUrl}/guest/session`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        },
      );
      assert.equal(response.status, 200);
      return response.headers.get('set-cookie')!.split(';')[0]!;
    };
    let cookie = await exchange();
    const originalId = running.info.id;
    await stop(running.child);
    running = await launch(root);
    assert.equal(running.info.id, originalId);
    assert.equal(
      (
        await fetch(`${running.info.transferUrl}/guest/catalog`, {
          headers: { cookie },
        })
      ).status,
      401,
    );
    cookie = await exchange();
    const catalog = await (
      await fetch(`${running.info.transferUrl}/guest/catalog`, {
        headers: { cookie },
      })
    ).json();
    assert.equal(catalog.shares[0].kind, 'directory');
    const listing = await (
      await fetch(`${running.info.transferUrl}/guest/shares/${id}/files`, {
        headers: { cookie },
      })
    ).json();
    assert.equal(listing.files[0].name, 'nested/payload.txt');
    const download = await fetch(
      `${running.info.transferUrl}/guest/shares/${id}/files/${listing.files[0].id}/content`,
      { headers: { cookie } },
    );
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'real-process-transfer');
    local = await management(running.info.managementUrl);
    assert.equal(
      (await local(`/api/guest-links/${link.id}`, 'DELETE')).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${running.info.transferUrl}/guest/catalog`, {
          headers: { cookie },
        })
      ).status,
      401,
    );
  } finally {
    try {
      if (running) await stop(running.child);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('publisher CLI explicitly starts the configured tunnel and rejects removed options', async () => {
  for (const command of [
    'share',
    'receive',
    'registry',
    'peers',
    'browse',
    'download',
    'cancel',
    'status',
    'stop',
  ])
    await assert.rejects(
      promisify(execFile)(process.execPath, ['dist/src/cli/main.js', command]),
      /too many arguments/,
    );
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'p2pfs-cli-')),
  );
  await assert.rejects(
    promisify(execFile)(process.execPath, [
      'dist/src/cli/main.js',
      '--provider',
      'ngrok',
    ]),
    /unknown option/,
  );
  await assert.rejects(
    promisify(execFile)(process.execPath, [
      'dist/src/cli/main.js',
      '--no-tunnel',
    ]),
    /unknown option/,
  );
  await writeFile(
    path.join(root, 'host.json'),
    '{"provider":"devtunnel","lanAddress":"192.168.250.250"}\n',
  );
  const managementPort = await availablePort();
  let transferPort = await availablePort();
  while (transferPort === managementPort) transferPort = await availablePort();
  const child = spawn(
    process.execPath,
    [
      '--import',
      './dist/test/cli-tunnel-fixture.js',
      'dist/src/cli/main.js',
      '--state-dir',
      root,
      '--management-port',
      String(managementPort),
      '--transfer-port',
      String(transferPort),
      '--password-stdin',
      '--tunnel',
    ],
    {
      env: { ...process.env, P2PFS_TEST_NO_LAN: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let errors = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`CLI startup timed out: ${errors}`)),
        10_000,
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('Public endpoint:')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`CLI exited (${code}): ${errors}`));
      });
      child.stdin?.end(`${password}\n`);
    });
    const local = await management(`http://127.0.0.1:${managementPort}`);
    const state = await (await local('/api/state')).json();
    assert.equal(state.tunnel.provider, undefined);
    assert.ok(
      output.includes(`Host configuration: ${path.join(root, 'host.json')}`),
    );
    assert.equal(
      JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'))
        .provider,
      'devtunnel',
    );
    assert.ok(
      output.includes(`Synthetic tunnel start: devtunnel on ${transferPort}`),
    );
    assert.equal(state.guestOrigin, 'https://fixture.example.com');
    assert.equal(
      (await local('/api/guest-links', 'POST', { label: 'Ready to share' }))
        .status,
      200,
    );
    await stop(child);
    await assert.rejects(readFile(path.join(root, 'process.lock')), {
      code: 'ENOENT',
    });
  } finally {
    try {
      await stop(child);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

const lan = Object.values(os.networkInterfaces())
  .flat()
  .some(
    (entry) =>
      entry?.family === 'IPv4' &&
      !entry.internal &&
      isPrivateIPv4(entry.address),
  )
  ? lanAddress()
  : undefined;

test(
  'LAN sharing starts by default and supports explicit addresses, saved configuration, and the Mac supervisor',
  { skip: !lan && 'No private IPv4 network interface is available' },
  async (t) => {
    assert.ok(lan);
    for (const conflict of [
      ['--tunnel'],
      ['--public-url', 'https://example.ngrok.app'],
    ])
      await assert.rejects(
        promisify(execFile)(process.execPath, [
          'dist/src/cli/main.js',
          '--lan',
          lan,
          ...conflict,
        ]),
        /cannot be used with/,
      );
    for (const mode of ['default', 'flag', 'configuration', 'mac']) {
      await t.test(mode, async () => {
        const root = await realpath(
          await mkdtemp(path.join(os.tmpdir(), 'p2pfs-lan-')),
        );
        if (mode === 'configuration')
          await writeFile(
            path.join(root, 'host.json'),
            JSON.stringify({ lanAddress: lan }),
          );
        if (mode === 'default')
          await writeFile(
            path.join(root, 'host.json'),
            '{"provider":"devtunnel"}',
          );
        if (mode === 'flag') {
          await writeFile(
            path.join(root, 'host.json'),
            '{"access":"tunnel","provider":"zrok"}',
          );
        }
        const managementPort = await availablePort();
        let transferPort = await availablePort();
        while (transferPort === managementPort)
          transferPort = await availablePort();
        const child = spawn(
          process.execPath,
          [
            '--import',
            './dist/test/cli-tunnel-fixture.js',
            `dist/src/cli/${mode === 'mac' ? 'mac-host' : 'main'}.js`,
            '--state-dir',
            root,
            '--management-port',
            String(managementPort),
            '--transfer-port',
            String(transferPort),
            ...(mode === 'flag' ? ['--lan', lan] : []),
            ...(mode === 'mac' ? [] : ['--password-stdin']),
          ],
          {
            env: { ...process.env, P2PFS_TEST_TUNNEL_FAILURE: '1' },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        let output = '';
        let errors = '';
        const content = `http://${lan}:${transferPort}`;
        const dashboard = `http://127.0.0.1:${managementPort}`;
        let events: Awaited<ReturnType<typeof fetch>> | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`LAN startup timed out: ${errors}`)),
              10_000,
            );
            const ready = () => {
              if (
                (mode === 'mac' ? errors : output).includes('LAN endpoint:') &&
                errors.includes('unencrypted HTTP') &&
                (mode !== 'mac' || output.includes('"status":"LAN sharing"'))
              ) {
                clearTimeout(timer);
                resolve();
              }
            };
            child.stdout.on('data', (chunk: Buffer) => {
              output += chunk.toString();
              ready();
            });
            child.stderr.on('data', (chunk: Buffer) => {
              errors += chunk.toString();
              ready();
            });
            child.once('error', (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.once('exit', (code) => {
              clearTimeout(timer);
              reject(new Error(`LAN publisher exited (${code}): ${errors}`));
            });
            if (mode === 'mac') child.stdin.write(`${password}\n`);
            else child.stdin.end(`${password}\n`);
          });
          assert.equal(output.includes('Synthetic tunnel start'), false);
          assert.equal(errors.includes('Synthetic tunnel start'), false);
          assert.match(errors, /unencrypted HTTP/);
          const local = await management(dashboard);
          const state = await (await local('/api/state')).json();
          assert.equal(state.access, 'lan');
          assert.equal(state.guestOrigin, content);
          assert.equal(state.tunnel.status, 'LAN sharing');
          assert.equal(state.managementUrl, dashboard);
          assert.equal((await fetch(`${content}/receive`)).status, 200);
          assert.equal((await fetch(`${content}/receive.js`)).status, 200);
          assert.equal((await fetch(`${content}/api/state`)).status, 404);
          await assert.rejects(
            fetch(`http://${lan}:${managementPort}/api/state`, {
              signal: AbortSignal.timeout(2000),
            }),
          );
          await assert.rejects(
            fetch(`http://127.0.0.1:${transferPort}/receive`),
          );
          assert.equal(
            await new Promise<number | undefined>((resolve, reject) => {
              http
                .get(
                  `${content}/receive`,
                  { headers: { host: 'untrusted.example' } },
                  (response) => {
                    response.resume();
                    resolve(response.statusCode);
                  },
                )
                .once('error', reject);
            }),
            403,
          );
          for (const operation of ['start', 'stop'])
            assert.equal(
              (await local(`/api/tunnel/${operation}`, 'POST', {})).status,
              409,
            );
          const file = path.join(root, 'payload.txt');
          await writeFile(file, 'direct LAN transfer');
          const shared = await local('/api/shares', 'POST', { path: file });
          assert.equal(shared.status, 200);
          const { id: shareId } = await shared.json();
          const pad = await local('/api/whitepad', 'PUT', {
            content: 'LAN whitepad',
            revision: 0,
          });
          assert.equal(pad.status, 200, await pad.text());
          const created = await local('/api/guest-links', 'POST', {
            label: 'LAN guest',
          });
          assert.equal(created.status, 200);
          const link = await created.json();
          assert.equal(new URL(link.url).origin, content);
          assert.equal(link.joinUrl, `${content}/receive`);
          assert.match(link.pin, /^[0-9]{4}$/);
          assert.ok(link.pinExpires > Date.now());
          const landing = await (await fetch(link.joinUrl)).text();
          assert.match(landing, /id="pin-form">/);
          assert.deepEqual(
            await (await fetch(`${content}/guest/session`)).json(),
            { authenticated: false },
          );
          const token = new URLSearchParams(
            new URL(link.url).hash.slice(1),
          ).get('token');
          assert.equal((await fetch(`${content}/guest/catalog`)).status, 401);
          const exchange = (origin: string) =>
            fetch(`${content}/guest/session`, {
              method: 'POST',
              headers: { origin, 'content-type': 'application/json' },
              body: JSON.stringify({ token }),
            });
          assert.equal(
            (await exchange('http://untrusted.example')).status,
            403,
          );
          const tokenSession = await exchange(content);
          assert.equal(tokenSession.status, 200);
          const exchangePin = (origin: string, pin = link.pin) =>
            fetch(`${content}/guest/pin`, {
              method: 'POST',
              headers: { origin, 'content-type': 'application/json' },
              body: JSON.stringify({ pin }),
            });
          assert.equal(
            (await exchangePin('http://untrusted.example')).status,
            403,
          );
          assert.equal((await exchangePin(content, '123')).status, 400);
          const session = await exchangePin(content);
          assert.equal(session.status, 200);
          assert.equal((await exchangePin(content)).status, 401);
          const setCookie = session.headers.get('set-cookie')!;
          assert.match(setCookie, /HttpOnly; SameSite=Strict; Path=\/guest;/);
          assert.match(setCookie.split(';')[0]!, /=[a-zA-Z0-9_-]{43}$/);
          assert.equal(setCookie.includes('; Secure'), false);
          const headers = { cookie: setCookie.split(';')[0]! };
          assert.deepEqual(
            await (await fetch(`${content}/guest/session`, { headers })).json(),
            { authenticated: true },
          );
          assert.equal(
            (await fetch(`${dashboard}/api/state`, { headers })).status,
            401,
          );
          const catalog = await (
            await fetch(`${content}/guest/catalog`, { headers })
          ).json();
          assert.equal(catalog.whitepad.content, 'LAN whitepad');
          assert.equal(catalog.shares[0].id, shareId);
          const listing = await (
            await fetch(`${content}/guest/shares/${shareId}/files`, {
              headers,
            })
          ).json();
          const download = await fetch(
            `${content}/guest/shares/${shareId}/files/${listing.files[0].id}/content`,
            { headers },
          );
          assert.equal(download.status, 200);
          assert.equal(await download.text(), 'direct LAN transfer');
          events = await fetch(`${content}/guest/events`, {
            headers,
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(events.status, 200);
          assert.match(
            events.headers.get('content-type')!,
            /text\/event-stream/,
          );
          await events.body!.cancel();
          events = undefined;
          assert.equal(
            (await local(`/api/guest-links/${link.id}`, 'DELETE')).status,
            200,
          );
          assert.equal(
            (await fetch(`${content}/guest/catalog`, { headers })).status,
            401,
          );
          assert.deepEqual(
            await (await fetch(`${content}/guest/session`, { headers })).json(),
            { authenticated: false },
          );
          await stop(child);
          await assert.rejects(readFile(path.join(root, 'process.lock')), {
            code: 'ENOENT',
          });
          for (const origin of [content, dashboard])
            await assert.rejects(fetch(`${origin}/v1/health`));
        } finally {
          try {
            await events?.body?.cancel();
            await stop(child);
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        }
      });
    }
  },
);

test(
  'proxy-only CLI and Mac configuration keep the guest server off the LAN while preserving PIN access',
  { skip: !lan && 'No private IPv4 network interface is available' },
  async (t) => {
    assert.ok(lan);
    for (const mode of ['flag', 'mac']) {
      await t.test(mode, async () => {
        const root = await realpath(
          await mkdtemp(path.join(os.tmpdir(), 'p2pfs-proxy-only-')),
        );
        const transferPort = await availablePort();
        let managementPort = await availablePort();
        while (transferPort === managementPort)
          managementPort = await availablePort();
        const backend = `http://127.0.0.1:${transferPort}`;
        const guestUrl = `${backend}/apps/p2pfs`;
        await writeFile(
          path.join(root, 'host.json'),
          JSON.stringify({
            guestUrl,
            ...(mode === 'mac' ? { proxyOnly: true } : {}),
          }),
        );
        const child = spawn(
          process.execPath,
          [
            '--import',
            './dist/test/cli-tunnel-fixture.js',
            `dist/src/cli/${mode === 'mac' ? 'mac-host' : 'main'}.js`,
            '--state-dir',
            root,
            '--transfer-port',
            String(transferPort),
            '--management-port',
            String(managementPort),
            ...(mode === 'flag' ? ['--proxy-only', '--password-stdin'] : []),
          ],
          {
            env: { ...process.env, P2PFS_TEST_TUNNEL_FAILURE: '1' },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        let output = '';
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () =>
                reject(new Error(`Proxy-only startup timed out: ${output}`)),
              10_000,
            );
            const ready = (chunk: Buffer) => {
              output += chunk.toString();
              if (
                output.includes(`Proxy backend (loopback only): ${backend}`)
              ) {
                clearTimeout(timer);
                resolve();
              }
            };
            child.stdout.on('data', ready);
            child.stderr.on('data', ready);
            child.once('error', (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.once('exit', (code) => {
              clearTimeout(timer);
              reject(
                new Error(`Proxy-only publisher exited (${code}): ${output}`),
              );
            });
            if (mode === 'mac') child.stdin.write(`${password}\n`);
            else child.stdin.end(`${password}\n`);
          });
          assert.equal(output.includes('Synthetic tunnel start'), false);
          const local = await management(`http://127.0.0.1:${managementPort}`);
          const state = await (await local('/api/state')).json();
          assert.equal(state.proxyOnly, true);
          assert.equal(state.access, 'lan');
          for (const port of [transferPort, managementPort])
            await assert.rejects(
              fetch(`http://${lan}:${port}/receive`, {
                signal: AbortSignal.timeout(2000),
              }),
            );
          assert.equal((await fetch(`${guestUrl}/`)).status, 200);
          const created = await local('/api/guest-links', 'POST', {
            label: 'Proxy-only session',
          });
          assert.equal(created.status, 200);
          const link = await created.json();
          assert.equal(link.joinUrl, `${guestUrl}/receive`);
          const joined = await fetch(`${guestUrl}/guest/pin`, {
            method: 'POST',
            headers: { origin: backend, 'content-type': 'application/json' },
            body: JSON.stringify({ pin: link.pin }),
          });
          assert.equal(joined.status, 200);
          const setCookie = joined.headers.get('set-cookie')!;
          assert.match(setCookie, /Path=\/apps\/p2pfs\/guest;/);
          const catalog = await fetch(`${guestUrl}/guest/catalog`, {
            headers: { cookie: setCookie.split(';')[0]! },
          });
          assert.equal(catalog.status, 200);
          assert.equal((await catalog.json()).label, 'Proxy-only session');
        } finally {
          try {
            await stop(child);
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        }
      });
    }
  },
);

test('default LAN startup fails explicitly without a private interface and never starts a tunnel', async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'p2pfs-no-lan-')),
  );
  try {
    const command = promisify(execFile)(
      process.execPath,
      [
        '--import',
        './dist/test/cli-tunnel-fixture.js',
        'dist/src/cli/main.js',
        '--state-dir',
        root,
        '--password-stdin',
      ],
      {
        env: { ...process.env, P2PFS_TEST_NO_LAN: '1' },
        timeout: 10_000,
      },
    );
    let output = '';
    command.child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    command.child.stdin!.end(`${password}\n`);
    await assert.rejects(command, /No private IPv4 network address.*--tunnel/);
    assert.equal(output.includes('Synthetic tunnel start'), false);
    await assert.rejects(readFile(path.join(root, 'process.lock')), {
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publisher exits on tunnel prerequisite failure and releases its listeners and lock', async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'p2pfs-cli-failure-')),
  );
  const managementPort = await availablePort();
  let transferPort = await availablePort();
  while (transferPort === managementPort) transferPort = await availablePort();
  const child = spawn(
    process.execPath,
    [
      '--import',
      './dist/test/cli-tunnel-fixture.js',
      'dist/src/cli/main.js',
      '--state-dir',
      root,
      '--management-port',
      String(managementPort),
      '--transfer-port',
      String(transferPort),
      '--password-stdin',
      '--tunnel',
    ],
    {
      env: { ...process.env, P2PFS_TEST_TUNNEL_FAILURE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const exited = new Promise<number | null>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('CLI stayed running after tunnel failure')),
        10_000,
      );
      child.once('close', resolve);
      child.once('error', reject);
    });
    child.stdin.end(`${password}\n`);
    assert.equal(await exited, 1);
    assert.match(errors, /Synthetic tunnel prerequisite failure/);
    assert.ok(
      output.includes(`Synthetic tunnel start: ngrok on ${transferPort}`),
    );
    assert.equal(output.includes('Public endpoint:'), false);
    await assert.rejects(readFile(path.join(root, 'process.lock')), {
      code: 'ENOENT',
    });
    assert.deepEqual(
      JSON.parse(await readFile(path.join(root, 'host.json'), 'utf8')),
      { access: 'lan', provider: 'ngrok' },
    );
    for (const port of [managementPort, transferPort])
      await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/health`));
  } finally {
    clearTimeout(timer);
    try {
      await stop(child);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
