import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  nativeMessagingProtocolVersion,
  type NativeHostResponse,
  type NativeMirrorResult,
} from '../../packages/shared/src/index.js';
import { expect, test } from '@playwright/test';

interface PendingMessage {
  predicate: (message: NativeHostResponse) => boolean;
  resolve: (message: NativeHostResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

async function startOneShotStaticSource(): Promise<{
  origin: string;
  closed: Promise<void>;
  close: () => Promise<void>;
}> {
  const bodies = new Map<
    string,
    {
      contentType: string;
      body: string;
    }
  >([
    [
      '/',
      {
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html>
          <html>
            <head>
              <title>WebMirror Basic Fixture</title>
              <link rel="stylesheet" href="styles.css">
            </head>
            <body>
              <img src="fixture-art.svg" alt="">
              <p id="message">Waiting for JavaScript.</p>
              <script src="app.js"></script>
            </body>
          </html>`,
      },
    ],
    [
      '/styles.css',
      {
        contentType: 'text/css; charset=utf-8',
        body: 'body { color: #123456; }',
      },
    ],
    [
      '/app.js',
      {
        contentType: 'application/javascript; charset=utf-8',
        body: `document.querySelector('#message').textContent = 'JavaScript executed successfully.';`,
      },
    ],
    [
      '/fixture-art.svg',
      {
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>',
      },
    ],
  ]);
  const served = new Set<string>();
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolveClose) => {
    resolveClosed = resolveClose;
  });
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const fixture = bodies.get(path);

    if (!fixture) {
      response.writeHead(404);
      response.end('not found');
      return;
    }

    response.writeHead(200, {
      'cache-control': 'max-age=3600',
      'content-type': fixture.contentType,
      etag: `"${Buffer.byteLength(fixture.body)}-${path}"`,
    });
    response.end(fixture.body);
    response.once('finish', () => {
      served.add(path);

      if (served.size === bodies.size) {
        server.close(() => resolveClosed());
      }
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolveListen();
    });
  });
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('One-shot source did not expose a TCP address.');
  }

  return {
    origin: `http://127.0.0.1:${address.port}/`,
    closed,
    close: async () => {
      if (!server.listening) {
        return;
      }

      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolveClosed();
            resolveClose();
          }
        });
      });
    },
  };
}

async function startDynamicRenditionSource(): Promise<{
  sourceUrl: string;
  assetOrigin: string;
  closed: Promise<void>;
  close: () => Promise<void>;
}> {
  const imageBody = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXsAAAAASUVORK5CYII=',
    'base64',
  );
  let assetOrigin = '';
  const assetBodies = new Map<
    string,
    {
      contentType: string;
      body: string | Buffer | (() => string | Buffer);
    }
  >([
    [
      '/build/assets/styles.css',
      {
        contentType: 'text/css; charset=utf-8',
        body: `.icon {
          display: block;
          width: 16px;
          height: 16px;
          background: currentColor;
          -webkit-mask-image: var(--mask-url);
          mask-image: var(--mask-url);
        }`,
      },
    ],
    [
      '/build/assets/app.js',
      {
        contentType: 'application/javascript; charset=utf-8',
        body: () => `
          const assetOrigin = ${JSON.stringify(assetOrigin)};
          const assetBase = assetOrigin + "/build/assets/";
          const composedManifest = {
            imageLeaf: "./images/composed.png",
          };
          const composed = document.querySelector('#composed');
          composed.addEventListener('load', () => {
            document.body.dataset.composed = 'loaded';
          }, { once: true });
          composed.addEventListener('error', () => {
            document.body.dataset.composed = 'failed';
          }, { once: true });
          composed.src = assetBase + composedManifest.imageLeaf;

          const dynamicMarkup = document.querySelector('#dynamic-markup');
          dynamicMarkup.innerHTML =
            '<img id="markup-image" alt="" src="' + assetOrigin + '/images/composed.png">';
          const markupImage = dynamicMarkup.querySelector('#markup-image');
          markupImage.addEventListener('load', () => {
            document.body.dataset.markup = 'loaded';
          }, { once: true });
          markupImage.addEventListener('error', () => {
            document.body.dataset.markup = 'failed';
          }, { once: true });
        `,
      },
    ],
    [
      '/build/assets/images/composed.png',
      {
        contentType: 'image/png',
        body: imageBody,
      },
    ],
    [
      '/images/icon.svg?v=1',
      {
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>',
      },
    ],
    [
      '/images/hero.png?v=7&width=100&height=50&crop=center',
      {
        contentType: 'image/png',
        body: imageBody,
      },
    ],
    [
      '/images/hero.png?v=7&width=1300&height=650&crop=center',
      {
        contentType: 'image/png',
        body: imageBody,
      },
    ],
    [
      '/images/composed.png',
      {
        contentType: 'image/png',
        body: imageBody,
      },
    ],
  ]);
  const expectedAssetKeys = new Set([
    '/build/assets/app.js',
    '/build/assets/images/composed.png',
    '/build/assets/styles.css',
    '/images/composed.png',
    '/images/icon.svg?v=1',
    '/images/hero.png?v=7&width=1300&height=650&crop=center',
  ]);
  const assetServed = new Set<string>();
  let resolveAssetClosed: () => void = () => undefined;
  const assetClosed = new Promise<void>((resolveClose) => {
    resolveAssetClosed = resolveClose;
  });
  const assetServer = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const key = `${requestUrl.pathname}${requestUrl.search}`;
    const fixture = assetBodies.get(key);

    if (!fixture) {
      response.writeHead(404);
      response.end('not found');
      return;
    }

    const body = typeof fixture.body === 'function' ? fixture.body() : fixture.body;
    response.writeHead(200, {
      'cache-control': 'max-age=3600',
      'content-type': fixture.contentType,
    });
    response.end(body);
    response.once('finish', () => {
      assetServed.add(key);

      if ([...expectedAssetKeys].every((expectedKey) => assetServed.has(expectedKey))) {
        assetServer.close(() => resolveAssetClosed());
      }
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    assetServer.once('error', reject);
    assetServer.listen(0, '127.0.0.1', () => {
      assetServer.removeListener('error', reject);
      resolveListen();
    });
  });
  const assetAddress = assetServer.address();

  if (!assetAddress || typeof assetAddress === 'string') {
    throw new Error('Rendition asset source did not expose a TCP address.');
  }

  assetOrigin = `http://127.0.0.1:${assetAddress.port}`;
  let resolveSourceClosed: () => void = () => undefined;
  const sourceClosed = new Promise<void>((resolveClose) => {
    resolveSourceClosed = resolveClose;
  });
  const sourceServer = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (requestUrl.pathname !== '/editions/winter2026') {
      response.writeHead(404);
      response.end('not found');
      return;
    }

    const body = `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Dynamic rendition fixture</title>
          <link rel="stylesheet" href="${assetOrigin}/build/assets/styles.css">
        </head>
        <body data-hero-url="${assetOrigin}/images/hero.png?v=7">
          <span
            id="icon"
            class="icon"
            style="--mask-url:url('${assetOrigin}/images/icon.svg?v=1')"
          ></span>
          <img id="exact" alt="">
          <img id="variant" alt="">
          <img id="composed" alt="">
          <div id="dynamic-markup"></div>
          <p id="status">waiting</p>
          <script src="${assetOrigin}/build/assets/app.js"></script>
          <script>
            const baseUrl = document.body.dataset.heroUrl;
            const exact = document.querySelector('#exact');
            const variant = document.querySelector('#variant');
            const status = document.querySelector('#status');
            const rendition = (width, height) => {
              const url = new URL(baseUrl);
              url.searchParams.set('width', String(width));
              url.searchParams.set('height', String(height));
              url.searchParams.set('crop', 'center');
              return url.href;
            };
            const loaded = (image) => new Promise((resolve) => {
              image.addEventListener('load', () => resolve(true), { once: true });
              image.addEventListener('error', () => resolve(false), { once: true });
            });
            const readiness = Promise.all([loaded(exact), loaded(variant)]);
            exact.setAttribute('src', rendition(100, 50));
            variant.setAttribute('src', rendition(600, 300));
            variant.setAttribute(
              'srcset',
              rendition(600, 300) + ' 1x, ' + rendition(900, 450) + ' 2x',
            );
            readiness.then((results) => {
              document.body.dataset.exactSrc = exact.currentSrc || exact.src;
              document.body.dataset.variantSrc = variant.currentSrc || variant.src;
              status.textContent = results.every(Boolean) ? 'runtime localized' : 'runtime failed';
            });
          </script>
        </body>
      </html>`;
    response.writeHead(200, {
      'cache-control': 'max-age=3600',
      'content-length': Buffer.byteLength(body),
      'content-type': 'text/html; charset=utf-8',
    });
    response.end(body);
    response.once('finish', () => {
      sourceServer.close(() => resolveSourceClosed());
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    sourceServer.once('error', reject);
    sourceServer.listen(0, '127.0.0.1', () => {
      sourceServer.removeListener('error', reject);
      resolveListen();
    });
  });
  const sourceAddress = sourceServer.address();

  if (!sourceAddress || typeof sourceAddress === 'string') {
    throw new Error('Rendition page source did not expose a TCP address.');
  }

  return {
    sourceUrl: `http://127.0.0.1:${sourceAddress.port}/editions/winter2026`,
    assetOrigin,
    closed: Promise.all([sourceClosed, assetClosed]).then(() => undefined),
    close: async () => {
      await Promise.all(
        [sourceServer, assetServer].map(
          (server) =>
            new Promise<void>((resolveClose, reject) => {
              if (!server.listening) {
                resolveClose();
                return;
              }

              server.close((error) => {
                if (error) {
                  reject(error);
                } else {
                  resolveClose();
                }
              });
            }),
        ),
      );
    },
  };
}

