import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { launchAgent } from '../src/cli/service.js';

const execute = promisify(execFile);

test(
  'macOS service keeps paths intact and pipes Keychain credentials without putting them in arguments',
  {
    skip: process.platform !== 'darwin',
  },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'p2pfs-service-'));
    try {
      const directory = path.join(root, "host's & files");
      await mkdir(directory);
      const publisher = path.join(directory, 'publisher.js');
      const stateDir = path.join(directory, 'state $HOME');
      const account = "test's $(do-not-execute) & user";
      const filename = path.join(root, 'agent.plist');
      const searchPath = `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`;
      const contents = launchAgent({
        node: process.execPath,
        publisher,
        directory,
        stateDir,
        account,
        searchPath,
      });
      await writeFile(filename, contents);
      await execute('/usr/bin/plutil', ['-lint', filename]);
      const converted = await execute('/usr/bin/plutil', [
        '-convert',
        'json',
        '-o',
        '-',
        filename,
      ]);
      const plist = JSON.parse(converted.stdout);
      assert.equal(plist.WorkingDirectory, directory);
      assert.deepEqual(plist.EnvironmentVariables, {
        PATH: searchPath,
        P2PFS_STATE_DIR: stateDir,
      });
      assert.equal(
        plist.StandardErrorPath,
        path.join(stateDir, 'service-logs', 'host-error.log'),
      );
      assert.equal(plist.KeepAlive, true);
      assert.equal(plist.RunAtLoad, true);
      assert.equal(plist.Umask, 0o77);

      const credentialFile = path.join(root, 'credential-args.json');
      const credentialCommand = path.join(root, 'security');
      await writeFile(
        credentialCommand,
        `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.P2PFS_TEST_CREDENTIAL_ARGS, JSON.stringify(process.argv.slice(2)));
if (process.env.P2PFS_TEST_CREDENTIAL_FAILURE) process.exit(44);
process.stdout.write('test-password-not-a-secret\\n');
`,
        { mode: 0o700 },
      );
      await writeFile(
        publisher,
        `let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => console.log(JSON.stringify({args: process.argv.slice(2), input})));
`,
      );
      const [executable, ...args] = plist.ProgramArguments as string[];
      const command = args.at(-1)!;
      args[args.length - 1] = command.replace(
        '/usr/bin/security',
        credentialCommand,
      );
      const env = {
        ...process.env,
        ...plist.EnvironmentVariables,
        P2PFS_TEST_CREDENTIAL_ARGS: credentialFile,
      };
      const result = await execute(executable!, args, { env });
      assert.deepEqual(JSON.parse(result.stdout), {
        args: ['--state-dir', stateDir, '--password-stdin'],
        input: 'test-password-not-a-secret\n',
      });
      assert.deepEqual(JSON.parse(await readFile(credentialFile, 'utf8')), [
        'find-generic-password',
        '-a',
        account,
        '-s',
        plist.Label,
        '-w',
      ]);
      assert.equal(contents.includes('test-password-not-a-secret'), false);
      assert.equal(result.stderr, '');
      await assert.rejects(
        execute(executable!, args, {
          env: { ...env, P2PFS_TEST_CREDENTIAL_FAILURE: '1' },
        }),
        { code: 44 },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
