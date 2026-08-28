import { lookup } from 'node:dns/promises';
import type { EventEmitter } from 'node:events';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect as connectSocket } from 'node:net';
import type { Duplex } from 'node:stream';

export interface ValidationNetworkProxy {
  server: string;
  close: () => Promise<void>;
}

export interface StartValidationNetworkProxyOptions {
  localOrigin: string;
  signal: AbortSignal;
  onBlocked: (url: string, resourceType: string, method?: string) => void;
}

interface LoopbackTarget {
  address: string;
  family: number;
  hostname: string;
  host: string;
  port: number;
  origin: string;
  protocol: 'http:' | 'https:';
}

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function isLoopbackAddress(value: string): boolean {
  const address = value.toLowerCase().split('%', 1)[0] ?? '';

  if (address === '::1' || address === '0:0:0:0:0:0:0:1' || address.startsWith('::ffff:127.')) {
    return true;
  }

  const octets = address.split('.');
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255) &&
    octets[0] === '127'
  );
}

function canonicalTransportOrigin(url: URL): string {
  const normalized = new URL(url.href);

  if (normalized.protocol === 'ws:') {
    normalized.protocol = 'http:';
  } else if (normalized.protocol === 'wss:') {
    normalized.protocol = 'https:';
  }

  return normalized.origin;
}

function defaultPort(protocol: string): number {
  return protocol === 'https:' || protocol === 'wss:' ? 443 : 80;
}

function connectAuthorityMatches(requestTarget: URL, target: LoopbackTarget): boolean {
  const port = requestTarget.port ? Number(requestTarget.port) : 443;
  return requestTarget.hostname === target.hostname && port === target.port;
}

async function resolveLoopbackTarget(localOrigin: string): Promise<LoopbackTarget> {
  const url = new URL(localOrigin);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Validation proxy origin must use HTTP(S)');
  }

  const addresses = await lookup(url.hostname, {
    all: true,
    verbatim: true,
  });

  if (addresses.length === 0 || addresses.some((entry) => !isLoopbackAddress(entry.address))) {
    throw new Error('Validation proxy target did not resolve exclusively to loopback');
  }

  const selected = addresses[0];

  if (!selected) {
    throw new Error('Validation proxy target did not resolve to loopback');
  }

  return {
    address: selected.address,
    family: selected.family,
    hostname: url.hostname,
    host: url.host,
    port: url.port ? Number(url.port) : defaultPort(url.protocol),
    origin: url.origin,
    protocol: url.protocol,
  };
}

function connectionHeaderNames(headers: IncomingHttpHeaders): Set<string> {
  const names = new Set(hopByHopHeaders);
  const connection = headers.connection;
  const values = Array.isArray(connection) ? connection : connection ? [connection] : [];

  for (const value of values) {
    for (const name of value.split(',')) {
      const normalized = name.trim().toLowerCase();

      if (normalized) {
        names.add(normalized);
      }
    }
  }

  return names;
}

function filteredHeaders(headers: IncomingHttpHeaders, allowUpgrade = false): IncomingHttpHeaders {
  const blocked = connectionHeaderNames(headers);
  const forwarded: IncomingHttpHeaders = {};

  if (allowUpgrade) {
    blocked.delete('connection');
    blocked.delete('upgrade');
  }

  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !blocked.has(name.toLowerCase())) {
      forwarded[name] = value;
    }
  }

  return forwarded;
}

function forwardedRequestHeaders(
  headers: IncomingHttpHeaders,
  targetHost: string,
  allowUpgrade = false,
): IncomingHttpHeaders {
  const forwarded = filteredHeaders(headers, allowUpgrade);
  forwarded.host = targetHost;
  return forwarded;
}

function parseProxyRequestUrl(rawUrl: string | undefined, localOrigin: string): URL | undefined {
  if (!rawUrl) {
    return undefined;
  }

  try {
    return rawUrl.startsWith('/') ? new URL(rawUrl, localOrigin) : new URL(rawUrl);
  } catch {
    return undefined;
  }
}

