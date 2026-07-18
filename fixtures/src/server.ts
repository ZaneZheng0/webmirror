import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('..', import.meta.url));
const publicRoot = resolve(directory, 'public');
const port = Number.parseInt(process.env.WEBMIRROR_FIXTURE_PORT ?? '4178', 10);

const contentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

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
