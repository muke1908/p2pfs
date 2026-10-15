import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { Provider } from '../config/state.js';
import { AppError } from '../security/auth.js';
import { Transport, publicUrl } from '../security/transport.js';

const execute = promisify(execFile);

export function parseEndpoint(
  provider: Provider,
  output: string,
): string | undefined {
  // eslint-disable-next-line no-control-regex
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const match =
    provider === 'devtunnel'
      ? /Hosting port \d+ at (https:\/\/[^\s"'<>]+)/i.exec(clean)
      : /https:\/\/[a-z0-9][a-z0-9.-]*(?::443)?(?:\/[^\s"'<>]*)?/i.exec(
          clean.split(
            'access your zrok share at the following endpoints:',
          )[1] ?? '',
        );
  if (!match) return undefined;
  const value = provider === 'devtunnel' ? match[1]! : match[0];
  return publicUrl(value.replace(/[),;]+$/, '')).origin;
}

export async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Failed to allocate port.');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

export class Tunnel {
  status = 'Stopped';
  url?: string;
  version?: string;
  private child?: ChildProcess;
  private directory?: string;
  private starting = false;
  private stopping = false;
  private startup?: AbortController;
  private childClosed?: Promise<void>;
  private stopTask?: Promise<void>;
  constructor(
    private transport: Transport,
    private hostId: string,
    private binaries: Partial<Record<Provider, string>> = {},
  ) {}

  async start(provider: Provider, port: number): Promise<string> {
    if (this.child || this.starting || this.stopTask)
      throw new AppError(409, 'Tunnel already running or starting.');
    this.starting = true;
    this.status = 'Checking prerequisites';
    this.stopping = false;
    const startup = new AbortController();
    this.startup = startup;
    let executable: string = this.binaries[provider] ?? provider;
    try {
      await this.cleanupConfiguration();
      if (provider === 'zrok' && !this.binaries.zrok) {
        try {
          await execute('zrok', ['version'], {
            timeout: 10_000,
            signal: startup.signal,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            executable = 'zrok2';
          else throw error;
        }
      }
      const version = await execute(
        executable,
        [provider === 'devtunnel' ? '--version' : 'version'],
        { timeout: 10_000, signal: startup.signal },
      );
      this.version = version.stdout.trim().split('\n')[0];
      let args: string[];
      let apiPort: number | undefined;
      if (provider === 'devtunnel') {
        const user = await execute(executable, ['user', 'show'], {
          timeout: 10_000,
          signal: startup.signal,
        });
        if (/not logged in/i.test(user.stdout + user.stderr))
          throw new Error(
            'Run devtunnel user login before starting this provider.',
          );
        args = ['host', '-p', String(port), '--allow-anonymous'];
      } else if (provider === 'zrok') {
        const help = await execute(executable, ['share', 'public', '--help'], {
          timeout: 10_000,
          signal: startup.signal,
        });
        if (!help.stdout.includes('--headless'))
          throw new Error('Unsupported zrok CLI: --headless is required.');
        args = ['share', 'public', '--headless', `http://127.0.0.1:${port}`];
        if (
          !help.stdout.includes('--force-local') ||
          !help.stdout.includes('--open')
        )
          throw new Error('Unsupported zrok public share contract.');
        args.push('--force-local', '--open');
      } else {
        const check = await execute(executable, ['config', 'check'], {
          timeout: 10_000,
          signal: startup.signal,
        });
        const filename = /Valid configuration file at (.+)/
          .exec(check.stdout)?.[1]
          ?.trim();
        if (!filename)
          throw new Error(
            'Run ngrok config check and configure the agent first.',
          );
        const text = await readFile(filename, 'utf8');
        const configVersion = /^version:\s*["']?([23])["']?\s*$/m.exec(
          text,
        )?.[1];
        if (!configVersion)
          throw new Error('ngrok config must use version 2 or 3.');
        apiPort = await availablePort();
        this.directory = await mkdtemp(path.join(os.tmpdir(), 'p2pfs-ngrok-'));
        const override = path.join(this.directory, 'agent.yml');
        await writeFile(
          override,
          configVersion === '3'
            ? `version: 3\nagent:\n  web_addr: 127.0.0.1:${apiPort}\n  inspect_db_size: 0\n`
            : `version: 2\nweb_addr: 127.0.0.1:${apiPort}\ninspect_db_size: 0\n`,
          { mode: 0o600 },
        );
        args = [
          'http',
          `http://127.0.0.1:${port}`,
          '--config',
          filename,
          '--config',
          override,
          '--log=stdout',
          '--log-format=json',
          '--inspect=false',
        ];
      }
      if (this.stopping) throw new Error('Tunnel startup cancelled.');
      this.status = 'Starting tunnel';
      const child = spawn(executable, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      this.childClosed = new Promise<void>((resolve) =>
        child.once('close', () => {
          if (this.child === child) this.child = undefined;
          resolve();
        }),
      );
      let output = '';
      let processError: Error | undefined;
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16_384);
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.once('error', (error) => {
        processError = error;
      });
      child.once('exit', (code) => {
        this.url = undefined;
        if (!this.stopping) {
          this.status = `Tunnel exited (${code ?? 'signal'}); check provider login/quota and restart.`;
        }
      });
      let lastProbe = '';
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (this.stopping) throw new Error('Tunnel startup cancelled.');
        if (processError) throw processError;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(
            'Tunnel exited before readiness. Check provider login, quota, and configured endpoint.',
          );
        let origin: string | undefined;
        if (apiPort) {
          try {
            const response = await fetch(
              `http://127.0.0.1:${apiPort}/api/endpoints`,
              {
                signal: AbortSignal.any([
                  startup.signal,
                  AbortSignal.timeout(1000),
                ]),
              },
            );
            const result = (await response.json()) as {
              endpoints?: { url?: string; upstream?: { url?: string } }[];
            };
            const endpoint = result.endpoints?.find(
              (item) => item.upstream?.url === `http://127.0.0.1:${port}`,
            );
            if (endpoint?.url) origin = publicUrl(endpoint.url).origin;
          } catch (error) {
            lastProbe = error instanceof Error ? error.message : String(error);
          }
        } else {
          origin = parseEndpoint(provider, output);
        }
        if (origin) {
          try {
            const health = await this.transport.json<{
              protocol: number;
              id: string;
            }>(
              origin,
              '/v1/health',
              AbortSignal.any([startup.signal, AbortSignal.timeout(5000)]),
            );
            if (health.protocol !== 1 || health.id !== this.hostId)
              throw new Error('Public endpoint does not belong to this host.');
            if (this.stopping) throw new Error('Tunnel startup cancelled.');
            this.url = origin;
            this.status = 'Ready';
            return origin;
          } catch (error) {
            lastProbe = error instanceof Error ? error.message : String(error);
          }
        }
        await delay(1000, undefined, { signal: startup.signal });
      }
      throw new Error(`Tunnel readiness timed out. ${lastProbe}`);
    } catch (error) {
      await this.stop();
      const reason =
        error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? `Install the ${provider} CLI (zrok or zrok2 for zrok) and authenticate it before starting.`
          : error instanceof Error
            ? error.message
            : String(error);
      this.status = `Failed: ${reason}`;
      throw new AppError(502, this.status);
    } finally {
      this.starting = false;
      this.startup = undefined;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.startup?.abort();
    this.stopTask ??= this.stopProcess().finally(() => {
      this.stopTask = undefined;
    });
    await this.stopTask;
  }

  private async stopProcess(): Promise<void> {
    const child = this.child;
    if (child) {
      if (child.pid && child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM');
      const forced = setTimeout(() => {
        if (child.pid && child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      }, 5000);
      try {
        await this.childClosed;
      } finally {
        clearTimeout(forced);
      }
    }
    this.child = undefined;
    this.childClosed = undefined;
    this.url = undefined;
    await this.cleanupConfiguration();
    this.status = 'Stopped';
  }

  private async cleanupConfiguration(): Promise<void> {
    const directory = this.directory;
    if (!directory) return;
    this.directory = undefined;
    try {
      await rm(path.join(directory, 'agent.yml'), { force: true });
      await rmdir(directory);
    } catch (error) {
      this.directory ??= directory;
      throw error;
    }
  }
}
