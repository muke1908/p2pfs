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

test('publisher CLI starts without registry setup and rejects removed commands', async () => {
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
  await writeFile(path.join(root, 'host.json'), '{"provider":"devtunnel"}\n');
  const managementPort = await availablePort();
  let transferPort = await availablePort();
  while (transferPort === managementPort) transferPort = await availablePort();
  const child = spawn(
    process.execPath,
    [
      'dist/src/cli/main.js',
      '--state-dir',
      root,
      '--management-port',
      String(managementPort),
      '--transfer-port',
      String(transferPort),
      '--no-tunnel',
      '--password-stdin',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
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
        if (output.includes('Public tunnel disabled.')) {
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
    assert.equal(state.guestOrigin, undefined);
    assert.equal(
      (await local('/api/guest-links', 'POST', { label: 'Not public yet' }))
        .status,
      409,
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
