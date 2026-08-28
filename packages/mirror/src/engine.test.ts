import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContentAddressedCache } from './cache.js';
import { createMirrorForTesting } from './engine.js';
import { maximumSecretScanBytes, scanFileForHighConfidenceSecrets } from './secret-scan.js';
import { createTestDirectory, removeTestDirectory } from './test-utils.js';
import type { MirrorManifest } from './types.js';

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

describe('createMirror', () => {
  let directory: string;
  let server: Server | undefined;

  beforeEach(async () => {
    directory = await createTestDirectory('webmirror-engine-');
  });

  afterEach(async () => {
    if (server) {
      await close(server);
      server = undefined;
    }

    await removeTestDirectory(directory);
  });

  it('downloads concurrently and writes mirror.json', async () => {
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    server = createServer((request, response) => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      setTimeout(() => {
        activeRequests -= 1;
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(request.url ?? '');
      }, 40);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: `${origin}/index.html`,
        title: 'Fixture',
        runtimeCapabilities: {
          webgl: { compressedTextureFamilies: ['s3tc'] },
          webgl2: { compressedTextureFamilies: ['etc'] },
        },
        resources: [
          { sourceUrl: `${origin}/a.txt`, contentType: 'text/plain' },
          { sourceUrl: `${origin}/b.txt`, contentType: 'text/plain' },
          { sourceUrl: `${origin}/c.txt`, contentType: 'text/plain' },
        ],
      },
      {
        outputDirectory: directory,
        concurrency: 2,
        maxRetries: 0,
      },
    );

    const writtenManifest = JSON.parse(
      await readFile(`${directory}/mirror.json`, 'utf8'),
    ) as MirrorManifest;

    expect(maximumActiveRequests).toBe(2);
    expect(manifest.status).toBe('complete');
    expect(manifest.runtimeCapabilities).toEqual({
      webgl: { compressedTextureFamilies: ['s3tc'] },
      webgl2: { compressedTextureFamilies: ['etc'] },
    });
    expect(manifest.summary).toMatchObject({
      totalResources: 3,
      downloadedResources: 3,
      failedResources: 0,
      totalBytes: 18,
    });
    expect(manifest.resources.map((resource) => resource.localPath)).toEqual([
      'site/a.txt',
      'site/b.txt',
      'site/c.txt',
    ]);
    expect(writtenManifest).toEqual(manifest);
  });

  it('does not commit or recursively discover an HTML fallback returned for a script', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html><script src="/should-not-be-discovered.js"></script></html>',
      );
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: `${origin}/`,
        resources: [
          {
            sourceUrl: `${origin}/missing.js`,
            contentType: 'application/javascript',
            resourceType: 'Script',
          },
        ],
      },
      {
        outputDirectory: directory,
        maxRetries: 0,
      },
    );

    expect(manifest.summary).toMatchObject({
      totalResources: 1,
      downloadedResources: 0,
      failedResources: 1,
    });
    expect(manifest.resources[0]).toMatchObject({
      status: 'failed',
      retryable: false,
      error: expect.stringContaining('incompatible'),
    });
    expect(
      manifest.resources.some((resource) =>
        resource.sourceUrl.endsWith('should-not-be-discovered.js'),
      ),
    ).toBe(false);
  });

  it('omits known nonessential external resources from the mirror plan', async () => {
    let requests = 0;
    server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><script src="https://www.googletagmanager.com/gtm.js?id=GTM-TEST"></script>',
      );
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const sourceUrl = `http://127.0.0.1:${address.port}/index.html`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl,
        resources: [
          { sourceUrl, contentType: 'text/html' },
          {
            sourceUrl: 'https://www.googletagmanager.com/gtm.js?id=GTM-TEST',
            contentType: 'application/javascript',
          },
        ],
      },
      {
        outputDirectory: directory,
        maxRetries: 0,
      },
    );

    expect(requests).toBe(1);
    expect(manifest.status).toBe('complete');
    expect(manifest.summary).toMatchObject({
      totalResources: 1,
      downloadedResources: 1,
      failedResources: 0,
    });
    expect(manifest.resources.map((resource) => resource.canonicalUrl)).toEqual([sourceUrl]);
    expect(await readFile(`${directory}/site/index.html`, 'utf8')).toContain(
      'data-webmirror-disabled="tracking"',
    );
  });

  it('uses a verified browser body when a direct GET would return 403', async () => {
    let requests = 0;
    server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('cookie required');
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const body = Buffer.from('window.browserBodyReady = true;\n', 'utf8');
    const capturedBodyPath = `${directory}/captured-body.tmp`;
    await writeFile(capturedBodyPath, body);
    const sourceUrl = `http://127.0.0.1:${address.port}/protected.js`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl,
        resources: [
          {
            sourceUrl,
            contentType: 'application/javascript',
            expectedSize: body.byteLength,
            capturedBody: {
              filePath: capturedBodyPath,
              byteLength: body.byteLength,
              sha256: createHash('sha256').update(body).digest('hex'),
              contentType: 'application/javascript',
              httpStatus: 200,
            },
          },
        ],
      },
      {
        outputDirectory: directory,
        maxRetries: 0,
      },
    );

    expect(requests).toBe(0);
    expect(manifest.status).toBe('complete');
    expect(manifest.resources[0]).toMatchObject({
      status: 'downloaded',
      bodySource: 'browser',
      httpStatus: 200,
    });
    expect(await readFile(`${directory}/site/protected.js`)).toEqual(body);
  });

  it('quarantines high-confidence credentials instead of reporting complete', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(
        JSON.stringify({
          access_token: 'eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJlLXZhbHVl',
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const sourceUrl = `http://127.0.0.1:${address.port}/private.bin`;
    const cacheDirectory = join(directory, 'cache');
    const manifest = await createMirrorForTesting(
      {
        sourceUrl,
        resources: [{ sourceUrl, contentType: 'application/octet-stream' }],
      },
      {
        outputDirectory: directory,
        cacheDirectory,
        maxRetries: 0,
      },
    );

    expect(manifest.status).toBe('failed');
    expect(manifest.resources[0]).toMatchObject({
      status: 'failed',
      securityIssue: 'sensitive_content',
      error: expect.stringContaining('sensitive content'),
    });
    await expect(readFile(`${directory}/site/private.bin`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      new ContentAddressedCache(cacheDirectory).lookup(sourceUrl),
    ).resolves.toBeUndefined();
  });

  it('retains downloaded text resources that exceed the bounded secret-scan size', async () => {
    let requests = 0;
    server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(500);
      response.end('captured body should be reused');
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const body = Buffer.alloc(maximumSecretScanBytes + 1, 0x61);
    const capturedBodyPath = join(directory, 'large-text-body.tmp');
    await writeFile(capturedBodyPath, body);
    const sourceUrl = `http://127.0.0.1:${address.port}/assets/tree.txt`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl,
        resources: [
          {
            sourceUrl,
            contentType: 'text/plain',
            expectedSize: body.byteLength,
            capturedBody: {
              filePath: capturedBodyPath,
              byteLength: body.byteLength,
              sha256: createHash('sha256').update(body).digest('hex'),
              contentType: 'text/plain',
              httpStatus: 200,
            },
          },
        ],
      },
      {
        outputDirectory: directory,
        maxDiscoveryRounds: 0,
        maxResourceBytes: body.byteLength + 1,
        maxRetries: 0,
      },
    );
    const resource = manifest.resources[0];

    expect(requests).toBe(0);
    expect(manifest.status).toBe('partial');
    expect(resource).toMatchObject({
      status: 'downloaded',
      localPath: 'site/assets/tree.txt',
    });
    expect(resource?.securityIssue).toBeUndefined();
    await expect(stat(join(directory, 'site', 'assets', 'tree.txt'))).resolves.toMatchObject({
      size: body.byteLength,
    });
    expect(manifest.warnings.join(' ')).toContain('scan limit');
    expect(manifest.warnings.join(' ')).toContain('retained without inspection');
  });

  it('redacts static JavaScript credential literals without caching the original runtime', async () => {
    const bearer = `Bearer ${'a'.repeat(40)}`;
    const providerKey = `sk-test-${'b'.repeat(40)}`;
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      response.end(
        [
          'const headers = {',
          `  authorization: ${JSON.stringify(bearer)},`,
          `  "xi-api-key": ${JSON.stringify(providerKey)},`,
          '};',
          'window.runtimeBooted = true;',
        ].join('\n'),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const sourceUrl = `http://127.0.0.1:${address.port}/app.js`;
    const cacheDirectory = join(directory, 'cache');
    const manifest = await createMirrorForTesting(
      {
        sourceUrl,
        resources: [{ sourceUrl, contentType: 'application/javascript' }],
      },
      {
        outputDirectory: directory,
        cacheDirectory,
        maxRetries: 0,
      },
    );
    const outputPath = `${directory}/site/app.js`;
    const output = await readFile(outputPath, 'utf8');

    expect(manifest.status).toBe('partial');
    expect(manifest.resources[0]).toMatchObject({
      status: 'downloaded',
      credentialsRedacted: true,
    });
    expect(manifest.resources[0]?.securityIssue).toBeUndefined();
    expect(manifest.warnings.join(' ')).toContain('Static credential literals were redacted');
    expect(output).toContain('window.runtimeBooted = true;');
    expect(output).not.toContain(bearer);
    expect(output).not.toContain(providerKey);
    await expect(
      scanFileForHighConfidenceSecrets(outputPath, 'application/javascript', 'site/app.js'),
    ).resolves.toEqual({
      scanned: true,
      findings: [],
    });
    expect(JSON.stringify(manifest)).not.toContain(bearer);
    expect(JSON.stringify(manifest)).not.toContain(providerKey);
    await expect(
      new ContentAddressedCache(cacheDirectory).lookup(sourceUrl),
    ).resolves.toBeUndefined();
  });

  it('redacts sensitive URL query values before writing the manifest', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Private URL fixture</title>');
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const sourceUrl = `http://127.0.0.1:${address.port}/index.html?rev=7&token=supersecret`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl,
        resources: [{ sourceUrl, contentType: 'text/html' }],
      },
      {
        outputDirectory: directory,
        maxRetries: 0,
      },
    );
    const serialized = await readFile(`${directory}/mirror.json`, 'utf8');

    expect(manifest.source.url).toContain('rev=7');
    expect(manifest.source.url).toContain('token=REDACTED');
    expect(serialized).not.toContain('supersecret');
  });

  it('marks malformed text resources partial instead of reporting a false complete result', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      response.end('body { background: url("unterminated.png" ');
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const sourceUrl = `http://127.0.0.1:${address.port}/broken.css`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl,
        resources: [{ sourceUrl, contentType: 'text/css' }],
      },
      {
        outputDirectory: directory,
        maxRetries: 0,
      },
    );

    expect(manifest.status).toBe('partial');
    expect(manifest.warnings.join(' ')).toContain('Could not');
  });

  it('recursively downloads static dependencies and bounded same-origin navigation pages', async () => {
    const requestedPaths: string[] = [];
    const responses = new Map<
      string,
      {
        contentType: string;
        body: string | Buffer;
      }
    >([
      [
        '/index.html',
        {
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html>
            <link rel="stylesheet" href="/styles/site.css">
            <script type="module" src="/scripts/app.js"></script>
            <a href="/next.html">Next</a>
            <meta http-equiv="refresh" content="30; url=/redirect.html">`,
        },
      ],
      [
        '/styles/site.css',
        {
          contentType: 'text/css; charset=utf-8',
          body: `@import "./theme.css";
            body { background-image: url("../images/bg.svg"); }`,
        },
      ],
      [
        '/scripts/app.js',
        {
          contentType: 'application/javascript; charset=utf-8',
          body: `import "./chunk.js";`,
        },
      ],
      [
        '/styles/theme.css',
        {
          contentType: 'text/css; charset=utf-8',
          body: `@font-face { src: url("../fonts/demo.woff2"); }`,
        },
      ],
      [
        '/images/bg.svg',
        {
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>',
        },
      ],
      [
        '/scripts/chunk.js',
        {
          contentType: 'application/javascript; charset=utf-8',
          body: `fetch("../data/config.json");`,
        },
      ],
      [
        '/fonts/demo.woff2',
        {
          contentType: 'font/woff2',
          body: Buffer.from([0x77, 0x4f, 0x46, 0x32]),
        },
      ],
      [
        '/data/config.json',
        {
          contentType: 'application/json; charset=utf-8',
          body: '{"ready":true}\n',
        },
      ],
      [
        '/next.html',
        {
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><title>Next</title><a href="https://outside.example/page.html">Outside</a>',
        },
      ],
    ]);
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);
      const fixture = responses.get(path);

      if (!fixture) {
        response.writeHead(404);
        response.end('not found');
        return;
      }

      response.writeHead(200, { 'content-type': fixture.contentType });
      response.end(fixture.body);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const sourceUrl = `${origin}/index.html`;
    const plannedUrls: string[] = [];
    const manifest = await createMirrorForTesting(
      {
        sourceUrl,
        resources: [{ sourceUrl, contentType: 'text/html' }],
      },
      {
        outputDirectory: directory,
        maxDiscoveryRounds: 3,
        maxNavigationPages: 1,
        maxRetries: 0,
        onResourcePlanned: (resource) => plannedUrls.push(resource.canonicalUrl),
      },
    );
    const localizedHtml = await readFile(`${directory}/site/index.html`, 'utf8');

    expect(manifest.status).toBe('complete');
    expect(manifest.summary).toMatchObject({
      totalResources: 9,
      downloadedResources: 9,
      failedResources: 0,
    });
    expect(requestedPaths).toContain('/next.html');
    expect(requestedPaths).not.toContain('/redirect.html');
    expect(plannedUrls).toEqual(
      expect.arrayContaining([
        `${origin}/index.html`,
        `${origin}/styles/site.css`,
        `${origin}/scripts/app.js`,
        `${origin}/data/config.json`,
      ]),
    );
    expect(localizedHtml).toContain('href="styles/site.css"');
    expect(localizedHtml).toContain('href="next.html"');
    expect(manifest.onlineDependencies).toEqual([]);
  });

  it('keeps optional navigation inside the active route subtree', async () => {
    const requestedPaths: string[] = [];
    const responses = new Map<
      string,
      {
        contentType: string;
        body: string;
      }
    >([
      [
        '/editions/winter2026',
        {
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html>
            <a href="/editions/winter2026/feature">Feature</a>
            <a href="/ae">Global locale</a>
            <a href="/pricing">Pricing</a>`,
        },
      ],
      [
        '/editions/winter2026/feature',
        {
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><title>Feature</title>',
        },
      ],
      [
        '/ae',
        {
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><title>Global locale</title>',
        },
      ],
      [
        '/pricing',
        {
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><title>Pricing</title>',
        },
      ],
    ]);
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);
      const fixture = responses.get(path);

      if (!fixture) {
        response.writeHead(404);
        response.end('not found');
        return;
      }

      response.writeHead(200, { 'content-type': fixture.contentType });
      response.end(fixture.body);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const sourceUrl = `${origin}/editions/winter2026`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl,
        resources: [{ sourceUrl, contentType: 'text/html' }],
      },
      {
        outputDirectory: directory,
        maxDiscoveryRounds: 2,
        maxNavigationPages: 4,
        maxRetries: 0,
      },
    );

    expect(requestedPaths).toContain('/editions/winter2026/feature');
    expect(requestedPaths).not.toContain('/ae');
    expect(requestedPaths).not.toContain('/pricing');
    expect(manifest.summary).toMatchObject({
      totalResources: 2,
      downloadedResources: 2,
      failedResources: 0,
    });
    expect(manifest.status).toBe('partial');
    expect(manifest.warnings.join(' ')).toContain('outside the active route subtree');
  });

  it('does not crawl optional same-origin navigation pages by default', async () => {
    const requestedPaths: string[] = [];
    const responses = new Map<
      string,
      {
        contentType: string;
        body: string;
      }
    >([
      [
        '/index.html',
        {
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html>
            <script type="module" src="/runtime/entry.js"></script>
            <a href="/products">Products</a>
            <a href="/pricing">Pricing</a>`,
        },
      ],
      [
        '/runtime/entry.js',
        {
          contentType: 'application/javascript; charset=utf-8',
          body: 'import "./chunk.js";',
        },
      ],
      [
        '/runtime/chunk.js',
        {
          contentType: 'application/javascript; charset=utf-8',
          body: 'window.runtimeReady = true;',
        },
      ],
      [
        '/products',
        {
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><script src="/products-app.js"></script>',
        },
      ],
      [
        '/pricing',
        {
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><script src="/pricing-app.js"></script>',
        },
      ],
    ]);
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);
      const fixture = responses.get(path);

      if (!fixture) {
        response.writeHead(404);
        response.end('not found');
        return;
      }

      response.writeHead(200, { 'content-type': fixture.contentType });
      response.end(fixture.body);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: `${origin}/index.html`,
        resources: [
          {
            sourceUrl: `${origin}/index.html`,
            contentType: 'text/html',
          },
        ],
      },
      {
        outputDirectory: directory,
        maxRetries: 0,
      },
    );

    expect(requestedPaths).toEqual(
      expect.arrayContaining(['/index.html', '/runtime/entry.js', '/runtime/chunk.js']),
    );
    expect(requestedPaths).not.toEqual(expect.arrayContaining(['/products', '/pricing']));
    expect(manifest.summary).toMatchObject({
      totalResources: 3,
      downloadedResources: 3,
      failedResources: 0,
    });
    expect(manifest.status).toBe('complete');
  });

  it('preserves the current page runtime closure before optional navigation pages', async () => {
    const requestedPaths: string[] = [];
    const responses = new Map<
      string,
      {
        contentType: string;
        body: string | Buffer;
      }
    >([
      [
        '/index.html',
        {
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html>
            <link rel="stylesheet" href="/z-critical.css">
            <script type="module" src="/z-entry.js"></script>
            <a href="/a-navigation">A</a>
            <a href="/b-navigation">B</a>
            <a href="/c-navigation">C</a>
            <a href="/d-navigation">D</a>`,
        },
      ],
      [
        '/z-entry.js',
        {
          contentType: 'application/javascript; charset=utf-8',
          body: 'import "./z-runtime.js";',
        },
      ],
      [
        '/z-runtime.js',
        {
          contentType: 'application/javascript; charset=utf-8',
          body: 'window.runtimeReady = true;',
        },
      ],
      [
        '/z-critical.css',
        {
          contentType: 'text/css; charset=utf-8',
          body: '@font-face { font-family: Demo; src: url("./z-critical.woff2"); }',
        },
      ],
      [
        '/z-critical.woff2',
        {
          contentType: 'font/woff2',
          body: Buffer.from([0x77, 0x4f, 0x46, 0x32]),
        },
      ],
      ...['a', 'b', 'c', 'd'].map(
        (name) =>
          [
            `/${name}-navigation`,
            {
              contentType: 'text/html; charset=utf-8',
              body: `<!doctype html><title>${name}</title>`,
            },
          ] as const,
      ),
    ]);
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);
      const fixture = responses.get(path);

      if (!fixture) {
        response.writeHead(404);
        response.end('not found');
        return;
      }

      response.writeHead(200, { 'content-type': fixture.contentType });
      response.end(fixture.body);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: `${origin}/index.html`,
        resources: [
          {
            sourceUrl: `${origin}/index.html`,
            contentType: 'text/html',
          },
        ],
      },
      {
        outputDirectory: directory,
        maxDiscoveryRounds: 3,
        maxNavigationPages: 4,
        maxResources: 5,
        maxRetries: 0,
      },
    );

    expect(requestedPaths).toEqual(
      expect.arrayContaining([
        '/index.html',
        '/z-entry.js',
        '/z-runtime.js',
        '/z-critical.css',
        '/z-critical.woff2',
      ]),
    );
    expect(requestedPaths).not.toEqual(
      expect.arrayContaining(['/a-navigation', '/b-navigation', '/c-navigation', '/d-navigation']),
    );
    expect(manifest.summary).toMatchObject({
      totalResources: 5,
      downloadedResources: 5,
      failedResources: 0,
    });
    expect(manifest.status).toBe('partial');
    expect(manifest.warnings.join(' ')).toContain('Capability boundary');
    expect(manifest.warnings.join(' ')).toContain('resource limit');
  }, 15_000);

  it('prioritizes serialized runtime assets before deferred images at the resource limit', async () => {
    const requestedPaths: string[] = [];
    let origin = '';
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);

      if (path === '/index.html') {
        const payload = JSON.stringify({
          images: [
            `${origin}/images/01.webp`,
            `${origin}/images/02.webp`,
            `${origin}/images/03.webp`,
            `${origin}/images/04.webp`,
          ],
          runtime: {
            wasm: `${origin}/runtime/core.wasm`,
            scene: `${origin}/runtime/scene.json`,
            video: `${origin}/media/intro.webm`,
          },
        });
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          `<!doctype html><script>window.runtime.enqueue(${JSON.stringify(payload)});</script>`,
        );
        return;
      }

      const contentTypes = new Map([
        ['/runtime/core.wasm', 'application/wasm'],
        ['/runtime/scene.json', 'application/json; charset=utf-8'],
        ['/media/intro.webm', 'video/webm'],
        ['/images/01.webp', 'image/webp'],
        ['/images/02.webp', 'image/webp'],
        ['/images/03.webp', 'image/webp'],
        ['/images/04.webp', 'image/webp'],
      ]);
      const contentType = contentTypes.get(path);

      if (!contentType) {
        response.writeHead(404);
        response.end('not found');
        return;
      }

      response.writeHead(200, { 'content-type': contentType });
      response.end(path === '/runtime/scene.json' ? '{}' : path);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    origin = `http://127.0.0.1:${address.port}`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: `${origin}/index.html`,
        resources: [
          {
            sourceUrl: `${origin}/index.html`,
            contentType: 'text/html',
          },
        ],
      },
      {
        outputDirectory: directory,
        maxDiscoveryRounds: 2,
        maxResources: 4,
        maxRetries: 0,
      },
    );

    expect(requestedPaths).toEqual(
      expect.arrayContaining([
        '/index.html',
        '/runtime/core.wasm',
        '/runtime/scene.json',
        '/media/intro.webm',
      ]),
    );
    expect(requestedPaths.some((path) => path.startsWith('/images/'))).toBe(false);
    expect(manifest.summary).toMatchObject({
      totalResources: 4,
      downloadedResources: 4,
      failedResources: 0,
    });
    expect(manifest.status).toBe('partial');
    expect(manifest.warnings.join(' ')).toContain('resource limit');
  });

  it('does not let a first-round image flood consume a deeper module closure', async () => {
    const requestedPaths: string[] = [];
    const imageReferences = Array.from(
      { length: 8 },
      (_, index) => `<img src="/images/hero-${String(index + 1).padStart(2, '0')}.png">`,
    ).join('');
    const responses = new Map<
      string,
      {
        contentType: string;
        body: string;
      }
    >([
      [
        '/index.html',
        {
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html>
            ${imageReferences}
            <script type="module" src="/runtime/entry.js"></script>`,
        },
      ],
      [
        '/runtime/entry.js',
        {
          contentType: 'application/javascript; charset=utf-8',
          body: 'import "./level-1.js";',
        },
      ],
      [
        '/runtime/level-1.js',
        {
          contentType: 'application/javascript; charset=utf-8',
          body: 'import "./level-2.js";',
        },
      ],
      [
        '/runtime/level-2.js',
        {
          contentType: 'application/javascript; charset=utf-8',
          body: 'window.runtimeReady = true;',
        },
      ],
      ...Array.from(
        { length: 8 },
        (_, index) =>
          [
            `/images/hero-${String(index + 1).padStart(2, '0')}.png`,
            {
              contentType: 'image/png',
              body: `image-${index + 1}`,
            },
          ] as const,
      ),
    ]);
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);
      const fixture = responses.get(path);

      if (!fixture) {
        response.writeHead(404);
        response.end('not found');
        return;
      }

      response.writeHead(200, { 'content-type': fixture.contentType });
      response.end(fixture.body);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: `${origin}/index.html`,
        resources: [
          {
            sourceUrl: `${origin}/index.html`,
            contentType: 'text/html',
          },
        ],
      },
      {
        outputDirectory: directory,
        maxDiscoveryRounds: 4,
        maxResources: 5,
        maxRetries: 0,
      },
    );

    expect(requestedPaths).toEqual(
      expect.arrayContaining([
        '/index.html',
        '/runtime/entry.js',
        '/runtime/level-1.js',
        '/runtime/level-2.js',
        '/images/hero-01.png',
      ]),
    );
    expect(requestedPaths).not.toEqual(
      expect.arrayContaining(['/images/hero-02.png', '/images/hero-03.png', '/images/hero-04.png']),
    );
    expect(manifest.summary).toMatchObject({
      totalResources: 5,
      downloadedResources: 5,
      failedResources: 0,
    });
    expect(manifest.status).toBe('partial');
    expect(manifest.warnings.join(' ')).toContain('resource limit');
  });

  it('applies the hard resource limit to browser-observed images before deep modules', async () => {
    const requestedPaths: string[] = [];
    const imagePaths = Array.from(
      { length: 8 },
      (_, index) => `/images/observed-${String(index + 1).padStart(2, '0')}.png`,
    );
    const responses = new Map<
      string,
      {
        contentType: string;
        body: string;
      }
    >([
      [
        '/index.html',
        {
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html>
            ${imagePaths.map((path) => `<img src="${path}">`).join('')}
            <script type="module" src="/runtime/entry.js"></script>`,
        },
      ],
      [
        '/runtime/entry.js',
        {
          contentType: 'application/javascript; charset=utf-8',
          body: 'import "./level-1.js";',
        },
      ],
      [
        '/runtime/level-1.js',
        {
          contentType: 'application/javascript; charset=utf-8',
          body: 'import "./level-2.js";',
        },
      ],
      [
        '/runtime/level-2.js',
        {
          contentType: 'application/javascript; charset=utf-8',
          body: 'window.runtimeReady = true;',
        },
      ],
      ...imagePaths.map(
        (path, index) =>
          [
            path,
            {
              contentType: 'image/png',
              body: `observed-image-${index + 1}`,
            },
          ] as const,
      ),
    ]);
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);
      const fixture = responses.get(path);

      if (!fixture) {
        response.writeHead(404);
        response.end('not found');
        return;
      }

      response.writeHead(200, { 'content-type': fixture.contentType });
      response.end(fixture.body);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: `${origin}/index.html`,
        resources: [
          {
            sourceUrl: `${origin}/index.html`,
            contentType: 'text/html',
            resourceType: 'Document',
          },
          ...imagePaths.map((path) => ({
            sourceUrl: `${origin}${path}`,
            contentType: 'image/png',
            resourceType: 'Image',
          })),
        ],
      },
      {
        outputDirectory: directory,
        maxDiscoveryRounds: 4,
        maxResources: 5,
        maxRetries: 0,
      },
    );

    expect(requestedPaths).toEqual(
      expect.arrayContaining([
        '/index.html',
        '/runtime/entry.js',
        '/runtime/level-1.js',
        '/runtime/level-2.js',
        '/images/observed-01.png',
      ]),
    );
    expect(requestedPaths.filter((path) => path.startsWith('/images/'))).toEqual([
      '/images/observed-01.png',
    ]);
    expect(manifest.summary).toMatchObject({
      totalResources: 5,
      downloadedResources: 5,
      failedResources: 0,
    });
    expect(manifest.status).toBe('partial');
    expect(manifest.warnings.join(' ')).toContain('resource limit');
  });

  it('uses browser resource evidence for extensionless runtime and image URLs', async () => {
    const requestedPaths: string[] = [];
    const responses = new Map<
      string,
      {
        contentType: string;
        body: string;
      }
    >([
      [
        '/index',
        {
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><script type="module" src="/runtime-entry"></script>',
        },
      ],
      [
        '/runtime-entry',
        {
          contentType: 'application/javascript; charset=utf-8',
          body: 'import "/runtime-child";',
        },
      ],
      [
        '/runtime-child',
        {
          contentType: 'application/javascript; charset=utf-8',
          body: 'window.runtimeReady = true;',
        },
      ],
      [
        '/hero-image',
        {
          contentType: 'image/png',
          body: 'image',
        },
      ],
    ]);
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);
      const fixture = responses.get(path);

      if (!fixture) {
        response.writeHead(404);
        response.end('not found');
        return;
      }

      response.writeHead(200, { 'content-type': fixture.contentType });
      response.end(fixture.body);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: `${origin}/index`,
        resources: [
          {
            sourceUrl: `${origin}/index`,
            contentType: 'text/html',
            resourceType: 'Document',
          },
          {
            sourceUrl: `${origin}/runtime-entry`,
            contentType: 'application/javascript',
            resourceType: 'Script',
            initiatorType: 'parser',
          },
          {
            sourceUrl: `${origin}/hero-image`,
            contentType: 'image/png',
            resourceType: 'Image',
            initiatorType: 'parser',
          },
        ],
      },
      {
        outputDirectory: directory,
        maxDiscoveryRounds: 3,
        maxResources: 3,
        maxRetries: 0,
      },
    );

    expect(requestedPaths).toEqual(
      expect.arrayContaining(['/index', '/runtime-entry', '/runtime-child']),
    );
    expect(requestedPaths).not.toContain('/hero-image');
    expect(manifest.summary).toMatchObject({
      totalResources: 3,
      downloadedResources: 3,
      failedResources: 0,
    });
    expect(manifest.status).toBe('partial');
    expect(manifest.warnings.join(' ')).toContain('resource limit');
  });

  it('stops at the task byte budget and reports an explicit capability boundary', async () => {
    const requestedPaths: string[] = [];
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);
      response.writeHead(200, {
        'content-type': path === '/index.html' ? 'text/html' : 'image/png',
      });
      response.end(path === '/index.html' ? 'home' : '123456');
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: `${origin}/index.html`,
        resources: [
          {
            sourceUrl: `${origin}/index.html`,
            contentType: 'text/html',
            resourceType: 'Document',
          },
          {
            sourceUrl: `${origin}/images/a.png`,
            contentType: 'image/png',
            resourceType: 'Image',
          },
          {
            sourceUrl: `${origin}/images/b.png`,
            contentType: 'image/png',
            resourceType: 'Image',
          },
        ],
      },
      {
        outputDirectory: directory,
        concurrency: 1,
        maxDiscoveryRounds: 0,
        maxResourceBytes: 10,
        maxTotalBytes: 10,
        maxRetries: 0,
      },
    );

    expect(requestedPaths).toEqual(['/index.html', '/images/a.png']);
    expect(manifest.summary).toMatchObject({
      totalResources: 3,
      downloadedResources: 2,
      skippedResources: 1,
    });
    expect(manifest.status).toBe('partial');
    expect(manifest.warnings.join(' ')).toContain('total download limit of 10 bytes');
  });

  it('waits for in-flight reservations before declaring the byte budget exhausted', async () => {
    const requestedPaths: string[] = [];
    server = createServer((request, response) => {
      requestedPaths.push(request.url ?? '/');
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('x');
      }, 40);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const resources = ['a', 'b', 'c', 'd'].map((name) => ({
      sourceUrl: `${origin}/${name}.txt`,
      contentType: 'text/plain',
    }));
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: resources[0]?.sourceUrl ?? `${origin}/a.txt`,
        resources,
      },
      {
        outputDirectory: directory,
        concurrency: 3,
        maxDiscoveryRounds: 0,
        maxResourceBytes: 5,
        maxTotalBytes: 10,
        maxRetries: 0,
      },
    );

    expect(requestedPaths).toHaveLength(4);
    expect(requestedPaths).toEqual(
      expect.arrayContaining(['/a.txt', '/b.txt', '/c.txt', '/d.txt']),
    );
    expect(manifest.summary).toMatchObject({
      totalResources: 4,
      downloadedResources: 4,
      failedResources: 0,
      skippedResources: 0,
      totalBytes: 4,
    });
    expect(manifest.status).toBe('complete');
    expect(manifest.warnings.join(' ')).not.toContain('total download limit');
  });

  it('waits for a full resource reservation while other downloads are in flight', async () => {
    const requestedPaths: string[] = [];
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(path === '/c.txt' ? 'xyz' : 'x');
      }, 40);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const resources = ['a', 'b', 'c'].map((name) => ({
      sourceUrl: `${origin}/${name}.txt`,
      contentType: 'text/plain',
    }));
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: resources[0]?.sourceUrl ?? `${origin}/a.txt`,
        resources,
      },
      {
        outputDirectory: directory,
        concurrency: 3,
        maxDiscoveryRounds: 0,
        maxResourceBytes: 5,
        maxTotalBytes: 12,
        maxRetries: 0,
      },
    );

    expect(requestedPaths).toHaveLength(3);
    expect(manifest.summary).toMatchObject({
      totalResources: 3,
      downloadedResources: 3,
      failedResources: 0,
      skippedResources: 0,
      totalBytes: 5,
    });
    expect(manifest.status).toBe('complete');
    expect(manifest.warnings.join(' ')).not.toContain('total download limit');
  });

  it('bounds statically discovered deferred media without consuming the runtime asset budget', async () => {
    const requestedPaths: string[] = [];
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);

      if (path === '/index.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          `<!doctype html>
            <video src="/media/a.mp4"></video>
            <video src="/media/b.mp4"></video>
            <script>new TextureLoader().load("/runtime/scene.ktx2");</script>`,
        );
        return;
      }

      if (path === '/runtime/scene.ktx2') {
        response.writeHead(200, { 'content-type': 'image/ktx2', 'content-length': '4' });
        response.end('ktx2');
        return;
      }

      if (path === '/media/a.mp4' || path === '/media/b.mp4') {
        response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '8' });
        response.end('12345678');
        return;
      }

      response.writeHead(404);
      response.end('not found');
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: `${origin}/index.html`,
        resources: [{ sourceUrl: `${origin}/index.html`, contentType: 'text/html' }],
      },
      {
        outputDirectory: directory,
        concurrency: 1,
        maxDiscoveryRounds: 2,
        maxResourceBytes: 1024,
        maxTotalBytes: 1024,
        maxDeferredMediaBytes: 8,
        maxRetries: 0,
      },
    );

    expect(requestedPaths).toEqual(
      expect.arrayContaining(['/index.html', '/runtime/scene.ktx2', '/media/a.mp4']),
    );
    expect(requestedPaths).not.toContain('/media/b.mp4');
    expect(
      manifest.resources.find((resource) => resource.sourceUrl === `${origin}/media/b.mp4`),
    ).toMatchObject({
      status: 'skipped',
      error: 'Deferred media download limit of 8 bytes was reached',
    });
    expect(
      manifest.resources.find((resource) => resource.sourceUrl === `${origin}/runtime/scene.ktx2`),
    ).toMatchObject({ status: 'downloaded' });
  });

  it('spends the deferred media budget on audio before lexically earlier large videos', async () => {
    const requestedPaths: string[] = [];
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);

      if (path === '/index.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>Media priority</title>');
        return;
      }

      if (path === '/media/z-theme.mp3') {
        response.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': '4' });
        response.end('mp3!');
        return;
      }

      if (path === '/media/a-intro.mp4' || path === '/media/b-loop.mp4') {
        response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '10' });
        response.end('0123456789');
        return;
      }

      response.writeHead(404);
      response.end('not found');
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: `${origin}/index.html`,
        resources: [
          { sourceUrl: `${origin}/index.html`, contentType: 'text/html' },
          {
            sourceUrl: `${origin}/media/a-intro.mp4`,
            contentType: 'video/mp4',
            expectedSize: 10,
          },
          {
            sourceUrl: `${origin}/media/b-loop.mp4`,
            contentType: 'video/mp4',
            expectedSize: 10,
          },
          {
            sourceUrl: `${origin}/media/z-theme.mp3`,
            contentType: 'audio/mpeg',
            expectedSize: 4,
          },
        ],
      },
      {
        outputDirectory: directory,
        concurrency: 1,
        maxDiscoveryRounds: 0,
        maxResourceBytes: 64,
        maxTotalBytes: 1024,
        maxDeferredMediaBytes: 10,
        maxRetries: 0,
      },
    );

    expect(requestedPaths).toContain('/media/z-theme.mp3');
    expect(requestedPaths).not.toContain('/media/a-intro.mp4');
    expect(requestedPaths).not.toContain('/media/b-loop.mp4');
    expect(
      manifest.resources.find((resource) => resource.sourceUrl === `${origin}/media/z-theme.mp3`),
    ).toMatchObject({ status: 'downloaded' });
    expect(manifest.resources.filter((resource) => resource.contentType === 'video/mp4')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'skipped' }),
        expect.objectContaining({ status: 'skipped' }),
      ]),
    );
  });

  it('reserves media capacity for audio discovered after an earlier navigation closure', async () => {
    const requestedPaths: string[] = [];
    const kibibyte = 1024;
    const earlyVideoBytes = 900 * kibibyte;
    const lateAudioBytes = 300 * kibibyte;
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);

      if (path === '/index.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><a href="/details.html">Details</a>');
        return;
      }

      if (path === '/details.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><audio src="/media/late.mp3"></audio>');
        return;
      }

      if (path === '/media/early.mp4') {
        response.writeHead(200, {
          'content-type': 'video/mp4',
          'content-length': String(earlyVideoBytes),
        });
        response.end(Buffer.alloc(earlyVideoBytes, 0x76));
        return;
      }

      if (path === '/media/late.mp3') {
        response.writeHead(200, {
          'content-type': 'audio/mpeg',
          'content-length': String(lateAudioBytes),
        });
        response.end(Buffer.alloc(lateAudioBytes, 0x61));
        return;
      }

      response.writeHead(404);
      response.end('not found');
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: `${origin}/index.html`,
        resources: [
          { sourceUrl: `${origin}/index.html`, contentType: 'text/html' },
          {
            sourceUrl: `${origin}/media/early.mp4`,
            contentType: 'video/mp4',
            expectedSize: earlyVideoBytes,
          },
        ],
      },
      {
        outputDirectory: directory,
        concurrency: 1,
        maxDiscoveryRounds: 2,
        maxNavigationPages: 1,
        maxResourceBytes: 2 * 1024 * 1024,
        maxTotalBytes: 4 * 1024 * 1024,
        maxDeferredMediaBytes: 1024 * 1024,
        maxRetries: 0,
      },
    );

    expect(requestedPaths).not.toContain('/media/early.mp4');
    expect(requestedPaths).toContain('/details.html');
    expect(requestedPaths).toContain('/media/late.mp3');
    expect(
      manifest.resources.find((resource) => resource.sourceUrl === `${origin}/media/early.mp4`),
    ).toMatchObject({
      status: 'skipped',
      error: expect.stringContaining('reserving capacity for later audio resources'),
    });
    expect(
      manifest.resources.find((resource) => resource.sourceUrl === `${origin}/media/late.mp3`),
    ).toMatchObject({ status: 'downloaded', size: lateAudioBytes });
  });

  it('keeps compressed runtime textures ahead of ordinary images despite image MIME evidence', async () => {
    const requestedPaths: string[] = [];
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);
      response.writeHead(200, {
        'content-type': path.endsWith('.ktx2') ? 'image/ktx2' : 'image/png',
      });
      response.end(path.endsWith('.ktx2') ? 'texture' : 'image');
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    await createMirrorForTesting(
      {
        sourceUrl: `${origin}/runtime/scene.ktx2`,
        resources: [
          {
            sourceUrl: `${origin}/images/hero.png`,
            contentType: 'image/png',
            resourceType: 'Image',
          },
          {
            sourceUrl: `${origin}/runtime/scene.ktx2`,
            contentType: 'image/ktx2',
            resourceType: 'Fetch',
          },
        ],
      },
      {
        outputDirectory: directory,
        concurrency: 1,
        maxDiscoveryRounds: 0,
        maxResources: 1,
        maxRetries: 0,
      },
    );

    expect(requestedPaths).toEqual(['/runtime/scene.ktx2']);
  });

  it('uses adaptive reservations instead of serializing every unknown resource at the maximum size', async () => {
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    server = createServer((_request, response) => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      setTimeout(() => {
        activeRequests -= 1;
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end('x');
      }, 40);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const resources = Array.from({ length: 8 }, (_, index) => ({
      sourceUrl: `${origin}/asset-${index}.bin`,
      contentType: 'application/octet-stream',
    }));
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: resources[0]?.sourceUrl ?? `${origin}/asset-0.bin`,
        resources,
      },
      {
        outputDirectory: directory,
        concurrency: 8,
        maxDiscoveryRounds: 0,
        maxResourceBytes: 256 * 1024 * 1024,
        maxTotalBytes: 512 * 1024 * 1024,
        maxRetries: 0,
      },
    );

    expect(maximumActiveRequests).toBe(8);
    expect(manifest.summary).toMatchObject({
      totalResources: 8,
      downloadedResources: 8,
      failedResources: 0,
      skippedResources: 0,
    });
  });

  it('retries an unknown resource with its declared size after an adaptive reservation is too small', async () => {
    const body = Buffer.alloc(300 * 1024, 0x5a);
    let requests = 0;
    server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(body.byteLength),
      });
      response.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const sourceUrl = `http://127.0.0.1:${address.port}/large.bin`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl,
        resources: [{ sourceUrl, contentType: 'application/octet-stream' }],
      },
      {
        outputDirectory: directory,
        maxDiscoveryRounds: 0,
        maxResourceBytes: 1024 * 1024,
        maxTotalBytes: 1024 * 1024,
        maxRetries: 0,
      },
    );

    expect(requests).toBe(2);
    expect(manifest.summary).toMatchObject({
      downloadedResources: 1,
      failedResources: 0,
      skippedResources: 0,
      totalBytes: body.byteLength,
    });
  });

  it('closes an unusably small unknown-resource tail without probing every remaining URL', async () => {
    const entryBody = Buffer.alloc(1024 * 1024 - 1024, 0x31);
    const requestedPaths: string[] = [];
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);

      if (path === '/entry.bin') {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(entryBody.byteLength),
        });
        response.end(entryBody);
        return;
      }

      response.writeHead(200, {
        'content-type': 'image/jpeg',
        'content-length': String(128 * 1024),
      });
      response.end(Buffer.alloc(128 * 1024, 0x32));
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const resources = [
      {
        sourceUrl: `${origin}/entry.bin`,
        contentType: 'application/octet-stream',
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        sourceUrl: `${origin}/tail-${index}.jpg`,
        contentType: 'image/jpeg',
      })),
    ];
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: resources[0]?.sourceUrl ?? `${origin}/entry.bin`,
        resources,
      },
      {
        outputDirectory: directory,
        concurrency: 1,
        maxDiscoveryRounds: 0,
        maxResourceBytes: 1024 * 1024,
        maxTotalBytes: 1024 * 1024,
        maxRetries: 0,
      },
    );

    expect(requestedPaths).toEqual(['/entry.bin', '/entry.bin']);
    expect(manifest.summary).toMatchObject({
      totalResources: 41,
      downloadedResources: 1,
      failedResources: 0,
      skippedResources: 40,
      totalBytes: entryBody.byteLength,
    });
    expect(manifest.warnings.join(' ')).toContain('total download limit');
  });

  it('bounds unknown resource probes when a nontrivial tail budget cannot fit them', async () => {
    const totalBytes = 1024 * 1024;
    const tailBytes = 64 * 1024;
    const entryBody = Buffer.alloc(totalBytes - tailBytes, 0x41);
    const tailBody = Buffer.alloc(128 * 1024, 0x42);
    const requestedPaths: string[] = [];
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);
      const body = path === '/entry.bin' ? entryBody : tailBody;
      response.writeHead(200, {
        'content-type': path === '/entry.bin' ? 'application/octet-stream' : 'image/jpeg',
        'content-length': String(body.byteLength),
      });
      response.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const resources = [
      {
        sourceUrl: `${origin}/entry.bin`,
        contentType: 'application/octet-stream',
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        sourceUrl: `${origin}/tail-${index}.jpg`,
        contentType: 'image/jpeg',
      })),
    ];
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: resources[0]?.sourceUrl ?? `${origin}/entry.bin`,
        resources,
      },
      {
        outputDirectory: directory,
        concurrency: 1,
        maxDiscoveryRounds: 0,
        maxResourceBytes: totalBytes,
        maxTotalBytes: totalBytes,
        maxRetries: 0,
      },
    );

    expect(requestedPaths.filter((path) => path.startsWith('/tail-'))).toHaveLength(4);
    expect(manifest.summary).toMatchObject({
      totalResources: 21,
      downloadedResources: 1,
      failedResources: 0,
      skippedResources: 20,
      totalBytes: entryBody.byteLength,
    });
    expect(manifest.warnings.join(' ')).toContain('total download limit');
  });

  it('downloads one viewport-sized rendition for redundant discovered image variants', async () => {
    const requestedPaths: string[] = [];
    let origin = '';
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);

      if (path === '/index.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html>
          <img src="${origin}/images/hero.png?v=7">
          <img src="${origin}/images/hero.png?v=7&width=320&height=180&crop=center">
          <img src="${origin}/images/hero.png?v=7&width=1280&height=720&crop=center">
          <img src="${origin}/images/hero.png?v=7&width=2560&height=1440&crop=center">`);
        return;
      }

      if (path.startsWith('/images/hero.png')) {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(path);
        return;
      }

      response.writeHead(404);
      response.end('not found');
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    origin = `http://127.0.0.1:${address.port}`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: `${origin}/index.html`,
        viewport: {
          width: 1280,
          height: 720,
          deviceScaleFactor: 1,
        },
        resources: [
          {
            sourceUrl: `${origin}/index.html`,
            contentType: 'text/html',
          },
        ],
      },
      {
        outputDirectory: directory,
        maxDiscoveryRounds: 2,
        maxRetries: 0,
      },
    );

    expect(requestedPaths).toEqual([
      '/index.html',
      '/images/hero.png?v=7&width=1280&height=720&crop=center',
    ]);
    expect(manifest.summary).toMatchObject({
      totalResources: 2,
      downloadedResources: 2,
      failedResources: 0,
    });
    expect(manifest.status).toBe('complete');
    expect(manifest.onlineDependencies).toEqual([]);
    expect(
      manifest.resources.filter((resource) => resource.contentType === 'image/png'),
    ).toHaveLength(1);
    const localizedHtml = await readFile(`${directory}/site/index.html`, 'utf8');
    const localizedBody = localizedHtml.slice(localizedHtml.lastIndexOf('</script>'));

    expect(localizedHtml.match(/src="images\/hero[^"]+"/gu)).toHaveLength(4);
    expect(localizedBody).not.toContain('crop=center');
  });

  it('follows finite JavaScript fetches and ordinary JSON static URLs through the closure', async () => {
    const requestedPaths: string[] = [];
    const responses = new Map<
      string,
      {
        contentType: string;
        body: string;
      }
    >([
      [
        '/index.html',
        {
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><script src="/assets/app.js"></script>',
        },
      ],
      [
        '/assets/app.js',
        {
          contentType: 'application/javascript; charset=utf-8',
          body: `
            const origin = "__ORIGIN__";
            const assetBase = origin + "/files";
            fetch(\`\${assetBase}/rest.json\`);
            runtime.wasmURL = origin
              .concat("/runtime/", packageMetadata.name, "-")
              .concat(packageMetadata.version, ".wasm");
            module.exports = JSON.parse(
              \`{"name":"rive","version":"2.37.2"}\`
            );
          `,
        },
      ],
      [
        '/files/rest.json',
        {
          contentType: 'application/json; charset=utf-8',
          body: '',
        },
      ],
      [
        '/runtime/rive-2.37.2.wasm',
        {
          contentType: 'application/wasm',
          body: 'wasm',
        },
      ],
      [
        '/videos/scene.webm',
        {
          contentType: 'video/webm',
          body: 'video',
        },
      ],
    ]);
    let origin = '';
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);

      if (path === '/assets/app.js') {
        const fixture = responses.get(path)!;
        response.writeHead(200, { 'content-type': fixture.contentType });
        response.end(fixture.body.replace('__ORIGIN__', origin));
        return;
      }

      const fixture = responses.get(path);

      if (!fixture) {
        response.writeHead(404);
        response.end('not found');
        return;
      }

      response.writeHead(200, { 'content-type': fixture.contentType });
      response.end(fixture.body);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    origin = `http://127.0.0.1:${address.port}`;
    responses.get('/files/rest.json')!.body = JSON.stringify({
      url: `${origin}/videos/scene.webm`,
    });
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: `${origin}/index.html`,
        resources: [
          {
            sourceUrl: `${origin}/index.html`,
            contentType: 'text/html',
          },
        ],
      },
      {
        outputDirectory: directory,
        maxRetries: 0,
      },
    );

    expect(requestedPaths).toEqual(
      expect.arrayContaining([
        '/index.html',
        '/assets/app.js',
        '/files/rest.json',
        '/runtime/rive-2.37.2.wasm',
        '/videos/scene.webm',
      ]),
    );
    expect(manifest.status).toBe('complete');
    expect(manifest.onlineDependencies).toEqual([]);
  });

  it('follows a bounded multi-level module chain beyond three discovery rounds by default', async () => {
    const requestedPaths: string[] = [];
    const responses = new Map<
      string,
      {
        contentType: string;
        body: string;
      }
    >([
      [
        '/index.html',
        {
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><script type="module" src="/chunks/entry.js"></script>',
        },
      ],
      ...Array.from({ length: 5 }, (_, index) => {
        const nextImport = index < 4 ? `import "./level-${index + 1}.js";` : '';
        return [
          index === 0 ? '/chunks/entry.js' : `/chunks/level-${index}.js`,
          {
            contentType: 'application/javascript; charset=utf-8',
            body: `${nextImport} window.level${index} = true;`,
          },
        ] as const;
      }),
    ]);
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);
      const fixture = responses.get(path);

      if (!fixture) {
        response.writeHead(404);
        response.end('not found');
        return;
      }

      response.writeHead(200, { 'content-type': fixture.contentType });
      response.end(fixture.body);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: `${origin}/index.html`,
        resources: [
          {
            sourceUrl: `${origin}/index.html`,
            contentType: 'text/html',
          },
        ],
      },
      {
        outputDirectory: directory,
        maxNavigationPages: 0,
        maxRetries: 0,
      },
    );

    expect(requestedPaths).toEqual(
      expect.arrayContaining([
        '/index.html',
        '/chunks/entry.js',
        '/chunks/level-1.js',
        '/chunks/level-2.js',
        '/chunks/level-3.js',
        '/chunks/level-4.js',
      ]),
    );
    expect(manifest.summary).toMatchObject({
      totalResources: 6,
      downloadedResources: 6,
      failedResources: 0,
    });
    expect(manifest.status).toBe('complete');
    expect(manifest.warnings).toEqual([]);
  });

  it('preloads finite JavaScript manifests and their nested JSON assets', async () => {
    const requestedPaths: string[] = [];
    const responses = new Map<
      string,
      {
        contentType: string;
        body: string | Buffer;
      }
    >([
      [
        '/index.html',
        {
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html>
            <img src="/images/intro/desktop/logo.png">
            <audio src="/sounds/common/loading.ogg"></audio>
            <video src="/videos/common/intro.mp4"></video>
            <link rel="preload" href="/data/en.json" as="fetch">
            <script src="/scripts/app.js"></script>`,
        },
      ],
      [
        '/scripts/app.js',
        {
          contentType: 'application/javascript; charset=utf-8',
          body: `
            settings.audioFormat = Modernizr.audio.ogg ? "ogg" : "mp3";
            settings.videoFormat = Modernizr.video.webm ? "webm" : "mp4";
            settings.lang = document.documentElement.lang === "fr" ? "fr" : "en";
            const assets = {
              logo: { src: "images/intro/{resolutions:all}/logo.png" },
              loading: { src: "sounds/common/loading.{audio}" },
              language: { src: "data/{lang}.json" },
              intro: { src: "videos/common/intro.{video}" },
              atlas: { src: "sprites/next/{resolutions:all}/atlas.json" },
              nextAudio: { src: "sounds/next/theme.{audio}" },
              nextVideo: { src: "videos/next/scene.{video}" },
              fixed: { src: "images/fixed.png" },
              mobileOnly: { src: "images/mobile-{resolutions:mobile}.png" },
            };
            settings.assetResolution = "desktop";
            if (tablet) settings.assetResolution = "tablet";
            if (mobile) settings.assetResolution = "mobile";
            const clips = ["dance", "stop"];
            soundManager.addSound("noise", {
              urls: ["sounds/content/noise.ogg", "sounds/content/noise.mp3"],
            });
            clips.forEach(function (clip) {
              PIXI.VideoBaseTexture.fromUrl([
                {
                  src:
                    "videos/justice/" +
                    clip +
                    "-" +
                    settings.assetResolution +
                    ".webm",
                },
                {
                  src:
                    "videos/justice/" +
                    clip +
                    "-" +
                    settings.assetResolution +
                    ".mp4",
                },
              ]);
            }.bind(this));
          `,
        },
      ],
      [
        '/data/en.json',
        {
          contentType: 'application/json; charset=utf-8',
          body: '{"language":"en"}',
        },
      ],
      [
        '/images/intro/desktop/logo.png',
        {
          contentType: 'image/png',
          body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        },
      ],
      [
        '/sounds/common/loading.ogg',
        {
          contentType: 'audio/ogg',
          body: Buffer.from('loading'),
        },
      ],
      [
        '/videos/common/intro.mp4',
        {
          contentType: 'video/mp4',
          body: Buffer.from('intro'),
        },
      ],
      [
        '/sprites/next/desktop/atlas.json',
        {
          contentType: 'application/json',
          body: '{"meta":{"image":"atlas.png"}}',
        },
      ],
      [
        '/sprites/next/desktop/atlas.png',
        {
          contentType: 'image/png',
          body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
        },
      ],
      [
        '/sounds/next/theme.ogg',
        {
          contentType: 'audio/ogg',
          body: Buffer.from('theme'),
        },
      ],
      [
        '/videos/next/scene.mp4',
        {
          contentType: 'video/mp4',
          body: Buffer.from('scene'),
        },
      ],
      [
        '/images/fixed.png',
        {
          contentType: 'image/png',
          body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]),
        },
      ],
      [
        '/sounds/content/noise.ogg',
        {
          contentType: 'audio/ogg',
          body: Buffer.from('noise-ogg'),
        },
      ],
      [
        '/sounds/content/noise.mp3',
        {
          contentType: 'audio/mpeg',
          body: Buffer.from('noise-mp3'),
        },
      ],
      [
        '/videos/justice/dance-desktop.webm',
        {
          contentType: 'video/webm',
          body: Buffer.from('dance-webm'),
        },
      ],
      [
        '/videos/justice/dance-desktop.mp4',
        {
          contentType: 'video/mp4',
          body: Buffer.from('dance-mp4'),
        },
      ],
      [
        '/videos/justice/stop-desktop.webm',
        {
          contentType: 'video/webm',
          body: Buffer.from('stop-webm'),
        },
      ],
      [
        '/videos/justice/stop-desktop.mp4',
        {
          contentType: 'video/mp4',
          body: Buffer.from('stop-mp4'),
        },
      ],
    ]);
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestedPaths.push(path);
      const fixture = responses.get(path);

      if (!fixture) {
        response.writeHead(404);
        response.end('not found');
        return;
      }

      response.writeHead(200, { 'content-type': fixture.contentType });
      response.end(fixture.body);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const manifest = await createMirrorForTesting(
      {
        sourceUrl: `${origin}/index.html`,
        resources: [{ sourceUrl: `${origin}/index.html`, contentType: 'text/html' }],
      },
      {
        outputDirectory: directory,
        maxDiscoveryRounds: 3,
        maxRetries: 0,
      },
    );

    expect(manifest.summary).toMatchObject({
      totalResources: 17,
      downloadedResources: 17,
      failedResources: 0,
    });
    expect(manifest.warnings).toEqual([]);
    expect(manifest.status).toBe('complete');
    expect(requestedPaths).toContain('/sprites/next/desktop/atlas.json');
    expect(requestedPaths).toContain('/sprites/next/desktop/atlas.png');
    expect(requestedPaths).toContain('/sounds/content/noise.ogg');
    expect(requestedPaths).toContain('/sounds/content/noise.mp3');
    expect(requestedPaths).toContain('/videos/justice/dance-desktop.webm');
    expect(requestedPaths).toContain('/videos/justice/dance-desktop.mp4');
    expect(requestedPaths).toContain('/videos/justice/stop-desktop.webm');
    expect(requestedPaths).toContain('/videos/justice/stop-desktop.mp4');
    expect(requestedPaths).not.toContain('/videos/justice/dance-tablet.mp4');
    expect(requestedPaths).not.toContain('/videos/justice/dance-mobile.mp4');
    expect(requestedPaths).not.toContain('/images/mobile-desktop.png');
    expect(manifest.onlineDependencies).toEqual([]);
  });

  it('reuses a fresh pre-localization cache object after the source server stops', async () => {
    const body = Buffer.from('fresh cache body', 'utf8');
    server = createServer((_request, response) => {
      response.writeHead(200, {
        'cache-control': 'max-age=3600',
        'content-length': body.byteLength,
        'content-type': 'text/plain; charset=utf-8',
        etag: '"fresh-v1"',
      });
      response.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Fixture server did not expose a TCP address');
    }

    const sourceUrl = `http://127.0.0.1:${address.port}/cached.txt`;
    const cacheDirectory = join(directory, 'cache');
    const firstOutput = join(directory, 'first');
    const secondOutput = join(directory, 'second');
    await mkdir(firstOutput);
    await mkdir(secondOutput);
    const first = await createMirrorForTesting(
      {
        sourceUrl,
        resources: [{ sourceUrl, contentType: 'text/plain' }],
      },
      {
        outputDirectory: firstOutput,
        cacheDirectory,
        maxRetries: 0,
      },
    );

    expect(first.resources[0]?.bodySource).toBe('network');
    await close(server);
    server = undefined;
    const second = await createMirrorForTesting(
      {
        sourceUrl,
        resources: [{ sourceUrl, contentType: 'text/plain' }],
      },
      {
        outputDirectory: secondOutput,
        cacheDirectory,
        maxRetries: 0,
      },
    );

    expect(second.status).toBe('complete');
    expect(second.resources[0]).toMatchObject({
      status: 'downloaded',
      bodySource: 'cache',
      attempts: 0,
    });
    expect(await readFile(join(secondOutput, 'site', 'cached.txt'))).toEqual(body);
  });
});