function rejectHttp(response: ServerResponse, statusCode = 403): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }

  if (response.headersSent) {
    response.destroy();
    return;
  }

  response.writeHead(statusCode, {
    connection: 'close',
    'content-length': '0',
    'cache-control': 'no-store',
  });
  response.end();
}

function rejectSocket(socket: Duplex, statusCode = 403): void {
  if (!socket.destroyed && socket.writable) {
    const statusMessage =
      statusCode === 400 ? 'Bad Request' : statusCode === 502 ? 'Bad Gateway' : 'Forbidden';
    socket.end(
      `HTTP/1.1 ${statusCode} ${statusMessage}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
}

function containTransportErrors(
  transport: EventEmitter & { destroyed: boolean; destroy: () => unknown },
  onError?: () => void,
): void {
  transport.on('error', () => {
    if (!transport.destroyed) {
      transport.destroy();
    }

    onError?.();
  });
}

function trackSocket(sockets: Set<Duplex>, socket: Duplex): void {
  if (sockets.has(socket)) {
    return;
  }

  sockets.add(socket);
  containTransportErrors(socket);
  socket.once('close', () => sockets.delete(socket));
}

function writeRawResponse(socket: Duplex, response: IncomingMessage, allowUpgrade = false): void {
  if (socket.destroyed || !socket.writable) {
    return;
  }

  const statusCode = response.statusCode ?? 502;
  const statusMessage = response.statusMessage ?? 'Bad Gateway';
  socket.write(`HTTP/${response.httpVersion} ${statusCode} ${statusMessage}\r\n`);

  for (const [name, value] of Object.entries(filteredHeaders(response.headers, allowUpgrade))) {
    if (value === undefined) {
      continue;
    }

    for (const item of Array.isArray(value) ? value : [value]) {
      socket.write(`${name}: ${item}\r\n`);
    }
  }

  socket.write('\r\n');
}

function closeServer(server: Server, sockets: Set<Duplex>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }

  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

export async function startValidationNetworkProxy(
  options: StartValidationNetworkProxyOptions,
): Promise<ValidationNetworkProxy> {
  const target = await resolveLoopbackTarget(options.localOrigin);
  const sockets = new Set<Duplex>();
  let closed = false;
  const server = createServer((request, response) => {
    const requestTarget = parseProxyRequestUrl(request.url, target.origin);

    if (
      !requestTarget ||
      requestTarget.username ||
      requestTarget.password ||
      requestTarget.hash ||
      requestTarget.protocol !== 'http:' ||
      canonicalTransportOrigin(requestTarget) !== target.origin ||
      target.protocol !== 'http:'
    ) {
      if (requestTarget) {
        options.onBlocked(requestTarget.href, 'proxy-http', request.method);
      }
      rejectHttp(response, requestTarget ? 403 : 400);
      return;
    }

    const upstream = httpRequest({
      hostname: target.address,
      family: target.family,
      port: target.port,
      method: request.method,
      path: `${requestTarget.pathname}${requestTarget.search}`,
      headers: forwardedRequestHeaders(request.headers, target.host),
      setHost: false,
    });
    upstream.on('socket', (socket) => trackSocket(sockets, socket));
    upstream.on('response', (upstreamResponse) => {
      containTransportErrors(upstreamResponse, () => response.destroy());
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        filteredHeaders(upstreamResponse.headers),
      );
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => rejectHttp(response, 502));
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => {
      if (!response.writableEnded) {
        upstream.destroy();
      }
    });
    containTransportErrors(request, () => upstream.destroy());
    containTransportErrors(response, () => upstream.destroy());
    request.pipe(upstream);
  });

  server.on('connection', (socket) => trackSocket(sockets, socket));
  server.on('clientError', (_error, socket) => rejectSocket(socket, 400));
  server.on('connect', (request, clientSocket, head) => {
    let requestTarget: URL | undefined;

    try {
      requestTarget = new URL(`https://${request.url ?? ''}`);
    } catch {
      rejectSocket(clientSocket, 400);
      return;
    }

    if (!connectAuthorityMatches(requestTarget, target)) {
      options.onBlocked(requestTarget.href, 'proxy-connect', request.method);
      rejectSocket(clientSocket);
      return;
    }

    const upstreamSocket = connectSocket({
      host: target.address,
      family: target.family,
      port: target.port,
    });
    trackSocket(sockets, clientSocket);
    trackSocket(sockets, upstreamSocket);
    containTransportErrors(request, () => {
      clientSocket.destroy();
      upstreamSocket.destroy();
    });
    upstreamSocket.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      if (head.byteLength > 0) {
        upstreamSocket.write(head);
      }

      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.once('error', () => rejectSocket(clientSocket, 502));
  });
  server.on('upgrade', (request, clientSocket, head) => {
    const requestTarget = parseProxyRequestUrl(request.url, target.origin);

    if (
      !requestTarget ||
      requestTarget.username ||
      requestTarget.password ||
      requestTarget.hash ||
      !['http:', 'ws:'].includes(requestTarget.protocol) ||
      canonicalTransportOrigin(requestTarget) !== target.origin ||
      target.protocol !== 'http:'
    ) {
      if (requestTarget) {
        options.onBlocked(requestTarget.href, 'proxy-upgrade', request.method);
      }
      rejectSocket(clientSocket, requestTarget ? 403 : 400);
      return;
    }

    const upstreamRequest = httpRequest({
      hostname: target.address,
      family: target.family,
      port: target.port,
      method: request.method,
      path: `${requestTarget.pathname}${requestTarget.search}`,
      headers: forwardedRequestHeaders(request.headers, target.host, true),
      setHost: false,
    });
    trackSocket(sockets, clientSocket);
    containTransportErrors(request, () => {
      clientSocket.destroy();
      upstreamRequest.destroy();
    });
    upstreamRequest.on('socket', (socket) => trackSocket(sockets, socket));
    upstreamRequest.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      trackSocket(sockets, upstreamSocket);
      containTransportErrors(upstreamResponse, () => {
        clientSocket.destroy();
        upstreamSocket.destroy();
      });
      writeRawResponse(clientSocket, upstreamResponse, true);

      if (upstreamHead.byteLength > 0) {
        clientSocket.write(upstreamHead);
      }

      if (head.byteLength > 0) {
        upstreamSocket.write(head);
      }

      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamRequest.on('response', (upstreamResponse) => {
      containTransportErrors(upstreamResponse, () => clientSocket.destroy());
      writeRawResponse(clientSocket, upstreamResponse);
      upstreamResponse.pipe(clientSocket);
    });
    upstreamRequest.on('error', () => rejectSocket(clientSocket, 502));
    upstreamRequest.end();
  });

  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      options.signal.removeEventListener('abort', onAbort);
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
    };
    const onAbort = (): void => {
      cleanup();
      for (const socket of sockets) {
        socket.destroy();
      }
      reject(options.signal.reason ?? new DOMException('Validation was aborted', 'AbortError'));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };

    if (options.signal.aborted) {
      onAbort();
      return;
    }

    options.signal.addEventListener('abort', onAbort, { once: true });
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({
      port: 0,
      host: '127.0.0.1',
      signal: options.signal,
    });
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    await closeServer(server, sockets);
    throw new Error('Validation proxy did not expose a TCP address');
  }

  const onAbort = (): void => {
    void closeServer(server, sockets);
  };
  const onRuntimeError = (): void => {
    void closeServer(server, sockets);
  };

  if (options.signal.aborted) {
    await closeServer(server, sockets);
    throw options.signal.reason ?? new DOMException('Validation was aborted', 'AbortError');
  }

  options.signal.addEventListener('abort', onAbort, { once: true });
  server.on('error', onRuntimeError);

  return {
    server: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (closed) {
        return;
      }

      closed = true;
      options.signal.removeEventListener('abort', onAbort);
      server.removeListener('error', onRuntimeError);
      await closeServer(server, sockets);
    },
  };
}
