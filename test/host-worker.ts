import path from 'node:path';
import { StateStore } from '../src/config/state.js';
import { Host } from '../src/host/app.js';
import { Transport } from '../src/security/transport.js';

const directory = process.argv[2]!;
const password = 'test-password-not-a-secret';
const store = await StateStore.open(path.join(directory, 'state'), password);
const host = new Host(store, {
  transferPort: 0,
  managementPort: 0,
  transport: new Transport({ testLoopback: true }),
});
await host.listen();
const ready = {
  id: store.state.id,
  transferUrl: host.transferUrl,
  managementUrl: host.managementUrl,
  stateDirectory: store.directory,
};
if (process.send) process.send(ready);
else console.log(`Dashboard: ${host.managementUrl}`);
let stopped = false;
const shutdown = () => {
  if (stopped) return;
  stopped = true;
  void host.close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
process.once('disconnect', shutdown);
