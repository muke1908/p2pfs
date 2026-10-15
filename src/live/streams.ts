import type { ServerResponse } from 'node:http';
import type { FastifyReply } from 'fastify';
import { AppError } from '../security/auth.js';

export interface LiveUpdate {
  state?: boolean;
  catalog?: boolean;
}

export class LiveHub {
  private clients = new Map<ServerResponse, () => boolean>();
  private heartbeat?: NodeJS.Timeout;

  connect(reply: FastifyReply, authorized: () => boolean): void {
    if (this.clients.size >= 128)
      throw new AppError(429, 'Live connection limit reached.');
    reply.hijack();
    const response = reply.raw;
    for (const [name, value] of Object.entries(reply.getHeaders()))
      if (value !== undefined) response.setHeader(name, value);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    this.clients.set(response, authorized);
    response.on('close', () => {
      this.clients.delete(response);
      if (!this.clients.size) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }
    });
    response.on('error', () => response.destroy());
    this.send(response, { state: true, catalog: true });
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        for (const [client, valid] of this.clients) {
          if (!valid()) client.end();
          else if (!client.destroyed) client.write(': keepalive\n\n');
        }
      }, 10_000);
      this.heartbeat.unref();
    }
  }

  notify(update: LiveUpdate): void {
    for (const [client, authorized] of this.clients) {
      if (!authorized()) client.end();
      else this.send(client, update);
    }
  }

  close(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const client of this.clients.keys()) client.end();
    this.clients.clear();
  }

  private send(client: ServerResponse, update: LiveUpdate): void {
    if (client.destroyed || client.writableEnded) return;
    if (client.writableLength > 64 * 1024) client.destroy();
    else client.write(`data: ${JSON.stringify(update)}\n\n`);
  }
}
