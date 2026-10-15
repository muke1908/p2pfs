import { fork, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

// The app holds stdin open. EOF also arrives when macOS kills the app.
const input = createInterface({ input: process.stdin });
let child: ChildProcess | undefined;
let stopping = false;
let forced: NodeJS.Timeout | undefined;

function killGroup(signal: NodeJS.Signals): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
      throw error;
  }
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  if (!child) {
    input.close();
    process.stdin.destroy();
    return;
  }
  child.kill('SIGTERM');
  forced = setTimeout(() => killGroup('SIGKILL'), 8000);
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') console.error(error.message);
  stop();
});
process.stderr.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') process.exitCode = 1;
  stop();
});
input.once('close', stop);
input.once('line', (password) => {
  if (stopping) return;
  child = fork(
    new URL('./main.js', import.meta.url),
    [...process.argv.slice(2), '--password-stdin'],
    {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    },
  );
  child.stdin!.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') console.error(error.message);
    stop();
  });
  child.stdin!.end(`${password}\n`);
  child.stdout!.on('data', (data: Buffer) => process.stderr.write(data));
  child.stderr!.on('data', (data: Buffer) => process.stderr.write(data));
  child.on('message', (message) => {
    if (!stopping) process.stdout.write(`${JSON.stringify(message)}\n`);
  });
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
    stop();
  });
  child.once('exit', () => {
    // Reap provider processes even if the publisher crashed before cleanup.
    killGroup('SIGTERM');
    clearTimeout(forced);
    forced = setTimeout(() => killGroup('SIGKILL'), 1000);
  });
  child.once('close', (code, signal) => {
    clearTimeout(forced);
    killGroup('SIGKILL');
    process.exitCode = stopping ? 0 : (code ?? (signal ? 1 : 0));
    stopping = true;
    input.close();
    process.stdin.destroy();
  });
});
