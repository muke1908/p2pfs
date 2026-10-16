import path from 'node:path';
import { mkdir, realpath, open, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { StateStore } from '../src/config/state.js';
import { Host } from '../src/host/app.js';
import { Transport } from '../src/security/transport.js';

// Synthetic local-only browser fixture; never enable test transport in the CLI.
const root = path.resolve('.p2pfs/browser-lab');
await mkdir(root, { recursive: true, mode: 0o700 });
const directory = await realpath(root);
const password = 'test-password-not-a-secret';
const store = await StateStore.open(path.join(directory, 'host'), password, {
  name: 'Synthetic source',
});
const host = new Host(store, {
  access: 'tunnel',
  transferPort: 17343,
  managementPort: 17344,
  transport: new Transport({ testLoopback: true }),
});
const cancelFile = path.join(directory, 'cancel.bin');
const handle = await open(cancelFile, 'w');
await handle.truncate(8 * 1024 * 1024);
await handle.close();
const collection = path.join(directory, 'collection');
await mkdir(path.join(collection, 'nested'), { recursive: true });
await Promise.all(
  Array.from({ length: 105 }, (_, i) =>
    writeFile(
      path.join(collection, `note-${String(i + 1).padStart(3, '0')}.txt`),
      `Synthetic file ${i + 1}\n`,
    ),
  ),
);
await writeFile(path.join(collection, '.hidden-note'), 'Hidden fixture\n');
await writeFile(
  path.join(collection, 'nested', 'inside.txt'),
  'Nested fixture\n',
);
const originalStream = host.shares.stream.bind(host.shares);
host.shares.stream = async (shareId, fileId) => {
  const result = await originalStream(shareId, fileId);
  if (result.file.name !== 'cancel.bin') return result;
  const source = result.stream;
  return {
    file: result.file,
    stream: Readable.from(
      (async function* () {
        try {
          for await (const chunk of source) {
            await delay(25);
            yield chunk;
          }
        } finally {
          source.destroy();
        }
      })(),
    ),
  };
};
const singleFolder = path.join(directory, 'one-file-folder');
await mkdir(singleFolder, { recursive: true });
await writeFile(
  path.join(singleFolder, 'only.txt'),
  'Synthetic single-child folder file.\n',
);
await host.listen();
for (const input of [
  path.resolve('test/browser-fixture.txt'),
  cancelFile,
  collection,
  singleFolder,
])
  if (!store.state.shares.some((share) => share.path === input))
    await host.shares.add(input);
console.log(`Host dashboard: ${host.managementUrl}`);
process.once('SIGTERM', () => void host.close());
process.once('SIGINT', () => void host.close());
