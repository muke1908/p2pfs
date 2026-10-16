import os from 'node:os';
import { isIPv4 } from 'node:net';
import ipaddr from 'ipaddr.js';

export function isPrivateIPv4(input: string): boolean {
  return isIPv4(input) && ipaddr.parse(input).range() === 'private';
}

export function parseGuestUrl(input: string): string {
  const url = URL.parse(input);
  if (
    !url ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^(\/[a-zA-Z0-9_-]+)*\/?$/.test(url.pathname)
  )
    throw new Error(
      'Guest URL must be an HTTP(S) address with an optional simple path prefix, without credentials, query, or fragment.',
    );
  return url.href.replace(/\/$/, '');
}

export function lanAddress(input?: string): string {
  if (input !== undefined && !isPrivateIPv4(input))
    throw new Error('LAN sharing requires a private IPv4 address.');
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter(
      (entry): entry is os.NetworkInterfaceInfo =>
        entry !== undefined &&
        entry.family === 'IPv4' &&
        !entry.internal &&
        isPrivateIPv4(entry.address),
    );
  const address =
    input ??
    (
      addresses.find((entry) => entry.mac !== '00:00:00:00:00:00') ??
      addresses[0]
    )?.address;
  if (address === undefined)
    throw new Error(
      'No private IPv4 network address is available. Connect to your LAN, or explicitly select tunnel mode with --tunnel or "access": "tunnel" in host.json.',
    );
  if (!addresses.some((entry) => entry.address === address))
    throw new Error(
      `LAN address ${address} is not assigned to this computer. Choose its current private IPv4 address and try again.`,
    );
  return address;
}
