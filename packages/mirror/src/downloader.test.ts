import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContentAddressedCache, cacheMetadataFromHeaders } from './cache.js';
import {
  downloadResource,
  downloadResourceForTesting,
  isRetryableDownloadError,
} from './downloader.js';
import {
  DownloadSizeLimitError,
  DownloadTimeoutError,
  HttpStatusError,
  MirrorSecurityError,
  ResponseContentMismatchError,
} from './errors.js';
import { createTestDirectory, removeTestDirectory } from './test-utils.js';

interface RunningServer {
  server: Server;
  origin: string;
}

function listen(listener: RequestListener): Promise<RunningServer> {
  const server = createServer(listener);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();

      if (!address || typeof address === 'string') {
        reject(new Error('Fixture server did not expose a TCP address'));
        return;
      }

      resolve({
        server,
        origin: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

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

describe('downloadResource', () => {
  let directory: string;
  const servers: Server[] = [];

  beforeEach(async () => {
    directory = await createTestDirectory('webmirror-download-');
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => close(server)));
    await removeTestDirectory(directory);
  });

  it('streams a fixture to disk while calculating SHA-256', async () => {
    const body = Buffer.alloc(256 * 1024, 0x5a);
    const fixture = await listen((_request, response) => {
      response.writeHead(200, {
        'content-length': body.byteLength,
        'content-type': 'application/octet-stream',
      });
      response.end(body);
    });
    servers.push(fixture.server);

    const result = await downloadResourceForTesting(`${fixture.origin}/asset.bin`, {
      rootDirectory: directory,
      localPath: 'site/assets/asset.bin',
      maxRetries: 0,
    });

    expect(await readFile(join(directory, 'site', 'assets', 'asset.bin'))).toEqual(body);
    expect(result).toMatchObject({
      finalUrl: `${fixture.origin}/asset.bin`,
      localPath: 'site/assets/asset.bin',
      httpStatus: 200,
      size: body.byteLength,
      attempts: 1,
    });
    expect(result.sha256).toBe(createHash('sha256').update(body).digest('hex'));
  }, 15_000);

  it('rejects an HTML application-shell fallback for a required script', async () => {
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><body>Application shell</body></html>');
    });
    servers.push(fixture.server);

    await expect(
      downloadResourceForTesting(`${fixture.origin}/missing.js`, {
        rootDirectory: directory,
        localPath: 'site/missing.js',
        expectedContentType: 'application/javascript',
        expectedResourceType: 'Script',
        maxRetries: 0,
      }),
    ).rejects.toBeInstanceOf(ResponseContentMismatchError);
    await expect(readFile(join(directory, 'site', 'missing.js'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('sniffs an undeclared HTML fallback before committing a binary asset', async () => {
    const fixture = await listen((_request, response) => {
      response.writeHead(200);
      response.end('  <!doctype html><html><body>Fallback</body></html>');
    });
    servers.push(fixture.server);

    await expect(
      downloadResourceForTesting(`${fixture.origin}/missing.glb`, {
        rootDirectory: directory,
        localPath: 'site/missing.glb',
        expectedContentType: 'model/gltf-binary',
        maxRetries: 0,
      }),
    ).rejects.toBeInstanceOf(ResponseContentMismatchError);
    await expect(readFile(join(directory, 'site', 'missing.glb'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects an HTML shell for a PDF path even when the fallback declares itself as HTML', async () => {
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><body>Application shell</body></html>');
    });
    servers.push(fixture.server);

    await expect(
      downloadResourceForTesting(`${fixture.origin}/brochure.pdf`, {
        rootDirectory: directory,
        localPath: 'site/brochure.pdf',
        expectedContentType: 'text/html; charset=utf-8',
        expectedResourceType: 'Document',
        maxRetries: 0,
      }),
    ).rejects.toBeInstanceOf(ResponseContentMismatchError);
    await expect(readFile(join(directory, 'site', 'brochure.pdf'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('uses a static script path as stronger evidence than an incompatible observed MIME', async () => {
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    });
    servers.push(fixture.server);

    await expect(
      downloadResourceForTesting(`${fixture.origin}/runtime.js`, {
        rootDirectory: directory,
        localPath: 'site/runtime.js',
        expectedContentType: 'image/png',
        maxRetries: 0,
      }),
    ).rejects.toBeInstanceOf(ResponseContentMismatchError);
  });

  it('rejects a declared MIME category that cannot satisfy a required script', async () => {
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    });
    servers.push(fixture.server);

    await expect(
      downloadResourceForTesting(`${fixture.origin}/app.js`, {
        rootDirectory: directory,
        localPath: 'site/app.js',
        expectedContentType: 'application/javascript',
        expectedResourceType: 'Script',
        maxRetries: 0,
      }),
    ).rejects.toBeInstanceOf(ResponseContentMismatchError);
    await expect(readFile(join(directory, 'site', 'app.js'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('normalizes a generic response MIME to the proven script type', async () => {
    const body = Buffer.from('window.genericMimeScriptLoaded = true;\n', 'utf8');
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(body);
    });
    servers.push(fixture.server);

    const result = await downloadResourceForTesting(`${fixture.origin}/app.js`, {
      rootDirectory: directory,
      localPath: 'site/app.js',
      expectedContentType: 'application/javascript',
      expectedResourceType: 'Script',
      maxRetries: 0,
    });

    expect(result.contentType).toBe('application/javascript');
    expect(await readFile(join(directory, 'site', 'app.js'))).toEqual(body);
  });

  it('accepts SubRip text loaded through XHR with its common application MIME', async () => {
    const body = Buffer.from(
      '1\n00:00:00,000 --> 00:00:01,000\nOffline subtitles loaded.\n',
      'utf8',
    );
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-subrip' });
      response.end(body);
    });
    servers.push(fixture.server);

    const result = await downloadResourceForTesting(`${fixture.origin}/captions.srt`, {
      rootDirectory: directory,
      localPath: 'site/captions.srt',
      expectedContentType: 'application/x-subrip',
      expectedResourceType: 'XHR',
      maxRetries: 0,
    });

    expect(result.contentType).toBe('application/x-subrip');
    expect(await readFile(join(directory, 'site', 'captions.srt'))).toEqual(body);
  });

  it('treats browser TextTrack resources as text instead of audiovisual media', async () => {
    const body = Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nOffline captions\n', 'utf8');
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8' });
      response.end(body);
    });
    servers.push(fixture.server);

    const result = await downloadResourceForTesting(`${fixture.origin}/captions.vtt`, {
      rootDirectory: directory,
      localPath: 'site/captions.vtt',
      expectedContentType: 'text/vtt; charset=utf-8',
      expectedResourceType: 'TextTrack',
      maxRetries: 0,
    });

    expect(result.contentType).toBe('text/vtt; charset=utf-8');
    expect(await readFile(join(directory, 'site', 'captions.vtt'))).toEqual(body);
  });

  it('discards an incompatible captured shell and keeps a valid network alternative', async () => {
    const captured = Buffer.from('<!doctype html><html><body>Fallback shell</body></html>', 'utf8');
    const network = Buffer.from('window.recoveredFromFallback = true;\n', 'utf8');
    const capturedPath = join(directory, 'captured-fallback.body');
    await writeFile(capturedPath, captured);
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      response.end(network);
    });
    servers.push(fixture.server);

    const result = await downloadResourceForTesting(`${fixture.origin}/runtime.js`, {
      rootDirectory: directory,
      localPath: 'site/runtime.js',
      expectedContentType: 'application/javascript',
      expectedResourceType: 'Script',
      maxRetries: 0,
      capturedBody: {
        filePath: capturedPath,
        byteLength: captured.byteLength,
        sha256: createHash('sha256').update(captured).digest('hex'),
        contentType: 'text/html; charset=utf-8',
        httpStatus: 200,
      },
    });

    expect(result.bodySource).toBe('network');
    expect(await readFile(join(directory, 'site', 'runtime.js'))).toEqual(network);
  });

  it('invalidates a cached HTML shell before downloading a valid runtime asset', async () => {
    const cachedShell = Buffer.from(
      '<!doctype html><html><body>Cached shell</body></html>',
      'utf8',
    );
    const network = Buffer.from('window.cacheFallbackRecovered = true;\n', 'utf8');
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      response.end(network);
    });
    servers.push(fixture.server);
    const resourceUrl = `${fixture.origin}/cached-runtime.js`;
    const cacheDirectory = join(directory, 'fallback-cache');
    const cacheSource = join(directory, 'cached-shell.body');
    await writeFile(cacheSource, cachedShell);
    const cache = new ContentAddressedCache(cacheDirectory);
    await cache.put(
      resourceUrl,
      cacheSource,
      cacheMetadataFromHeaders(
        resourceUrl,
        'application/javascript; charset=utf-8',
        200,
        cachedShell.byteLength,
        createHash('sha256').update(cachedShell).digest('hex'),
        { 'cache-control': 'max-age=3600' },
      ),
    );

    const result = await downloadResourceForTesting(resourceUrl, {
      rootDirectory: directory,
      localPath: 'site/cached-runtime.js',
      expectedContentType: 'application/javascript',
      expectedResourceType: 'Script',
      cacheDirectory,
      maxRetries: 0,
    });

    expect(result.bodySource).toBe('network');
    expect(await readFile(join(directory, 'site', 'cached-runtime.js'))).toEqual(network);
    await expect(cache.lookup(resourceUrl)).resolves.toBeUndefined();
  });

  it('uses finite retries for transient HTTP failures', async () => {
    let requests = 0;
    const fixture = await listen((_request, response) => {
      requests += 1;

      if (requests === 1) {
        response.writeHead(503, { 'retry-after': '0' });
        response.end();
        return;
      }

      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ready');
    });
    servers.push(fixture.server);

    const result = await downloadResourceForTesting(`${fixture.origin}/retry.txt`, {
      rootDirectory: directory,
      localPath: 'site/retry.txt',
      maxRetries: 1,
      retryDelayMs: 1,
    });

    expect(result.attempts).toBe(2);
    expect(requests).toBe(2);
    expect(await readFile(join(directory, 'site', 'retry.txt'), 'utf8')).toBe('ready');
  });

  it('classifies only bounded transient failures as retryable', () => {
    const reset = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
    const nestedReset = new Error('request failed', { cause: reset });

    expect(isRetryableDownloadError(reset)).toBe(true);
    expect(isRetryableDownloadError(nestedReset)).toBe(true);
    expect(isRetryableDownloadError(new DownloadTimeoutError(1_000))).toBe(true);
    expect(isRetryableDownloadError(new HttpStatusError(503))).toBe(true);
    expect(isRetryableDownloadError(new HttpStatusError(404))).toBe(false);
    expect(isRetryableDownloadError(new DownloadSizeLimitError(1_024))).toBe(false);
    expect(
      isRetryableDownloadError(
        new ResponseContentMismatchError('Script', 'text/html HTML body', true),
      ),
    ).toBe(true);
    expect(isRetryableDownloadError(new ResponseContentMismatchError('Script', 'image/png'))).toBe(
      false,
    );
    expect(
      isRetryableDownloadError(
        new MirrorSecurityError('PRIVATE_NETWORK', 'Private targets are not allowed'),
      ),
    ).toBe(false);
  });

  it('rejects a network fallback that differs from the captured browser body', async () => {
    const captured = Buffer.from('captured response', 'utf8');
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('different response');
    });
    servers.push(fixture.server);

    const capturedPath = join(directory, 'captured.body');
    await writeFile(capturedPath, Buffer.from('stale local staging', 'utf8'));
    const cacheDirectory = join(directory, 'captured-cache');
    const cacheSource = join(directory, 'captured-cache-source.body');
    await writeFile(cacheSource, captured);
    const cache = new ContentAddressedCache(cacheDirectory);
    await cache.put(
      `${fixture.origin}/private.txt`,
      cacheSource,
      cacheMetadataFromHeaders(
        `${fixture.origin}/private.txt`,
        'text/plain; charset=utf-8',
        200,
        captured.byteLength,
        createHash('sha256').update(captured).digest('hex'),
        { 'cache-control': 'max-age=3600' },
      ),
    );

    await expect(
      downloadResourceForTesting(`${fixture.origin}/private.txt`, {
        rootDirectory: directory,
        localPath: 'site/private.txt',
        cacheDirectory,
        maxRetries: 0,
        capturedBody: {
          filePath: capturedPath,
          byteLength: captured.byteLength,
          sha256: createHash('sha256').update(captured).digest('hex'),
          contentType: 'text/plain',
          httpStatus: 200,
        },
      }),
    ).rejects.toThrow('did not match the captured browser response body');

    await expect(readFile(join(directory, 'site', 'private.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('accepts a network fallback only when it matches the captured body hash', async () => {
    const body = Buffer.from('same response', 'utf8');
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(body);
    });
    servers.push(fixture.server);

    const capturedPath = join(directory, 'captured-match.body');
    await writeFile(capturedPath, Buffer.from('stale local staging data', 'utf8'));

    const result = await downloadResourceForTesting(`${fixture.origin}/private.txt`, {
      rootDirectory: directory,
      localPath: 'site/private.txt',
      maxRetries: 0,
      capturedBody: {
        filePath: capturedPath,
        byteLength: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
        contentType: 'text/plain',
        httpStatus: 200,
      },
    });

    expect(result.bodySource).toBe('network_verified');
    expect(await readFile(join(directory, 'site', 'private.txt'))).toEqual(body);
  });

  it('revalidates a stale ETag entry and materializes the cached object on 304', async () => {
    const body = Buffer.from('cached response', 'utf8');
    let requests = 0;
    let observedValidator: string | undefined;
    let observedModifiedSince: string | undefined;
    const fixture = await listen((request, response) => {
      requests += 1;
      observedValidator = request.headers['if-none-match'];
      observedModifiedSince = request.headers['if-modified-since'];
      response.writeHead(304, {
        'cache-control': 'max-age=3600',
        etag: '"cache-v1"',
        'last-modified': 'Wed, 01 Jul 2026 00:00:00 GMT',
      });
      response.end();
    });
    servers.push(fixture.server);
    const sourceUrl = `${fixture.origin}/cached.txt`;
    const cacheDirectory = join(directory, 'cache');
    const cacheSource = join(directory, 'cache-source.txt');
    await writeFile(cacheSource, body);
    const cache = new ContentAddressedCache(cacheDirectory);
    await cache.put(
      sourceUrl,
      cacheSource,
      cacheMetadataFromHeaders(
        sourceUrl,
        'text/plain; charset=utf-8',
        200,
        body.byteLength,
        createHash('sha256').update(body).digest('hex'),
        {
          'cache-control': 'max-age=0',
          etag: '"cache-v1"',
          'last-modified': 'Wed, 01 Jul 2026 00:00:00 GMT',
        },
      ),
    );

    const result = await downloadResourceForTesting(sourceUrl, {
      rootDirectory: directory,
      localPath: 'site/cached.txt',
      cacheDirectory,
      maxRetries: 0,
    });

    expect(requests).toBe(1);
    expect(observedValidator).toBe('"cache-v1"');
    expect(observedModifiedSince).toBe('Wed, 01 Jul 2026 00:00:00 GMT');
    expect(result.bodySource).toBe('cache_revalidated');
    expect(await readFile(join(directory, 'site', 'cached.txt'))).toEqual(body);
    expect(cache.isFresh((await cache.lookup(sourceUrl))!.entry)).toBe(true);
  });

  it('does not forward cache validators across an origin-changing redirect', async () => {
    const cachedBody = Buffer.from('cached response', 'utf8');
    let redirectValidator: string | undefined;
    let targetValidator: string | undefined;
    const target = await listen((request, response) => {
      targetValidator = request.headers['if-none-match'];
      response.writeHead(200, {
        'cache-control': 'max-age=3600',
        'content-type': 'text/plain; charset=utf-8',
      });
      response.end('fresh response');
    });
    servers.push(target.server);
    const redirect = await listen((request, response) => {
      redirectValidator = request.headers['if-none-match'];
      response.writeHead(302, { location: `${target.origin}/asset.txt` });
      response.end();
    });
    servers.push(redirect.server);
    const sourceUrl = `${redirect.origin}/asset.txt`;
    const cacheDirectory = join(directory, 'redirect-cache');
    const cacheSource = join(directory, 'redirect-cache-source.txt');
    await writeFile(cacheSource, cachedBody);
    const cache = new ContentAddressedCache(cacheDirectory);
    await cache.put(
      sourceUrl,
      cacheSource,
      cacheMetadataFromHeaders(
        sourceUrl,
        'text/plain; charset=utf-8',
        200,
        cachedBody.byteLength,
        createHash('sha256').update(cachedBody).digest('hex'),
        {
          'cache-control': 'max-age=0',
          etag: '"origin-bound-validator"',
        },
      ),
    );

    const result = await downloadResourceForTesting(sourceUrl, {
      rootDirectory: directory,
      localPath: 'site/redirected.txt',
      cacheDirectory,
      maxRetries: 0,
    });

    expect(redirectValidator).toBe('"origin-bound-validator"');
    expect(targetValidator).toBeUndefined();
    expect(result.bodySource).toBe('network');
    expect(await readFile(join(directory, 'site', 'redirected.txt'), 'utf8')).toBe(
      'fresh response',
    );
  });

  it('decodes HTTP content encodings before hashing and writing files', async () => {
    const body = Buffer.from('<!doctype html><title>Compressed fixture</title>', 'utf8');
    const compressed = gzipSync(body);
    const fixture = await listen((_request, response) => {
      response.writeHead(200, {
        'content-encoding': 'gzip',
        'content-length': compressed.byteLength,
        'content-type': 'text/html; charset=utf-8',
      });
      response.end(compressed);
    });
    servers.push(fixture.server);

    const result = await downloadResourceForTesting(`${fixture.origin}/compressed.html`, {
      rootDirectory: directory,
      localPath: 'site/compressed.html',
      maxRetries: 0,
    });

    expect(await readFile(join(directory, 'site', 'compressed.html'))).toEqual(body);
    expect(result.size).toBe(body.byteLength);
    expect(result.sha256).toBe(createHash('sha256').update(body).digest('hex'));
  });

  it('rejects expected or declared resources above the configured safety limit', async () => {
    let requests = 0;
    const fixture = await listen((_request, response) => {
      requests += 1;
      response.writeHead(200, {
        'content-length': 2_048,
        'content-type': 'application/octet-stream',
      });
      response.end(Buffer.alloc(2_048, 1));
    });
    servers.push(fixture.server);

    await expect(
      downloadResourceForTesting(`${fixture.origin}/expected.bin`, {
        rootDirectory: directory,
        localPath: 'site/expected.bin',
        expectedSize: 2_048,
        maxBytes: 1_024,
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({ name: 'DownloadSizeLimitError' });
    expect(requests).toBe(0);

    await expect(
      downloadResourceForTesting(`${fixture.origin}/declared.bin`, {
        rootDirectory: directory,
        localPath: 'site/declared.bin',
        maxBytes: 1_024,
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({ name: 'DownloadSizeLimitError' });
    expect(requests).toBe(1);
  });

  it('enforces the safety limit after HTTP decompression', async () => {
    const body = Buffer.alloc(4 * 1_024, 0x41);
    const compressed = gzipSync(body);
    const fixture = await listen((_request, response) => {
      response.writeHead(200, {
        'content-encoding': 'gzip',
        'content-length': compressed.byteLength,
        'content-type': 'application/octet-stream',
      });
      response.end(compressed);
    });
    servers.push(fixture.server);

    await expect(
      downloadResourceForTesting(`${fixture.origin}/expanded.bin`, {
        rootDirectory: directory,
        localPath: 'site/expanded.bin',
        maxBytes: 1_024,
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({ name: 'DownloadSizeLimitError' });
    const files = await readdir(join(directory, 'site'));
    expect(files).not.toContain('expanded.bin');
    expect(files.some((file) => file.includes('.part-'))).toBe(false);
  });

  it('rejects loopback targets unless the fixture-only override is explicit', async () => {
    const fixture = await listen((_request, response) => {
      response.end('private');
    });
    servers.push(fixture.server);

    await expect(
      downloadResource(`${fixture.origin}/private`, {
        rootDirectory: directory,
        localPath: 'site/private',
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({
      name: 'MirrorSecurityError',
      code: 'PRIVATE_NETWORK',
    });
  });

  it('refuses to write through a symbolic link or junction', async () => {
    const outside = join(directory, 'outside');
    await mkdir(outside);
    await symlink(
      outside,
      join(directory, 'site'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const fixture = await listen((_request, response) => {
      response.end('unsafe');
    });
    servers.push(fixture.server);

    await expect(
      downloadResourceForTesting(`${fixture.origin}/asset.txt`, {
        rootDirectory: directory,
        localPath: 'site/asset.txt',
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({
      name: 'MirrorSecurityError',
      code: 'SYMLINK_PATH',
    });
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it('cancels an active stream and removes partial files', async () => {
    let notifyFirstChunk: (() => void) | undefined;
    const firstChunk = new Promise<void>((resolve) => {
      notifyFirstChunk = resolve;
    });
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.write(Buffer.alloc(16 * 1024, 1), () => notifyFirstChunk?.());
      const interval = setInterval(() => {
        response.write(Buffer.alloc(16 * 1024, 2));
      }, 10);
      response.once('close', () => clearInterval(interval));
    });
    servers.push(fixture.server);
    const controller = new AbortController();
    const download = downloadResourceForTesting(`${fixture.origin}/slow.bin`, {
      rootDirectory: directory,
      localPath: 'site/slow.bin',
      maxRetries: 2,
      signal: controller.signal,
    });

    await firstChunk;
    controller.abort();

    await expect(download).rejects.toMatchObject({ name: 'AbortError' });
    const files = await readdir(join(directory, 'site'));
    expect(files).not.toContain('slow.bin');
    expect(files.some((file) => file.includes('.part-'))).toBe(false);
  });

  it('times out a stalled stream and removes partial files', async () => {
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.write(Buffer.alloc(1024, 1));
      const interval = setInterval(() => {
        response.write(Buffer.alloc(1024, 2));
      }, 100);
      response.once('close', () => clearInterval(interval));
    });
    servers.push(fixture.server);

    await expect(
      downloadResourceForTesting(`${fixture.origin}/timeout.bin`, {
        rootDirectory: directory,
        localPath: 'site/timeout.bin',
        maxRetries: 0,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ name: 'DownloadTimeoutError' });

    const files = await readdir(join(directory, 'site'));
    expect(files).not.toContain('timeout.bin');
    expect(files.some((file) => file.includes('.part-'))).toBe(false);
  });
});
