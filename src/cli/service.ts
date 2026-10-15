import { Command } from 'commander';
import { execFile, spawn } from 'node:child_process';
import {
  link,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { defaultStateDir, isMissing } from '../config/state.js';
import { verifyPassword } from '../security/auth.js';

const execute = promisify(execFile);
const label = 'io.github.muke1908.p2pfs';
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const xml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });

export function launchAgent(options: {
  node: string;
  publisher: string;
  directory: string;
  stateDir: string;
  account: string;
  searchPath: string;
}): string {
  const command = [
    `/usr/bin/security find-generic-password -a ${shellQuote(options.account)} -s ${shellQuote(label)} -w`,
    `exec ${shellQuote(options.node)} ${shellQuote(options.publisher)} --state-dir "$P2PFS_STATE_DIR" --password-stdin`,
  ].join(' | ');
  const logDirectory = path.join(options.stateDir, 'service-logs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>-o</string><string>pipefail</string><string>-c</string><string>${xml(command)}</string></array>
  <key>WorkingDirectory</key><string>${xml(options.directory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(options.searchPath)}</string>
    <key>P2PFS_STATE_DIR</key><string>${xml(options.stateDir)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>20</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(path.join(logDirectory, 'host.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logDirectory, 'host-error.log'))}</string>
</dict>
</plist>
`;
}

function environment() {
  if (process.platform !== 'darwin')
    throw new Error('Host service commands require macOS.');
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0)
    throw new Error('Run this as your logged-in user, without sudo.');
  return {
    domain: `gui/${uid}`,
    target: `gui/${uid}/${label}`,
    filename: path.join(
      os.homedir(),
      'Library',
      'LaunchAgents',
      `${label}.plist`,
    ),
    account: os.userInfo().username,
  };
}

async function loaded(target: string): Promise<boolean> {
  try {
    await execute('/bin/launchctl', ['print', target]);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 113)
      return false;
    throw error;
  }
}

async function requireStopped(stateDir: string): Promise<void> {
  let value: string;
  try {
    value = await readFile(path.join(stateDir, 'process.lock'), 'utf8');
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error(
      'Invalid host process lock; inspect it before installing or starting the service.',
    );
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
      return;
    throw error;
  }
  throw new Error(
    `A publisher is already running with PID ${pid}. Stop it before installing or starting the service.`,
  );
}

async function promptKeychain(account: string): Promise<void> {
  if (!process.stdin.isTTY)
    throw new Error(
      'Install from an interactive terminal so macOS can securely prompt for the host password.',
    );
  console.log(
    'Enter your existing p2pfs host password at the Keychain prompt.',
  );
  await new Promise<void>((resolve, reject) => {
    // With -w last and no value, security prompts without exposing the password in argv.
    const child = spawn(
      '/usr/bin/security',
      [
        'add-generic-password',
        '-U',
        '-a',
        account,
        '-s',
        label,
        '-l',
        'p2pfs host password',
        '-w',
      ],
      { stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Keychain setup failed (${code ?? 'signal'}).`));
    });
  });
}

async function install(stateDir: string): Promise<void> {
  const env = environment();
  if (await loaded(env.target))
    throw new Error(
      'The host service is loaded. Uninstall it before reinstalling.',
    );
  try {
    await readFile(env.filename);
    throw new Error(
      'A host service is already installed. Uninstall it before reinstalling.',
    );
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const directory = await realpath(path.resolve(stateDir));
  await requireStopped(directory);
  const state: unknown = JSON.parse(
    await readFile(path.join(directory, 'state.json'), 'utf8'),
  );
  if (
    !state ||
    typeof state !== 'object' ||
    !('verifier' in state) ||
    typeof state.verifier !== 'string'
  )
    throw new Error(
      'Run npm run publisher successfully first, then stop it before installing the service.',
    );
  const repository = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts') ? '../../' : '../../../',
      import.meta.url,
    ),
  );
  const publisher = path.join(repository, 'dist', 'src', 'cli', 'main.js');
  await readFile(publisher);
  await promptKeychain(env.account);
  const credential = await execute('/usr/bin/security', [
    'find-generic-password',
    '-a',
    env.account,
    '-s',
    label,
    '-w',
  ]);
  if (
    !(await verifyPassword(
      credential.stdout.replace(/\r?\n$/, ''),
      state.verifier,
    ))
  )
    throw new Error(
      'The Keychain password does not match this host. Run install again and enter the correct password.',
    );
  await mkdir(path.dirname(env.filename), { recursive: true, mode: 0o700 });
  await mkdir(path.join(directory, 'service-logs'), {
    recursive: true,
    mode: 0o700,
  });
  const contents = launchAgent({
    node: process.execPath,
    publisher,
    directory: repository,
    stateDir: directory,
    account: env.account,
    searchPath: [
      path.dirname(process.execPath),
      process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    ].join(path.delimiter),
  });
  const temporary = `${env.filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    // Publish a complete plist atomically without replacing an existing installation.
    await link(temporary, env.filename);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(
    `Installed: ${env.filename}\nLogs: ${path.join(directory, 'service-logs')}\nRun npm run host-service -- start now, or it will start at your next login.`,
  );
}

async function start(): Promise<void> {
  const env = environment();
  if (await loaded(env.target))
    throw new Error(
      'The host service is already loaded. Use status to inspect it, or stop then start to restart.',
    );
  const result = await execute('/usr/bin/plutil', [
    '-extract',
    'EnvironmentVariables.P2PFS_STATE_DIR',
    'raw',
    '-o',
    '-',
    env.filename,
  ]);
  await requireStopped(result.stdout.replace(/\r?\n$/, ''));
  await execute('/bin/launchctl', ['enable', env.target]);
  await execute('/bin/launchctl', ['bootstrap', env.domain, env.filename]);
  console.log(
    'Host service loaded. Use status and the service logs to check tunnel readiness.',
  );
}

async function stop(): Promise<void> {
  const env = environment();
  if (await loaded(env.target)) {
    await execute('/bin/launchctl', ['bootout', env.target]);
    console.log(
      'Host service unloaded. It will start again at your next login.',
    );
  } else console.log('Host service is not loaded.');
}

async function status(): Promise<void> {
  const env = environment();
  if (!(await loaded(env.target))) {
    console.log('Host service is not loaded. Run start if installed.');
    return;
  }
  const result = await execute('/bin/launchctl', ['print', env.target]);
  process.stdout.write(result.stdout);
}

async function uninstall(): Promise<void> {
  const env = environment();
  await stop();
  await rm(env.filename, { force: true });
  try {
    await execute('/usr/bin/security', [
      'delete-generic-password',
      '-a',
      env.account,
      '-s',
      label,
    ]);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 44))
      throw error;
  }
  console.log(
    'Host service and its Keychain password removed. Shares, settings, original files, and logs are unchanged.',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const cli = new Command()
    .name('p2pfs-host-service')
    .description('Manage a per-user macOS publisher LaunchAgent');
  cli
    .command('install')
    .option(
      '--state-dir <path>',
      'Existing publisher state directory',
      defaultStateDir(),
    )
    .action(async (options: { stateDir: string }) => install(options.stateDir));
  cli.command('start').action(start);
  cli.command('stop').action(stop);
  cli.command('status').action(status);
  cli.command('uninstall').action(uninstall);
  try {
    await cli.parseAsync();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
