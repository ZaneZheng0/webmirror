import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('..', import.meta.url));
const publicRoot = resolve(directory, 'public');
const port = Number.parseInt(process.env.WEBMIRROR_FIXTURE_PORT ?? '4178', 10);

const contentTypes: Readonly<Record<string, string>> = {
  '.bin': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const flakyRequestCounts = new Map<string, number>();
const protectedRequestCounts = new Map<
  string,
  {
    authorized: number;
    unauthorized: number;
  }
>();

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-length': Buffer.byteLength(payload),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(payload);
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (requestUrl.pathname === '/healthz') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (requestUrl.pathname === '/redirect') {
    response.writeHead(302, { location: '/basic/' });
    response.end();
    return;
  }

  if (requestUrl.pathname === '/missing') {
    sendJson(response, 404, { error: 'fixture not found' });
    return;
  }

  if (requestUrl.pathname === '/slow.bin') {
    const timer = setTimeout(() => {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
      });
      response.end('slow fixture payload');
    }, 5_000);
    response.once('close', () => clearTimeout(timer));
    return;
  }

  if (requestUrl.pathname === '/flaky.bin') {
    const key = requestUrl.searchParams.get('id') ?? 'default';
    const requestedFailures = Number.parseInt(requestUrl.searchParams.get('failures') ?? '3', 10);
    const failures = Number.isInteger(requestedFailures)
      ? Math.min(20, Math.max(0, requestedFailures))
      : 3;
    const count = (flakyRequestCounts.get(key) ?? 0) + 1;
    flakyRequestCounts.set(key, count);

    if (count <= failures) {
      response.writeHead(503, {
        'content-type': 'text/plain; charset=utf-8',
      });
      response.end('temporary fixture failure');
      return;
    }

    response.writeHead(200, {
      'content-type': 'application/octet-stream',
    });
    response.end('recovered fixture payload');
    return;
  }

  if (requestUrl.pathname === '/flaky-count') {
    const key = requestUrl.searchParams.get('id') ?? 'default';
    sendJson(response, 200, {
      count: flakyRequestCounts.get(key) ?? 0,
    });
    return;
  }

  if (requestUrl.pathname === '/protected/stats') {
    const key = requestUrl.searchParams.get('id') ?? 'default';
    sendJson(
      response,
      200,
      protectedRequestCounts.get(key) ?? {
        authorized: 0,
        unauthorized: 0,
      },
    );
    return;
  }

  if (requestUrl.pathname === '/protected/private.js') {
    const key = requestUrl.searchParams.get('id') ?? 'default';
    const count = protectedRequestCounts.get(key) ?? {
      authorized: 0,
      unauthorized: 0,
    };
    const authorized = (request.headers.cookie ?? '')
      .split(';')
      .some((value) => value.trim() === 'webmirror_fixture=authorized');

    if (!authorized) {
      count.unauthorized += 1;
      protectedRequestCounts.set(key, count);
      response.writeHead(403, {
        'cache-control': 'no-store',
        'content-type': 'application/javascript; charset=utf-8',
      });
      response.end('throw new Error("fixture cookie required");');
      return;
    }

    count.authorized += 1;
    protectedRequestCounts.set(key, count);
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/javascript; charset=utf-8',
    });
    response.end(
      `document.querySelector('#message').textContent = ` +
        `'Protected JavaScript executed from the captured browser response.';`,
    );
    return;
  }

  if (requestUrl.pathname === '/protected/' || requestUrl.pathname === '/protected') {
    const key = requestUrl.searchParams.get('id') ?? 'default';
    const body = `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>WebMirror Protected Fixture</title>
        </head>
        <body>
          <p id="message">Waiting for protected JavaScript.</p>
          <script src="/protected/private.js?id=${encodeURIComponent(key)}"></script>
        </body>
      </html>`;
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': 'webmirror_fixture=authorized; Path=/protected; HttpOnly; SameSite=Lax',
    });
    response.end(body);
    return;
  }

  const requestedPath = requestUrl.pathname.endsWith('/')
    ? `${requestUrl.pathname}index.html`
    : requestUrl.pathname;
  const candidate = resolve(publicRoot, `.${decodeURIComponent(requestedPath)}`);
  const publicPrefix = `${publicRoot}${sep}`;

  if (candidate !== publicRoot && !candidate.startsWith(publicPrefix)) {
    sendJson(response, 400, { error: 'invalid fixture path' });
    return;
  }

  try {
    const metadata = await stat(candidate);

    if (!metadata.isFile()) {
      sendJson(response, 404, { error: 'fixture not found' });
      return;
    }

    response.writeHead(200, {
      'content-length': metadata.size,
      'content-type': contentTypes[extname(candidate)] ?? 'application/octet-stream',
    });
    createReadStream(candidate).pipe(response);
  } catch {
    sendJson(response, 404, { error: 'fixture not found' });
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`WebMirror fixtures: http://127.0.0.1:${port}/basic/\n`);
});
