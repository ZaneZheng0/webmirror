import { once } from 'node:events';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { startValidationNetworkProxy, type ValidationNetworkProxy } from './validation-proxy.js';

interface FixtureServer {
  origin: string;
  server: Server;
}

interface ProxyResponse {
  body: string;
  statusCode: number;
}

const fixtureServers: Server[] = [];
const proxies: ValidationNetworkProxy[] = [];

async function startFixtureServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<FixtureServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Fixture server did not expose a TCP address');
  }

  fixtureServers.push(server);
  return {
    origin: `http://127.0.0.1:${address.port}`,
    server,
  };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();

  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function requestThroughProxy(proxyServer: string, targetUrl: string): Promise<ProxyResponse> {
  const proxy = new URL(proxyServer);
  const target = new URL(targetUrl);

  return await new Promise<ProxyResponse>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: proxy.hostname,
        port: Number(proxy.port),
        method: 'GET',
        path: target.href,
        headers: {
          connection: 'close',
          host: target.host,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () =>
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            statusCode: response.statusCode ?? 0,
          }),
        );
      },
    );
    request.once('error', reject);
    request.end();
  });
}

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(fixtureServers.splice(0).map((server) => closeServer(server)));
});

describe('startValidationNetworkProxy', () => {
  it('survives a client TCP reset and continues proxying later requests', async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const fixture = await startFixtureServer((request, response) => {
      if (request.url === '/stream') {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store',
        });
        response.write(chunk);
        const interval = setInterval(() => {
          if (!response.destroyed) {
            response.write(chunk);
          }
        }, 2);
        response.once('close', () => clearInterval(interval));
        return;
      }

      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': '2',
      });
      response.end('ok');
    });
    const controller = new AbortController();
    const proxy = await startValidationNetworkProxy({
      localOrigin: fixture.origin,
      signal: controller.signal,
      onBlocked: () => undefined,
    });
    proxies.push(proxy);
    const proxyAddress = new URL(proxy.server);
    const client = connect({
      host: proxyAddress.hostname,
      port: Number(proxyAddress.port),
    });

    await once(client, 'connect');
    client.write(
      `GET ${fixture.origin}/stream HTTP/1.1\r\nHost: ${new URL(fixture.origin).host}\r\nConnection: keep-alive\r\n\r\n`,
    );
    await once(client, 'data');
    client.resetAndDestroy();

    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(requestThroughProxy(proxy.server, `${fixture.origin}/health`)).resolves.toEqual({
      body: 'ok',
      statusCode: 200,
    });
  });

  it('survives a client reset during an incomplete request body', async () => {
    let markUploadStarted!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      markUploadStarted = resolve;
    });
    const fixture = await startFixtureServer((request, response) => {
      if (request.url === '/upload') {
        request.once('error', () => undefined);
        request.resume();
        markUploadStarted();
        return;
      }

      response.writeHead(204);
      response.end();
    });
    const controller = new AbortController();
    const proxy = await startValidationNetworkProxy({
      localOrigin: fixture.origin,
      signal: controller.signal,
      onBlocked: () => undefined,
    });
    proxies.push(proxy);
    const proxyAddress = new URL(proxy.server);
    const client = connect({
      host: proxyAddress.hostname,
      port: Number(proxyAddress.port),
    });
    client.on('error', () => undefined);

    await once(client, 'connect');
    client.write(
      `POST ${fixture.origin}/upload HTTP/1.1\r\nHost: ${new URL(fixture.origin).host}\r\nContent-Length: 1048576\r\nConnection: keep-alive\r\n\r\npartial`,
    );
    await uploadStarted;
    client.resetAndDestroy();

    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(
      requestThroughProxy(proxy.server, `${fixture.origin}/health`),
    ).resolves.toMatchObject({
      statusCode: 204,
    });
  });

  it('contains an upstream TCP reset and continues proxying later requests', async () => {
    const fixture = await startFixtureServer((request, response) => {
      if (request.url === '/reset-upstream') {
        request.socket.resetAndDestroy();
        return;
      }

      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': '2',
      });
      response.end('ok');
    });
    const controller = new AbortController();
    const proxy = await startValidationNetworkProxy({
      localOrigin: fixture.origin,
      signal: controller.signal,
      onBlocked: () => undefined,
    });
    proxies.push(proxy);

    await expect(
      requestThroughProxy(proxy.server, `${fixture.origin}/reset-upstream`),
    ).resolves.toMatchObject({
      statusCode: 502,
    });
    await expect(requestThroughProxy(proxy.server, `${fixture.origin}/health`)).resolves.toEqual({
      body: 'ok',
      statusCode: 200,
    });
  });
});
