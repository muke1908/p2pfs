import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { availablePort } from '../src/tunnels/manager.js';

const password = 'native-app-test-password';

async function until(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(message);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
      return false;
    throw error;
  }
}

test(
  'native Mac controller owns publisher and tunnel lifecycle',
  {
    skip: process.platform !== 'darwin',
    timeout: 120_000,
  },
  async (t) => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'p2pfs-mac-')),
    );
    const executable = path.join(root, 'controller');
    let crashedHostId: string | undefined;
    try {
      await promisify(execFile)('xcrun', [
        'swiftc',
        '-swift-version',
        '5',
        'macos/HostSession.swift',
        'test/macos/main.swift',
        '-o',
        executable,
      ]);
      for (const mode of [
        'stop',
        'app-crash',
        'supervisor-crash',
        'publisher-crash',
        'restart',
        'failure',
      ]) {
        await t.test(mode, async () => {
          const directory = path.join(
            root,
            mode === 'restart' ? 'publisher-crash' : mode,
          );
          const managementPort = await availablePort();
          let transferPort = await availablePort();
          while (transferPort === managementPort)
            transferPort = await availablePort();
          const node = path.join(root, `${mode}-node`);
          const quote = (value: string) =>
            `'${value.replaceAll("'", "'\\''")}'`;
          await writeFile(
            node,
            `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(path.resolve('dist/test/mac-tunnel-fixture.js'))} "$@" --management-port ${managementPort} --transfer-port ${transferPort}\n`,
            { mode: 0o700 },
          );
          const configuration = path.join(root, `${mode}.json`);
          await writeFile(
            configuration,
            JSON.stringify({
              node,
              root: process.cwd(),
              path: process.env.PATH,
              stateDirectory: directory,
            }),
          );
          const child = spawn(executable, [configuration], {
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let output = '';
          let errors = '';
          child.stdout.on('data', (data: Buffer) => {
            output += data.toString();
          });
          child.stderr.on('data', (data: Buffer) => {
            errors += data.toString();
          });
          const exited = new Promise<number | null>((resolve, reject) => {
            child.once('close', resolve);
            child.once('error', reject);
          });
          let pids:
            | { publisher: number; provider: number; supervisor: number }
            | undefined;
          try {
            child.stdin.write(`${password}\n`);
            if (mode === 'failure') {
              await until(
                async () => child.exitCode !== null,
                'Startup failure did not reach the app',
              );
              assert.equal(await exited, 1);
              assert.match(errors, /Synthetic provider login failure/);
            } else {
              await until(async () => {
                assert.equal(child.exitCode, null, errors);
                return output.includes('Ready');
              }, `Native app never became ready: ${errors}`);
              pids = JSON.parse(
                await readFile(
                  path.join(directory, 'fixture-pids.json'),
                  'utf8',
                ),
              ) as typeof pids;
              assert.ok(pids);
              const health = await fetch(
                `http://127.0.0.1:${transferPort}/v1/health`,
              );
              assert.equal(health.status, 200);
              const { id } = await health.json();
              if (mode === 'publisher-crash') crashedHostId = id;
              if (mode === 'restart') assert.equal(id, crashedHostId);
              const login = await fetch(
                `http://127.0.0.1:${managementPort}/api/login`,
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ password }),
                },
              );
              assert.equal(login.status, 200);
              if (mode === 'stop') {
                const duplicate = promisify(execFile)(
                  executable,
                  [configuration],
                  { timeout: 10_000 },
                );
                duplicate.child.stdin!.write(`${password}\n`);
                await assert.rejects(duplicate, /already in use by PID/);
                assert.equal(alive(pids.publisher), true);
                assert.equal(alive(pids.provider), true);
                process.kill(pids.provider, 'SIGTERM');
                await until(
                  async () => output.includes('Tunnel exited'),
                  'Native status did not reflect tunnel exit',
                );
                child.stdin.write('stop\n');
              } else if (mode === 'restart') child.stdin.write('stop\n');
              else if (mode === 'app-crash') child.kill('SIGKILL');
              else
                process.kill(
                  mode === 'supervisor-crash'
                    ? pids.supervisor
                    : pids.publisher,
                  'SIGKILL',
                );
              await until(
                async () =>
                  child.exitCode !== null || child.signalCode !== null,
                'Native controller failed to exit',
              );
              const code = await exited;
              if (mode === 'stop' || mode === 'restart')
                assert.equal(code, 0, errors);
              if (mode === 'publisher-crash' || mode === 'supervisor-crash')
                assert.notEqual(code, 0);
              await until(
                async () =>
                  !alive(pids!.publisher) &&
                  !alive(pids!.provider) &&
                  !alive(pids!.supervisor),
                'Owned process survived app shutdown/crash',
              );
            }
            if (mode !== 'publisher-crash') {
              await assert.rejects(
                readFile(path.join(directory, 'process.lock')),
                { code: 'ENOENT' },
              );
            }
            for (const port of [managementPort, transferPort])
              await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/health`));
            assert.equal(errors.includes(password), false);
          } finally {
            if (child.exitCode === null && child.signalCode === null)
              child.kill('SIGKILL');
            if (pids) {
              for (const pid of Object.values(pids))
                if (alive(pid)) process.kill(pid, 'SIGKILL');
            }
            await exited;
          }
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
