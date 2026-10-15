import { Tunnel } from '../src/tunnels/manager.js';

// Preloaded only by CLI tests; no provider process or public connection is used.
Tunnel.prototype.start = async function (provider, port) {
  console.log(`Synthetic tunnel start: ${provider} on ${port}`);
  if (process.env.P2PFS_TEST_TUNNEL_FAILURE)
    throw new Error('Synthetic tunnel prerequisite failure');
  this.url = 'https://fixture.example.com';
  this.status = 'Ready';
  return this.url;
};
