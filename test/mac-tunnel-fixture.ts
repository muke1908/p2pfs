import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Tunnel } from '../src/tunnels/manager.js';

let provider: ChildProcess | undefined;
let closed: Promise<void> | undefined;

Tunnel.prototype.start = async function () {
  const directory = process.argv[process.argv.indexOf('--state-dir') + 1]!;
  if (directory.endsWith('failure'))
    throw new Error('Synthetic provider login failure');
  provider = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  closed = new Promise((resolve) => provider!.once('close', resolve));
  provider.once('exit', () => {
    this.url = undefined;
    this.status = 'Tunnel exited';
  });
  await writeFile(
    path.join(directory, 'fixture-pids.json'),
    JSON.stringify({
      publisher: process.pid,
      provider: provider.pid,
      supervisor: process.ppid,
    }),
  );
  this.url = 'https://fixture.example.com';
  this.status = 'Ready';
  return this.url;
};

Tunnel.prototype.stop = async function () {
  provider?.kill('SIGTERM');
  await closed;
  this.status = 'Stopped';
  this.url = undefined;
};
