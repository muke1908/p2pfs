import { lookup } from 'node:dns/promises';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import ipaddr from 'ipaddr.js';
import { AppError } from './auth.js';

export interface TransportOptions {
  testLoopback?: boolean;
  allowedHosts?: string[];
}
export const tunnelHosts = [
  'devtunnels.ms',
  'ngrok.app',
  'ngrok-free.app',
  'ngrok.io',
  'ngrok-free.dev',
  'ngrok.dev',
  'zrok.io',
];

export function publicUrl(input: string, options: TransportOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AppError(400, 'Invalid public URL.');
  }
  const testLocal =
    options.testLoopback &&
    url.protocol === 'http:' &&
    url.hostname === '127.0.0.1';
  if (
    (!testLocal && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '') ||
    (!testLocal && url.port && url.port !== '443')
  )
    throw new AppError(
      400,
      'Public URLs must be HTTPS origins without credentials.',
    );
  if (
    options.allowedHosts?.length &&
    !options.allowedHosts.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    )
  )
    throw new AppError(400, 'Tunnel host is not allowed.');
  return url;
}

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  return ipaddr.process(address).range() === 'unicast';
}

export class Transport {
  constructor(readonly options: TransportOptions = {}) {}

  async request(
    origin: string,
    route: string,
    signal?: AbortSignal,
  ): Promise<IncomingMessage> {
    signal?.throwIfAborted();
    const base = publicUrl(origin, this.options);
    const addresses = await lookup(base.hostname, { all: true });
    signal?.throwIfAborted();
    const testLocal =
      this.options.testLoopback && base.hostname === '127.0.0.1';
    if (
      !addresses.length ||
      (!testLocal && addresses.some((a) => !isPublicAddress(a.address)))
    )
      throw new AppError(
        400,
        'Tunnel resolved to a non-public network address.',
      );
    const address = addresses[0]!;
    const url = new URL(route, base);
    if (url.origin !== base.origin)
      throw new AppError(400, 'Invalid API route.');
    return new Promise((resolve, reject) => {
      const client = base.protocol === 'http:' ? http : https;
      const request = client.request(
        url,
        {
          method: 'GET',
          signal,
          agent: false,
          family: address.family,
          lookup: (_host, _options, callback) =>
            callback(null, address.address, address.family),
          headers: {
            accept: 'application/json',
            'user-agent': 'p2pfs/1',
            'ngrok-skip-browser-warning': 'p2pfs',
            'x-tunnel-skip-antiphishing-page': 'true',
          },
        },
        (response) => {
          response.setTimeout(30_000, () =>
            response.destroy(new Error('Tunnel idle timeout.')),
          );
          if (
            (response.statusCode ?? 500) < 200 ||
            (response.statusCode ?? 500) >= 300
          ) {
            response.destroy();
            reject(
              new AppError(
                response.statusCode ?? 502,
                `Tunnel returned HTTP ${response.statusCode}; public endpoint verification failed.`,
              ),
            );
          } else resolve(response);
        },
      );
      request.setTimeout(30_000, () =>
        request.destroy(new Error('Tunnel connection timeout.')),
      );
      request.on('error', reject);
      request.end();
    });
  }

  async json<T>(
    origin: string,
    route: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.request(origin, route, signal);
    if (!response.headers['content-type']?.includes('application/json')) {
      response.destroy();
      throw new AppError(
        502,
        'Expected JSON; tunnel may require login or consent.',
      );
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 2 * 1024 * 1024) {
        response.destroy();
        throw new AppError(502, 'Tunnel response is too large.');
      }
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as T;
  }
}