async function startRouteAndTimestampSource(): Promise<{
  cmsObjectStoreMediaUrl: string;
  sourceUrl: string;
  cmsMediaUrl: string;
  cmsResourceUrl: string;
  close: () => Promise<void>;
}> {
  const expectedTimestamp = '1730000000000';
  let cmsOrigin = '';
  const cmsServer = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (requestUrl.pathname === '/media/scene.bin') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
      });
      response.end('external route scene');
      return;
    }

    if (requestUrl.pathname === '/bucket.example.test/media/proxy.bin') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
      });
      response.end('object-store route scene');
      return;
    }

    if (
      requestUrl.pathname !== '/cms/projects.json' ||
      !/^CMS_DATA_\d{11,}$/u.test(requestUrl.searchParams.get('v') ?? '')
    ) {
      response.writeHead(404);
      response.end('not found');
      return;
    }

    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify({ title: 'offline project' }));
  });
  await new Promise<void>((resolveListen, reject) => {
    cmsServer.once('error', reject);
    cmsServer.listen(0, '127.0.0.1', () => {
      cmsServer.removeListener('error', reject);
      resolveListen();
    });
  });
  const cmsAddress = cmsServer.address();

  if (!cmsAddress || typeof cmsAddress === 'string') {
    throw new Error('Timestamp CMS source did not expose a TCP address.');
  }

  cmsOrigin = `http://127.0.0.1:${cmsAddress.port}`;
  const sourceServer = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (requestUrl.pathname === '/work') {
      const body = `<!doctype html>
        <html>
          <head><title>Route and timestamp fixture</title></head>
          <body>
            <p id="status">Loading route and timestamp resources...</p>
            <script src="/assets/route-app.js"></script>
          </body>
        </html>`;
      response.writeHead(200, {
        'content-length': Buffer.byteLength(body),
        'content-type': 'text/html; charset=utf-8',
      });
      response.end(body);
      return;
    }

    if (requestUrl.pathname === '/assets/route-app.js') {
      const body = `
        const status = document.querySelector('#status');
        const routePrefixedAsset =
          location.origin +
          location.pathname +
          '/' +
          ['assets', 'scene.bin'].join('/');
        const cmsOrigin = ${JSON.stringify(cmsOrigin)};
        const cmsPath = String.fromCharCode(
          47,
          99,
          109,
          115,
          47,
          112,
          114,
          111,
          106,
          101,
          99,
          116,
          115,
          46,
          106,
          115,
          111,
          110,
        );
        const timestampedCmsUrl =
          cmsOrigin +
          cmsPath +
          '?' +
          String.fromCharCode(118, 61, 67, 77, 83, 95, 68, 65, 84, 65, 95) +
          Date.now();

        Promise.all([
          fetch(routePrefixedAsset).then((response) => response.text()),
          fetch(timestampedCmsUrl).then((response) => response.json()),
        ])
          .then(([scene, project]) => {
            if (scene !== 'route-prefixed scene' || project.title !== 'offline project') {
              throw new Error('Route and timestamp resources did not preserve their content.');
            }

            return undefined;
          })
          .then(() => {
            if (status) {
              status.textContent = 'route and timestamp resources localized';
            }
          })
          .catch((error) => {
            if (status) {
              status.textContent = error instanceof Error ? error.message : 'runtime localization failed';
            }

            throw error;
          });
      `;
      response.writeHead(200, {
        'content-length': Buffer.byteLength(body),
        'content-type': 'application/javascript; charset=utf-8',
      });
      response.end(body);
      return;
    }

    if (requestUrl.pathname === '/assets/scene.bin') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
      });
      response.end('route-prefixed scene');
      return;
    }

    response.writeHead(404);
    response.end('not found');
  });
  await new Promise<void>((resolveListen, reject) => {
    sourceServer.once('error', reject);
    sourceServer.listen(0, '127.0.0.1', () => {
      sourceServer.removeListener('error', reject);
      resolveListen();
    });
  });
  const sourceAddress = sourceServer.address();

  if (!sourceAddress || typeof sourceAddress === 'string') {
    throw new Error('Route page source did not expose a TCP address.');
  }

  return {
    sourceUrl: `http://127.0.0.1:${sourceAddress.port}/work`,
    cmsMediaUrl: `${cmsOrigin}/media/scene.bin`,
    cmsObjectStoreMediaUrl: `${cmsOrigin}/bucket.example.test/media/proxy.bin`,
    cmsResourceUrl: `${cmsOrigin}/cms/projects.json?v=CMS_DATA_${expectedTimestamp}`,
    close: async () => {
      await Promise.all(
        [sourceServer, cmsServer].map(
          (server) =>
            new Promise<void>((resolveClose, reject) => {
              if (!server.listening) {
                resolveClose();
                return;
              }

              server.close((error) => {
                if (error) {
                  reject(error);
                } else {
                  resolveClose();
                }
              });
            }),
        ),
      );
    },
  };
}

class NativeProcessClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly #messages: NativeHostResponse[] = [];
  readonly #pending = new Set<PendingMessage>();
  #buffer = Buffer.alloc(0);
  #stderr = '';

  constructor(outputRoot: string) {
    const packagedExecutable = process.env.WEBMIRROR_HELPER_E2E_EXECUTABLE;
    const executable = packagedExecutable ? resolve(packagedExecutable) : process.execPath;
    const args = packagedExecutable
      ? ['--native']
      : [resolve('apps/helper/dist/index.cjs'), '--native'];
    this.child = spawn(executable, args, {
      cwd: resolve('.'),
      env: {
        ...process.env,
        WEBMIRROR_ALLOW_PRIVATE_NETWORK_FOR_TESTS: '1',
        WEBMIRROR_OUTPUT_ROOT: outputRoot,
        WEBMIRROR_CACHE_ROOT: join(outputRoot, '.cache-v1'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#drainFrames();
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr += chunk.toString('utf8');
    });
    this.child.once('exit', (code) => {
      if (code === 0 || this.#pending.size === 0) {
        return;
      }

      const error = new Error(`Helper exited with code ${String(code)}: ${this.#stderr}`);

      for (const pending of this.#pending) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }

      this.#pending.clear();
    });
  }

  send(message: unknown): void {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    this.child.stdin.write(frame);
  }

  waitFor(
    predicate: (message: NativeHostResponse) => boolean,
    timeoutMs = 60_000,
  ): Promise<NativeHostResponse> {
    const existing = this.#messages.find(predicate);

    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolveMessage, reject) => {
      const pending: PendingMessage = {
        predicate,
        resolve: resolveMessage,
        reject,
        timeout: setTimeout(() => {
          this.#pending.delete(pending);
          reject(new Error(`Timed out waiting for helper message. stderr: ${this.#stderr}`));
        }, timeoutMs),
      };
      this.#pending.add(pending);
    });
  }

  async close(): Promise<void> {
    this.child.stdin.end();

    await new Promise<void>((resolveExit) => {
      if (this.child.exitCode !== null) {
        resolveExit();
        return;
      }

      const timeout = setTimeout(() => {
        this.child.kill();
      }, 5_000);
      this.child.once('exit', () => {
        clearTimeout(timeout);
        resolveExit();
      });
    });
  }

  #drainFrames(): void {
    while (this.#buffer.length >= 4) {
      const payloadLength = this.#buffer.readUInt32LE(0);

      if (this.#buffer.length < payloadLength + 4) {
        return;
      }

      const payload = this.#buffer.subarray(4, payloadLength + 4);
      this.#buffer = this.#buffer.subarray(payloadLength + 4);
      const message = JSON.parse(payload.toString('utf8')) as NativeHostResponse;
      this.#messages.push(message);

      for (const pending of this.#pending) {
        if (!pending.predicate(message)) {
          continue;
        }

        clearTimeout(pending.timeout);
        this.#pending.delete(pending);
        pending.resolve(message);
      }
    }
  }
}

function nativeFailureMessage(message: NativeHostResponse): string | undefined {
  if (
    (message.type === 'mirror_result' || message.type === 'job_action_result') &&
    !message.success
  ) {
    return `${message.error.code}: ${message.error.message}`;
  }

  return undefined;
}

