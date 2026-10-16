#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
import { open, readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { StateStore, defaultStateDir, isMissing } from '../config/state.js';
import { lanAddress, parseGuestUrl } from '../config/network.js';
import { Host } from '../host/app.js';
import { AppError } from '../security/auth.js';
import { publicUrl, Transport } from '../security/transport.js';

interface StartOptions {
  stateDir: string;
  name?: string;
  transferPort?: number;
  managementPort: number;
  passwordStdin?: boolean;
  publicUrl?: string;
  allowHost?: string[];
  lan?: string;
  tunnel?: boolean;
  guestUrl?: string;
}

function port(input: string): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new InvalidArgumentError('Port must be between 1 and 65535.');
  return value;
}

async function passwordFromInput(stdin: boolean): Promise<string> {
  if (stdin) {
    let value = '';
    for await (const chunk of process.stdin) {
      value += String(chunk);
      if (value.length > 1026)
        throw new AppError(400, 'Password input is too long.');
    }
    return value.replace(/\r?\n$/, '');
  }
  if (!process.stdin.isTTY)
    throw new Error(
      'Use a terminal password prompt or explicit --password-stdin.',
    );
  process.stdout.write('Host password (at least 12 characters): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') {
          finish(new Error('Password prompt cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
        if (value.length > 1024) {
          finish(new Error('Password input is too long.'));
          return;
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

async function acquireLock(directory: string): Promise<() => Promise<void>> {
  const filename = path.join(directory, 'process.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(filename, 'wx', 0o600);
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      return async () => {
        await rm(filename, { force: true });
      };
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error;
      const pid = Number(await readFile(filename, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error('Invalid process lock; inspect it before removal.');
      try {
        process.kill(pid, 0);
      } catch (check) {
        if (!(
          check instanceof Error &&
          'code' in check &&
          check.code === 'ESRCH'
        ))
          throw check;
        await rm(filename);
        continue;
      }
      throw new Error(`This state directory is already in use by PID ${pid}.`);
    }
  }
  throw new Error('Unable to acquire state-directory lock.');
}

async function start(options: StartOptions): Promise<void> {
  let host: Host | undefined;
  let unlock: (() => Promise<void>) | undefined;
  let statusTimer: NodeJS.Timeout | undefined;
  const startup = new AbortController();
  let signal: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const onSignal = () => {
    signal?.();
    startup.abort();
    void host?.tunnel.stop().catch((error: unknown) => {
      console.error(
        `Tunnel shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('disconnect', onSignal);
  if (process.send && !process.connected) onSignal();
  try {
    if (options.publicUrl) publicUrl(options.publicUrl);
    const password = await passwordFromInput(Boolean(options.passwordStdin));
    startup.signal.throwIfAborted();
    const directory = path.resolve(options.stateDir);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    unlock = await acquireLock(directory);
    const initial: Parameters<typeof StateStore.open>[2] = {};
    if (options.name) initial.name = options.name;
    if (options.allowHost || options.publicUrl) {
      initial.allowedHosts = [
        ...(options.allowHost ?? []),
        ...(options.publicUrl ? [new URL(options.publicUrl).hostname] : []),
      ];
      if (initial.allowedHosts.some((host) => !/^[a-z0-9.-]+$/.test(host)))
        throw new Error('Allowed hosts must be lowercase DNS hostnames.');
    }
    const store = await StateStore.open(directory, password, initial);
    startup.signal.throwIfAborted();
    console.log(
      `Host configuration: ${path.join(directory, 'host.json')} (edit and restart to change connection settings)`,
    );
    host = new Host(store, {
      managementPort: options.managementPort,
      transferPort: options.transferPort,
      publicUrl: options.publicUrl,
      lanAddress: options.lan,
      access: options.tunnel ? 'tunnel' : undefined,
      guestUrl: options.guestUrl,
    });
    await host.listen();
    startup.signal.throwIfAborted();
    console.log(`Local dashboard: ${host.managementUrl}`);
    console.log(
      'Open Guest links in the dashboard to create a private receiving link. Recipients only need a browser.',
    );
    for (const warning of host.state().warnings)
      console.error(`Warning: ${warning}`);
    const report = () => {
      if (!process.connected || !process.send) return;
      process.send(
        {
          status: host!.state().tunnel.status,
          dashboard: host!.managementUrl,
        },
        (error) => {
          if (error) onSignal();
        },
      );
    };
    if (process.send) {
      statusTimer = setInterval(report, 1000);
      report();
    }
    if (host.state().access === 'lan') {
      console.log(`LAN endpoint: ${host.transferUrl}`);
      console.error(
        'LAN sharing uses unencrypted HTTP. Only share on a trusted private network. No tunnel is started.',
      );
    } else if (options.publicUrl) {
      const transport = new Transport();
      const health = await transport.json<{ id: string; protocol: number }>(
        options.publicUrl,
        '/v1/health',
        startup.signal,
      );
      if (health.id !== store.state.id || health.protocol !== 1)
        throw new Error('Public URL points to a different service.');
      console.log(`Public endpoint: ${options.publicUrl} (externally managed)`);
    } else {
      await host.startTunnel();
      console.log(`Public endpoint: ${host.tunnel.url}`);
    }
    report();
    await stopped;
  } finally {
    clearInterval(statusTimer);
    try {
      await host?.close();
    } finally {
      try {
        await unlock?.();
      } finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        process.off('disconnect', onSignal);
        if (process.connected) process.disconnect();
      }
    }
  }
}

const cli = new Command()
  .name('p2pfs')
  .description(
    'Share local files and text on your LAN by default, or through an explicit tunnel',
  )
  .version('0.1.0')
  .allowExcessArguments(false)
  .option(
    '--state-dir <path>',
    'Installation state directory',
    defaultStateDir(),
  )
  .option('--name <name>', 'Publisher display name')
  .option('--management-port <port>', 'Loopback dashboard port', port, 7332)
  .option(
    '--password-stdin',
    'Read the host password from stdin for automation',
  )
  .option('--allow-host <domain...>', 'Additional trusted tunnel DNS hosts')
  .action(async (_options, current: Command) =>
    start(current.opts<StartOptions>()),
  );
cli
  .option('--transfer-port <port>', 'Content server port', port, 7331)
  .option(
    '--guest-url <url>',
    'LAN reverse proxy guest address, including an optional path prefix',
    parseGuestUrl,
  )
  .addOption(
    new Option(
      '--lan <ipv4>',
      'Choose a private LAN IPv4 address (default: auto-detected)',
    )
      .argParser(lanAddress)
      .conflicts(['tunnel', 'publicUrl']),
  )
  .option('--tunnel', 'Use the configured public tunnel instead of LAN sharing')
  .option(
    '--public-url <url>',
    'Use an externally managed, verified HTTPS endpoint',
  );

try {
  await cli.parseAsync();
} catch (error) {
  if (isMissing(error))
    console.error(
      'Missing local state or executable; install/configure the selected tunnel CLI.',
    );
  else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
