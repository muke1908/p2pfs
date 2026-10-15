import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Tunnel } from '../src/tunnels/manager.js';
import { Transport } from '../src/security/transport.js';

class SyntheticHealth extends Transport {
  override async json<T>(origin: string, route: string): Promise<T> {
    assert.equal(origin, 'https://fixture.example.com');
    assert.equal(route, '/v1/health');
    return { protocol: 1, id: 'fixture-host' } as T;
  }
}

async function executable(scenario: string) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'p2pfs-tunnel-fixture-'),
  );
  const filename = path.join(directory, `${scenario}.mjs`);
  await copyFile('dist/test/tunnel-worker.js', filename);
  await chmod(filename, 0o700);
  return { directory, filename };
}

for (const provider of ['devtunnel', 'zrok'] as const) {
  test(
    `${provider} adapter handles chunked output and stops only its owned process`,
    {
      skip: process.platform === 'win32',
      timeout: 10_000,
    },
    async () => {
      const fixture = await executable('ready');
      const tunnel = new Tunnel(new SyntheticHealth(), 'fixture-host', {
        [provider]: fixture.filename,
      });
      try {
        assert.equal(
          await tunnel.start(provider, 7331),
          'https://fixture.example.com',
        );
        const pid = Number(await readFile(`${fixture.filename}.pid`, 'utf8'));
        process.kill(pid, 0);
        await Promise.all([tunnel.stop(), tunnel.stop()]);
        assert.equal(tunnel.status, 'Stopped');
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      } finally {
        await tunnel.stop();
        await rm(fixture.directory, { recursive: true, force: true });
      }
    },
  );
}

test(
  'provider exits and spawn errors fail promptly instead of hanging shutdown',
  {
    skip: process.platform === 'win32',
    timeout: 10_000,
  },
  async () => {
    for (const scenario of ['exit', 'disappear']) {
      const fixture = await executable(scenario);
      const tunnel = new Tunnel(new SyntheticHealth(), 'fixture-host', {
        devtunnel: fixture.filename,
      });
      try {
        await assert.rejects(tunnel.start('devtunnel', 7331), /Failed/);
        assert.equal(tunnel.url, undefined);
      } finally {
        await tunnel.stop();
        await rm(fixture.directory, { recursive: true, force: true });
      }
    }
  },
);

test(
  'stop cancels provider prerequisite commands without waiting for their timeout',
  {
    skip: process.platform === 'win32',
    timeout: 10_000,
  },
  async () => {
    const fixture = await executable('slow');
    const tunnel = new Tunnel(new SyntheticHealth(), 'fixture-host', {
      devtunnel: fixture.filename,
    });
    try {
      const rejected = assert.rejects(tunnel.start('devtunnel', 7331));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await tunnel.stop();
      await rejected;
      assert.equal(tunnel.url, undefined);
    } finally {
      await tunnel.stop();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  },
);