test('mirrors, rewrites, previews, and validates the static fixture through the built helper', async ({
  request,
}) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'webmirror-helper-e2e-'));
  const client = new NativeProcessClient(outputRoot);
  const source = await startOneShotStaticSource();

  try {
    client.send({
      type: 'handshake',
      requestId: 'handshake-1',
      protocolVersion: nativeMessagingProtocolVersion,
      extensionVersion: '0.0.1',
    });
    await expect(
      client.waitFor((message) => message.type === 'handshake_result'),
    ).resolves.toMatchObject({
      type: 'handshake_result',
      accepted: true,
    });

    const capture = {
      sourceUrl: source.origin,
      title: 'WebMirror Basic Fixture',
      capturedAt: new Date().toISOString(),
      completionReason: 'network_idle' as const,
      viewport: {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
      },
      resources: [
        {
          sourceUrl: source.origin,
          method: 'GET',
          contentType: 'text/html',
        },
        {
          sourceUrl: `${source.origin}styles.css`,
          method: 'GET',
          contentType: 'text/css',
        },
        {
          sourceUrl: `${source.origin}app.js`,
          method: 'GET',
          contentType: 'application/javascript',
        },
        {
          sourceUrl: `${source.origin}fixture-art.svg`,
          method: 'GET',
          contentType: 'image/svg+xml',
        },
      ],
      warnings: [],
    };
    client.send({
      type: 'mirror_create',
      requestId: 'mirror-1',
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: 'fixture-job',
      capture,
    });
    const message = await client.waitFor((candidate) => candidate.type === 'mirror_result', 90_000);

    expect(message, nativeFailureMessage(message)).toMatchObject({
      type: 'mirror_result',
      requestId: 'mirror-1',
      jobId: 'fixture-job',
      success: true,
      result: {
        status: 'complete',
        downloadedResources: 4,
        failedResources: 0,
        completenessScore: 100,
      },
    });

    const result = message as Extract<NativeMirrorResult, { success: true }>;
    await source.closed;
    client.send({
      type: 'mirror_create',
      requestId: 'mirror-cache-hit',
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: 'fixture-cache-hit-job',
      capture: {
        ...capture,
        capturedAt: new Date().toISOString(),
      },
    });
    const cachedMessage = await client.waitFor(
      (candidate) =>
        candidate.type === 'mirror_result' && candidate.requestId === 'mirror-cache-hit',
      90_000,
    );
    expect(cachedMessage, nativeFailureMessage(cachedMessage)).toMatchObject({
      type: 'mirror_result',
      requestId: 'mirror-cache-hit',
      jobId: 'fixture-cache-hit-job',
      success: true,
      result: {
        status: 'complete',
        downloadedResources: 4,
        failedResources: 0,
        completenessScore: 100,
      },
    });
    const cachedResult = cachedMessage as Extract<NativeMirrorResult, { success: true }>;
    const cachedManifest = JSON.parse(await readFile(cachedResult.result.manifestPath, 'utf8')) as {
      resources: Array<{ bodySource?: string }>;
    };
    expect(cachedManifest.resources).toHaveLength(4);
    expect(cachedManifest.resources.every((resource) => resource.bodySource === 'cache')).toBe(
      true,
    );
    const response = await request.get(result.result.entryUrl ?? '');
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain('href="styles.css"');
    expect(html).toContain('src="fixture-art.svg"');
    await expect(stat(result.result.manifestPath)).resolves.toBeDefined();
    await expect(stat(result.result.validationPath ?? '')).resolves.toBeDefined();
    expect(await readFile(result.result.validationPath ?? '', 'utf8')).toContain(
      '"status": "complete"',
    );
  } finally {
    await client.close();
    await source.close();
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('preserves a WebGL scene with Worker, JSON, BIN, and texture resources', async ({
  request,
}) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'webmirror-webgl-e2e-'));
  const client = new NativeProcessClient(outputRoot);

  try {
    client.send({
      type: 'handshake',
      requestId: 'handshake-webgl',
      protocolVersion: nativeMessagingProtocolVersion,
      extensionVersion: '0.0.1',
    });
    await expect(
      client.waitFor((message) => message.type === 'handshake_result'),
    ).resolves.toMatchObject({
      type: 'handshake_result',
      accepted: true,
    });

    const origin = 'http://127.0.0.1:4178/webgl/';
    client.send({
      type: 'mirror_create',
      requestId: 'mirror-webgl',
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: 'webgl-fixture-job',
      capture: {
        sourceUrl: origin,
        title: 'WebMirror WebGL Fixture',
        capturedAt: new Date().toISOString(),
        completionReason: 'network_idle',
        viewport: {
          width: 1280,
          height: 720,
          deviceScaleFactor: 1,
        },
        resources: [
          { sourceUrl: origin, method: 'GET', contentType: 'text/html' },
          {
            sourceUrl: `${origin}styles.css`,
            method: 'GET',
            contentType: 'text/css',
          },
          {
            sourceUrl: `${origin}app.js`,
            method: 'GET',
            contentType: 'application/javascript',
          },
          {
            sourceUrl: `${origin}worker.js`,
            method: 'GET',
            contentType: 'application/javascript',
            workerContext: true,
          },
          {
            sourceUrl: `${origin}worker-runtime.js`,
            method: 'GET',
            contentType: 'application/javascript',
            workerContext: true,
          },
          {
            sourceUrl: `${origin}scene.json`,
            method: 'GET',
            contentType: 'application/json',
          },
          {
            sourceUrl: `${origin}model.bin`,
            method: 'GET',
            contentType: 'application/octet-stream',
          },
          {
            sourceUrl: `${origin}texture.svg`,
            method: 'GET',
            contentType: 'image/svg+xml',
          },
        ],
        warnings: [],
      },
    });
    const message = await client.waitFor(
      (candidate) => candidate.type === 'mirror_result' && candidate.requestId === 'mirror-webgl',
      90_000,
    );

    expect(message, nativeFailureMessage(message)).toMatchObject({
      type: 'mirror_result',
      success: true,
      result: {
        status: 'complete',
        downloadedResources: 8,
        failedResources: 0,
        completenessScore: 100,
        onlineDependencies: [],
      },
    });

    const result = message as Extract<NativeMirrorResult, { success: true }>;
    const validation = JSON.parse(await readFile(result.result.validationPath ?? '', 'utf8')) as {
      checks: {
        canvas: { nonEmpty: number };
        diagnostics?: { passed: boolean; truncated: boolean; droppedEvents: number };
        http: { local404s: unknown[] };
        remoteDependencies: { dependencies: unknown[] };
      };
    };
    expect(validation.checks.canvas.nonEmpty).toBeGreaterThan(0);
    expect(validation.checks.diagnostics).toMatchObject({
      passed: true,
      truncated: false,
      droppedEvents: 0,
    });
    expect(validation.checks.http.local404s).toEqual([]);
    expect(validation.checks.remoteDependencies.dependencies).toEqual([]);

    const localResponse = await request.get(result.result.entryUrl ?? '');
    expect(localResponse.status()).toBe(200);
    const localizedScript = await readFile(
      join(result.result.outputDirectory, 'site', 'webgl', 'app.js'),
      'utf8',
    );
    const localizedHtml = await readFile(
      join(result.result.outputDirectory, 'site', 'webgl', 'index.html'),
      'utf8',
    );
    const localizedWorker = await readFile(
      join(result.result.outputDirectory, 'site', 'webgl', 'worker.js'),
      'utf8',
    );
    const localizedScene = await readFile(
      join(result.result.outputDirectory, 'site', 'webgl', 'scene.json'),
      'utf8',
    );
    expect(localizedScript).toContain('new Worker("/webgl/worker.js")');
    expect(localizedScript).toContain('fetch("/webgl/scene.json")');
    expect(localizedScript).toContain('fetch(runtimeAssetRoot + runtimeManifest.binaryLeaf)');
    expect(localizedScript).toContain('loadImage(runtimeAssetRoot + runtimeManifest.imageLeaf)');
    expect(localizedHtml).toContain('data-webmirror-runtime="url-map-v1"');
    expect(localizedHtml).toContain('["http://127.0.0.1:4178/webgl/model.bin","/webgl/model.bin"]');
    expect(localizedWorker).toContain('webmirror-worker-runtime-url-map-v1');
    expect(localizedWorker).toContain('global.importScripts=function()');
    expect(localizedWorker).toContain('fetch(runtimeAssetRoot + runtimeManifest.modelLeaf)');
    expect(JSON.parse(localizedScene)).toEqual({
      model: 'model.bin',
      texture: 'texture.svg',
    });
  } finally {
    await client.close();
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('localizes runtime-composed dynamic modules, nested Workers, and CSSOM URLs', async ({
  browser,
}) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'webmirror-runtime-composed-e2e-'));
  const client = new NativeProcessClient(outputRoot);
  const origin = 'http://127.0.0.1:4178/runtime-composed/';

  try {
    client.send({
      type: 'handshake',
      requestId: 'handshake-runtime-composed',
      protocolVersion: nativeMessagingProtocolVersion,
      extensionVersion: '0.0.1',
    });
    await expect(
      client.waitFor((message) => message.type === 'handshake_result'),
    ).resolves.toMatchObject({
      type: 'handshake_result',
      accepted: true,
    });

    client.send({
      type: 'mirror_create',
      requestId: 'mirror-runtime-composed',
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: 'runtime-composed-fixture-job',
      capture: {
        sourceUrl: origin,
        title: 'WebMirror Runtime-Composed Fixture',
        capturedAt: new Date().toISOString(),
        completionReason: 'network_idle',
        viewport: {
          width: 1280,
          height: 720,
          deviceScaleFactor: 1,
        },
        resources: [
          { sourceUrl: origin, method: 'GET', contentType: 'text/html' },
          {
            sourceUrl: `${origin}styles.css`,
            method: 'GET',
            contentType: 'text/css',
          },
          {
            sourceUrl: `${origin}app.js`,
            method: 'GET',
            contentType: 'application/javascript',
          },
          {
            sourceUrl: `${origin}runtime-module.js`,
            method: 'GET',
            contentType: 'application/javascript',
          },
          {
            sourceUrl: `${origin}style.svg`,
            method: 'GET',
            contentType: 'image/svg+xml',
          },
        ],
        warnings: [],
      },
    });
    const message = await client.waitFor(
      (candidate) =>
        candidate.type === 'mirror_result' && candidate.requestId === 'mirror-runtime-composed',
      90_000,
    );

    if (message.type !== 'mirror_result' || !message.success) {
      throw new Error(nativeFailureMessage(message));
    }

    const result = message;
    const validation = JSON.parse(await readFile(result.result.validationPath ?? '', 'utf8')) as {
      status: string;
      score: number;
      errors: string[];
      warnings: string[];
      checks: {
        http: { local404s: unknown[] };
        remoteDependencies: { dependencies: unknown[] };
        runtime: {
          pageErrors: Array<{ message: string; stack?: string }>;
          blockingConsoleErrors: Array<{ text: string; url?: string }>;
        };
      };
    };
    const mirrorManifest = JSON.parse(
      await readFile(join(result.result.outputDirectory, 'mirror.json'), 'utf8'),
    ) as {
      resources: Array<{
        sourceUrl: string;
        localPath?: string;
        status: string;
        workerContext?: boolean;
        rewritten?: boolean;
      }>;
    };
    const helperRuntimeComplete =
      result.result.status === 'complete' &&
      result.result.downloadedResources === 8 &&
      result.result.failedResources === 0 &&
      result.result.completenessScore === 100 &&
      result.result.onlineDependencies.length === 0;

    if (!helperRuntimeComplete) {
      const debugPage = await browser.newPage();
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      const requestedUrls: string[] = [];
      debugPage.on('pageerror', (error) => pageErrors.push(error.message));
      debugPage.on('console', (message) => {
        if (message.type() === 'error') {
          consoleErrors.push(message.text());
        }
      });
      debugPage.on('request', (request) => requestedUrls.push(request.url()));

      let directReplay: {
        status: string | null;
        pageErrors: string[];
        consoleErrors: string[];
        requestedUrls: string[];
      };

      try {
        await debugPage.goto(result.result.entryUrl ?? '', { waitUntil: 'load' });
        await debugPage.waitForTimeout(1_000);
        directReplay = {
          status: await debugPage.locator('#status').textContent(),
          pageErrors,
          consoleErrors,
          requestedUrls,
        };
      } finally {
        await debugPage.close();
      }

      const diagnostics = {
        result: result.result,
        mirroredResources: mirrorManifest.resources.map((resource) => ({
          sourceUrl: resource.sourceUrl,
          localPath: resource.localPath,
          status: resource.status,
          workerContext: resource.workerContext === true,
          rewritten: resource.rewritten === true,
        })),
        validation: {
          status: validation.status,
          score: validation.score,
          errors: validation.errors,
          warnings: validation.warnings,
          pageErrors: validation.checks.runtime.pageErrors,
          blockingConsoleErrors: validation.checks.runtime.blockingConsoleErrors,
        },
        directReplay,
      };
      await test.info().attach('runtime-composed-helper-diagnostics.json', {
        body: JSON.stringify(diagnostics, null, 2),
        contentType: 'application/json',
      });
      throw new Error(
        `The runtime-composed Helper mirror must complete without replay errors.\n${JSON.stringify(
          diagnostics,
          null,
          2,
        )}`,
      );
    }

    expect(validation.checks.http.local404s).toEqual([]);
    expect(validation.checks.remoteDependencies.dependencies).toEqual([]);

    for (const filename of ['module-worker.js', 'worker-module.js', 'nested-worker.js']) {
      expect(
        mirrorManifest.resources.find((resource) =>
          resource.sourceUrl.endsWith(`/runtime-composed/${filename}`),
        ),
      ).toMatchObject({
        status: 'downloaded',
        workerContext: true,
      });
    }

    const localizedApp = await readFile(
      join(result.result.outputDirectory, 'site', 'runtime-composed', 'app.js'),
      'utf8',
    );
    const localizedWorker = await readFile(
      join(result.result.outputDirectory, 'site', 'runtime-composed', 'module-worker.js'),
      'utf8',
    );
    const localizedHtml = await readFile(
      join(result.result.outputDirectory, 'site', 'runtime-composed', 'index.html'),
      'utf8',
    );
    expect(localizedApp).toContain('globalThis.__webmirrorMapModuleUrl(');
    expect(localizedWorker).toContain('webmirror-worker-runtime-url-map-v1');
    expect(localizedWorker).toContain('wrapWorkerConstructor("Worker")');
    expect(localizedHtml).toContain('function mapCssText(value)');
    expect(localizedHtml).toContain('wrapCssTextMethod(cssStyleSheetPrototype,"replaceSync",0)');
    expect(localizedHtml).toContain(
      'wrapStyleTextProperty(htmlStyleElementPrototype,"textContent")',
    );

    const page = await browser.newPage();
    const unexpectedRequests: string[] = [];
    const previewOrigin = new URL(result.result.entryUrl ?? '').origin;
    await page.route('**/*', async (route) => {
      const requestOrigin = new URL(route.request().url()).origin;

      if (requestOrigin !== previewOrigin) {
        unexpectedRequests.push(route.request().url());
        await route.abort();
        return;
      }

      await route.continue();
    });
    await page.goto(result.result.entryUrl ?? '');
    await expect(page.locator('#status')).toHaveText('runtime composed complete');
    const runtimeState = await page.evaluate(() => {
      const surface = document.querySelector('#cssom-surface') as HTMLElement;
      const styles = getComputedStyle(surface);

      return {
        backgroundImage: styles.backgroundImage,
        borderImageSource: styles.borderImageSource,
        maskImage: styles.maskImage || styles.webkitMaskImage,
        styleTextContent: getComputedStyle(
          document.querySelector('#style-text-content-surface') as HTMLElement,
        ).backgroundImage,
        styleInnerText: getComputedStyle(
          document.querySelector('#style-inner-text-surface') as HTMLElement,
        ).backgroundImage,
        styleInnerHtml: getComputedStyle(
          document.querySelector('#style-inner-html-surface') as HTMLElement,
        ).backgroundImage,
        styleAppend: getComputedStyle(
          document.querySelector('#style-append-surface') as HTMLElement,
        ).backgroundImage,
        styleAppendChild: getComputedStyle(
          document.querySelector('#style-append-child-surface') as HTMLElement,
        ).backgroundImage,
      };
    });
    expect(runtimeState.backgroundImage).toContain(previewOrigin);
    expect(runtimeState.borderImageSource).toContain(previewOrigin);
    expect(runtimeState.maskImage).toContain(previewOrigin);
    expect(runtimeState.styleTextContent).toContain(previewOrigin);
    expect(runtimeState.styleInnerText).toContain(previewOrigin);
    expect(runtimeState.styleInnerHtml).toContain(previewOrigin);
    expect(runtimeState.styleAppend).toContain(previewOrigin);
    expect(runtimeState.styleAppendChild).toContain(previewOrigin);
    expect(unexpectedRequests).toEqual([]);
    await page.close();
  } finally {
    await client.close();
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('localizes dynamic image renditions and inline CSS custom-property URLs', async ({
  browser,
}) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'webmirror-rendition-e2e-'));
  const client = new NativeProcessClient(outputRoot);
  const source = await startDynamicRenditionSource();

  try {
    client.send({
      type: 'handshake',
      requestId: 'handshake-rendition',
      protocolVersion: nativeMessagingProtocolVersion,
      extensionVersion: '0.0.1',
    });
    await expect(
      client.waitFor((message) => message.type === 'handshake_result'),
    ).resolves.toMatchObject({
      type: 'handshake_result',
      accepted: true,
    });
    client.send({
      type: 'mirror_create',
      requestId: 'mirror-rendition',
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: 'rendition-fixture-job',
      capture: {
        sourceUrl: source.sourceUrl,
        title: 'Dynamic rendition fixture',
        capturedAt: new Date().toISOString(),
        completionReason: 'network_idle',
        viewport: {
          width: 1280,
          height: 720,
          deviceScaleFactor: 1,
        },
        resources: [
          {
            sourceUrl: source.sourceUrl,
            method: 'GET',
            contentType: 'text/html',
          },
          {
            sourceUrl: `${source.assetOrigin}/build/assets/styles.css`,
            method: 'GET',
            contentType: 'text/css',
          },
          {
            sourceUrl: `${source.assetOrigin}/build/assets/app.js`,
            method: 'GET',
            contentType: 'application/javascript',
          },
          {
            sourceUrl: `${source.assetOrigin}/build/assets/images/composed.png`,
            method: 'GET',
            contentType: 'image/png',
          },
          {
            sourceUrl: `${source.assetOrigin}/images/icon.svg?v=1`,
            method: 'GET',
            contentType: 'image/svg+xml',
          },
          {
            sourceUrl: `${source.assetOrigin}/images/composed.png`,
            method: 'GET',
            contentType: 'image/png',
          },
          {
            sourceUrl: `${source.assetOrigin}/images/hero.png?v=7&width=100&height=50&crop=center`,
            method: 'GET',
            contentType: 'image/png',
          },
          {
            sourceUrl: `${source.assetOrigin}/images/hero.png?v=7&width=1300&height=650&crop=center`,
            method: 'GET',
            contentType: 'image/png',
          },
        ],
        warnings: [],
      },
    });
    const message = await client.waitFor(
      (candidate) =>
        candidate.type === 'mirror_result' && candidate.requestId === 'mirror-rendition',
      90_000,
    );

    expect(message, nativeFailureMessage(message)).toMatchObject({
      type: 'mirror_result',
      success: true,
      result: {
        status: 'complete',
        downloadedResources: 7,
        failedResources: 0,
        completenessScore: 100,
        onlineDependencies: [],
      },
    });

    await source.closed;
    const result = message as Extract<NativeMirrorResult, { success: true }>;
    const manifest = JSON.parse(await readFile(result.result.manifestPath, 'utf8')) as {
      resources: Array<{
        canonicalUrl: string;
        localPath?: string;
      }>;
    };
    const smallImageResource = manifest.resources.find((resource) =>
      resource.canonicalUrl.includes('width=100&height=50'),
    );
    const largeImagePath = manifest.resources.find((resource) =>
      resource.canonicalUrl.includes('width=1300&height=650'),
    )?.localPath;

    if (!largeImagePath) {
      throw new Error('The rendition fixture manifest did not retain the viewport-sized image.');
    }

    expect(smallImageResource).toBeUndefined();

    const validation = JSON.parse(await readFile(result.result.validationPath ?? '', 'utf8')) as {
      checks: {
        http: { local404s: unknown[] };
        remoteDependencies: { dependencies: unknown[] };
      };
    };
    expect(validation.checks.http.local404s).toEqual([]);
    expect(validation.checks.remoteDependencies.dependencies).toEqual([]);

    const page = await browser.newPage();
    const unexpectedRequests: string[] = [];
    const httpFailures: Array<{ status: number; url: string }> = [];
    const previewOrigin = new URL(result.result.entryUrl ?? '').origin;
    page.on('request', (request) => {
      if (new URL(request.url()).origin !== previewOrigin) {
        unexpectedRequests.push(request.url());
      }
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        httpFailures.push({
          status: response.status(),
          url: response.url(),
        });
      }
    });
    await page.goto(result.result.entryUrl ?? '');
    await expect(page.locator('#status')).toHaveText('runtime localized');
    await expect.poll(() => page.locator('body').getAttribute('data-composed')).toBe('loaded');
    await expect.poll(() => page.locator('body').getAttribute('data-markup')).toBe('loaded');
    const runtimeState = await page.evaluate(() => ({
      composedSrc: (document.querySelector('#composed') as HTMLImageElement).src,
      exactSrc: document.body.dataset.exactSrc,
      iconMask:
        getComputedStyle(document.querySelector('#icon') as Element).maskImage ||
        getComputedStyle(document.querySelector('#icon') as Element).webkitMaskImage,
      markupSrc: (document.querySelector('#markup-image') as HTMLImageElement).src,
      variantSrc: document.body.dataset.variantSrc,
    }));
    expect(runtimeState.composedSrc).toContain(`${previewOrigin}/_external/`);
    expect(runtimeState.exactSrc).toBe(
      `${previewOrigin}/${largeImagePath.replace(/^site\//u, '')}`,
    );
    expect(runtimeState.markupSrc).toContain(`${previewOrigin}/_external/`);
    expect(runtimeState.variantSrc).toBe(
      `${previewOrigin}/${largeImagePath.replace(/^site\//u, '')}`,
    );
    expect(runtimeState.iconMask).toContain(`${previewOrigin}/_external/`);
    expect(unexpectedRequests).toEqual([]);
    expect(httpFailures).toEqual([]);
    await page.close();
  } finally {
    await client.close();
    await source.close();
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('localizes route-prefixed runtime paths and volatile cache-busting CMS URLs', async ({
  browser,
}) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'webmirror-route-timestamp-e2e-'));
  const client = new NativeProcessClient(outputRoot);
  const source = await startRouteAndTimestampSource();
  const sourceOrigin = new URL(source.sourceUrl).origin;

  try {
    client.send({
      type: 'handshake',
      requestId: 'handshake-route-timestamp',
      protocolVersion: nativeMessagingProtocolVersion,
      extensionVersion: '0.0.1',
    });
    await expect(
      client.waitFor((message) => message.type === 'handshake_result'),
    ).resolves.toMatchObject({
      type: 'handshake_result',
      accepted: true,
    });
    client.send({
      type: 'mirror_create',
      requestId: 'mirror-route-timestamp',
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: 'route-timestamp-fixture-job',
      capture: {
        sourceUrl: source.sourceUrl,
        title: 'Route and timestamp fixture',
        capturedAt: new Date().toISOString(),
        completionReason: 'network_idle',
        viewport: {
          width: 1280,
          height: 720,
          deviceScaleFactor: 1,
        },
        resources: [
          {
            sourceUrl: source.sourceUrl,
            method: 'GET',
            contentType: 'text/html',
          },
          {
            sourceUrl: `${sourceOrigin}/assets/route-app.js`,
            method: 'GET',
            contentType: 'application/javascript',
          },
          {
            sourceUrl: `${sourceOrigin}/assets/scene.bin`,
            method: 'GET',
            contentType: 'application/octet-stream',
          },
          {
            sourceUrl: source.cmsResourceUrl,
            method: 'GET',
            contentType: 'application/json',
          },
          {
            sourceUrl: source.cmsMediaUrl,
            method: 'GET',
            contentType: 'application/octet-stream',
          },
          {
            sourceUrl: source.cmsObjectStoreMediaUrl,
            method: 'GET',
            contentType: 'application/octet-stream',
          },
        ],
        warnings: [],
      },
    });
    const message = await client.waitFor(
      (candidate) =>
        candidate.type === 'mirror_result' && candidate.requestId === 'mirror-route-timestamp',
      90_000,
    );

    expect(message, nativeFailureMessage(message)).toMatchObject({
      type: 'mirror_result',
      success: true,
      result: {
        status: 'complete',
        downloadedResources: 6,
        failedResources: 0,
        completenessScore: 100,
        onlineDependencies: [],
      },
    });

    const result = message as Extract<NativeMirrorResult, { success: true }>;
    expect(new URL(result.result.entryUrl ?? '').pathname).toBe('/work');
    const validation = JSON.parse(await readFile(result.result.validationPath ?? '', 'utf8')) as {
      checks: {
        http: { local404s: unknown[] };
        remoteDependencies: { dependencies: unknown[] };
        runtime: {
          blockingConsoleErrors: unknown[];
          pageErrors: unknown[];
        };
      };
    };
    expect(validation.checks.http.local404s).toEqual([]);
    expect(validation.checks.remoteDependencies.dependencies).toEqual([]);
    expect(validation.checks.runtime.blockingConsoleErrors).toEqual([]);
    expect(validation.checks.runtime.pageErrors).toEqual([]);

    const routePrefixedAsset = await fetch(
      new URL('/work/assets/scene.bin', result.result.entryUrl ?? '').toString(),
    );
    expect(routePrefixedAsset.status).toBe(200);
    expect(await routePrefixedAsset.text()).toBe('route-prefixed scene');
    const externalRouteAsset = await fetch(
      new URL('/media/scene.bin', result.result.entryUrl ?? '').toString(),
    );
    expect(externalRouteAsset.status).toBe(200);
    expect(await externalRouteAsset.text()).toBe('external route scene');
    const routePrefixedExternalAsset = await fetch(
      new URL('/work/media/scene.bin', result.result.entryUrl ?? '').toString(),
    );
    expect(routePrefixedExternalAsset.status).toBe(200);
    expect(await routePrefixedExternalAsset.text()).toBe('external route scene');
    const objectStoreExternalAsset = await fetch(
      new URL('/media/proxy.bin', result.result.entryUrl ?? '').toString(),
    );
    expect(objectStoreExternalAsset.status).toBe(200);
    expect(await objectStoreExternalAsset.text()).toBe('object-store route scene');
    const routePrefixedObjectStoreExternalAsset = await fetch(
      new URL('/work/media/proxy.bin', result.result.entryUrl ?? '').toString(),
    );
    expect(routePrefixedObjectStoreExternalAsset.status).toBe(200);
    expect(await routePrefixedObjectStoreExternalAsset.text()).toBe('object-store route scene');

    const localizedHtml = await readFile(
      join(result.result.outputDirectory, 'site', 'work.html'),
      'utf8',
    );
    expect(localizedHtml).toContain('var volatileQueryAliasMap=new Map(');
    expect(localizedHtml).toContain('CMS_DATA_\\u003ctimestamp>');
    expect(localizedHtml).toContain('function mappedRoutePrefixedLocalReference(source)');

    const page = await browser.newPage();
    const unexpectedRequests: string[] = [];
    const localHttpFailures: Array<{ status: number; url: string }> = [];
    const previewOrigin = new URL(result.result.entryUrl ?? '').origin;
    await page.route('**/*', async (route) => {
      const requestOrigin = new URL(route.request().url()).origin;

      if (requestOrigin !== previewOrigin) {
        unexpectedRequests.push(route.request().url());
        await route.abort();
        return;
      }

      await route.continue();
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        localHttpFailures.push({
          status: response.status(),
          url: response.url(),
        });
      }
    });

    await page.goto(result.result.entryUrl ?? '');
    await expect(page.locator('#status')).toHaveText('route and timestamp resources localized');
    const offlineRuntimeState = await page.evaluate(async () => {
      const uncapturedBase = `https://offline-missing-${Date.now()}.invalid`;
      const response = await fetch(`${uncapturedBase}/runtime-data.json`);
      const emptyData = await response.json();
      const video = document.createElement('video');
      video.src = `${uncapturedBase}/runtime-media.mp4`;
      const worker = new Worker(`${uncapturedBase}/runtime-worker.js`);
      worker.terminate();
      let scriptSrc = '';
      const scriptResult = await new Promise((resolve) => {
        const script = document.createElement('script');
        script.onload = () => resolve('load');
        script.onerror = () => resolve('error');
        script.src = `${uncapturedBase}/cdn/wpm/b/offline/m.js`;
        scriptSrc = script.src;
        document.head.append(script);
      });

      return {
        emptyData,
        scriptResult,
        scriptSrc,
        uncapturedFetchStatus: response.status,
        uncapturedFetchUrl: response.url,
        uncapturedMediaUrl: video.src,
      };
    });
    expect(offlineRuntimeState.uncapturedFetchStatus).toBe(200);
    expect(offlineRuntimeState.uncapturedFetchUrl).toBe(`${previewOrigin}/.webmirror/noop`);
    expect(offlineRuntimeState.uncapturedMediaUrl).toBe(`${previewOrigin}/.webmirror/noop`);
    expect(offlineRuntimeState.emptyData).toMatchObject({
      item_count: 0,
      items: [],
      success: false,
      data: {
        list: [],
        sessionTrackingConsent: { enabled: false },
        data: { url: '' },
      },
    });
    expect(offlineRuntimeState.scriptResult).toBe('error');
    expect(offlineRuntimeState.scriptSrc).toBe(`${previewOrigin}/.webmirror/unavailable.js`);
    expect(unexpectedRequests).toEqual([]);
    expect(localHttpFailures).toEqual([
      {
        status: 404,
        url: `${previewOrigin}/.webmirror/unavailable.js`,
      },
    ]);
    await page.close();
  } finally {
    await client.close();
    await source.close();
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('cancels an in-flight download without reporting a successful mirror', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'webmirror-cancel-e2e-'));
  const client = new NativeProcessClient(outputRoot);

  try {
    client.send({
      type: 'handshake',
      requestId: 'handshake-cancel',
      protocolVersion: nativeMessagingProtocolVersion,
      extensionVersion: '0.0.1',
    });
    await client.waitFor((message) => message.type === 'handshake_result');
    client.send({
      type: 'mirror_create',
      requestId: 'mirror-cancel',
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: 'cancel-fixture-job',
      capture: {
        sourceUrl: 'http://127.0.0.1:4178/basic/',
        title: 'Cancellation fixture',
        capturedAt: new Date().toISOString(),
        completionReason: 'network_idle',
        resources: [
          {
            sourceUrl: 'http://127.0.0.1:4178/basic/',
            method: 'GET',
            contentType: 'text/html',
          },
          {
            sourceUrl: 'http://127.0.0.1:4178/slow.bin',
            method: 'GET',
            contentType: 'application/octet-stream',
          },
        ],
        warnings: [],
      },
    });
    await client.waitFor(
      (message) =>
        message.type === 'mirror_progress' &&
        message.jobId === 'cancel-fixture-job' &&
        message.state === 'downloading',
    );
    client.send({
      type: 'mirror_cancel',
      requestId: 'cancel-1',
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: 'cancel-fixture-job',
    });
    await expect(
      client.waitFor(
        (message) => message.type === 'mirror_cancel_result' && message.requestId === 'cancel-1',
      ),
    ).resolves.toMatchObject({
      type: 'mirror_cancel_result',
      accepted: true,
    });
    await expect(
      client.waitFor(
        (message) => message.type === 'mirror_result' && message.requestId === 'mirror-cancel',
      ),
    ).resolves.toMatchObject({
      type: 'mirror_result',
      success: true,
      result: {
        status: 'cancelled',
      },
    });
  } finally {
    await client.close();
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('retries only failed resources and promotes a partial mirror to complete', async ({
  request,
}) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'webmirror-retry-e2e-'));
  const client = new NativeProcessClient(outputRoot);

  try {
    client.send({
      type: 'handshake',
      requestId: 'handshake-retry',
      protocolVersion: nativeMessagingProtocolVersion,
      extensionVersion: '0.0.1',
    });
    await client.waitFor((message) => message.type === 'handshake_result');
    const origin = 'http://127.0.0.1:4178/basic/';
    const retryId = `retry-e2e-${randomUUID()}`;
    client.send({
      type: 'mirror_create',
      requestId: 'mirror-retry',
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: 'retry-fixture-job',
      capture: {
        sourceUrl: origin,
        title: 'Retry fixture',
        capturedAt: new Date().toISOString(),
        completionReason: 'network_idle',
        resources: [
          { sourceUrl: origin, method: 'GET', contentType: 'text/html' },
          {
            sourceUrl: `${origin}styles.css`,
            method: 'GET',
            contentType: 'text/css',
          },
          {
            sourceUrl: `${origin}app.js`,
            method: 'GET',
            contentType: 'application/javascript',
          },
          {
            sourceUrl: `${origin}fixture-art.svg`,
            method: 'GET',
            contentType: 'image/svg+xml',
          },
          {
            sourceUrl: `http://127.0.0.1:4178/flaky.bin?id=${retryId}&failures=6`,
            method: 'GET',
            contentType: 'application/octet-stream',
          },
        ],
        warnings: [],
      },
    });
    const initialResult = await client.waitFor(
      (message) => message.type === 'mirror_result' && message.requestId === 'mirror-retry',
      90_000,
    );
    expect(initialResult, nativeFailureMessage(initialResult)).toMatchObject({
      type: 'mirror_result',
      success: true,
      result: {
        status: 'partial',
        failedResources: 1,
      },
    });
    await expect(
      request
        .get(`http://127.0.0.1:4178/flaky-count?id=${retryId}`)
        .then((response) => response.json()),
    ).resolves.toEqual({ count: 6 });

    client.send({
      type: 'job_action',
      requestId: 'retry-action',
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: 'retry-fixture-job',
      action: 'retry_failed',
    });
    const actionResult = client.waitFor(
      (message) => message.type === 'job_action_result' && message.requestId === 'retry-action',
      90_000,
    );
    await expect(actionResult).resolves.toMatchObject({
      type: 'job_action_result',
      action: 'retry_failed',
      success: true,
      result: {
        status: 'complete',
        downloadedResources: 5,
        failedResources: 0,
        completenessScore: 100,
      },
    });
    await expect(
      request
        .get(`http://127.0.0.1:4178/flaky-count?id=${retryId}`)
        .then((response) => response.json()),
    ).resolves.toEqual({ count: 7 });
  } finally {
    await client.close();
    await rm(outputRoot, { recursive: true, force: true });
  }
});
