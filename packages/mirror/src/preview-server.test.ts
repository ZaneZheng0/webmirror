import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createPreviewRouteAliases,
  createPreviewUnavailableRoutes,
  previewRouteForSourceUrl,
  startPreviewServer,
} from './preview-server.js';
import { createTestDirectory, removeTestDirectory } from './test-utils.js';
import type { MirrorManifest, PreviewServer } from './types.js';

interface RawResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.once('error', reject);
    request.end();
  });
}

describe('startPreviewServer', () => {
  let directory: string;
  let preview: PreviewServer | undefined;

  beforeEach(async () => {
    directory = await createTestDirectory('webmirror-preview-');
    await mkdir(join(directory, 'site'), { recursive: true });
    await writeFile(join(directory, 'site', 'index.html'), '<h1>Mirror</h1>');
    await writeFile(join(directory, 'site', 'empty.bin'), '');
    await writeFile(join(directory, 'site', 'media.bin'), '0123456789');
    await writeFile(join(directory, 'site', 'module'), Buffer.from([0, 97, 115, 109]));
    await mkdir(join(directory, 'site', 'editions'), { recursive: true });
    await writeFile(join(directory, 'site', 'editions', 'winter2026.html'), '<h1>Winter 2026</h1>');
    await writeFile(
      join(directory, 'site', 'editions', 'winter2026-query.html'),
      '<h1>Winter 2026 Query</h1>',
    );
    await writeFile(join(directory, 'secret.txt'), 'outside-root');
  });

  afterEach(async () => {
    await preview?.close();
    preview = undefined;
    await removeTestDirectory(directory);
  });

  it('binds to loopback and serves manifest MIME types', async () => {
    preview = await startPreviewServer({
      rootDirectory: join(directory, 'site'),
      manifest: {
        resources: [
          {
            sourceUrl: 'https://example.test/module',
            canonicalUrl: 'https://example.test/module',
            status: 'downloaded',
            localPath: 'site/module',
            contentType: 'application/wasm',
          },
        ],
      },
    });

    const address = await rawRequest(preview.port, '/module');

    expect(preview.host).toBe('127.0.0.1');
    expect(preview.url).toBe(`http://127.0.0.1:${preview.port}/`);
    expect(address.statusCode).toBe(200);
    expect(address.headers['content-type']).toBe('application/wasm');
    expect(address.headers['access-control-allow-origin']).toBe('*');
    expect(address.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(address.headers['content-security-policy']).toContain("connect-src 'self'");
    expect(address.headers['content-security-policy']).toContain(
      "img-src 'self' data: blob: about:",
    );
    expect(address.headers['content-security-policy']).toContain("form-action 'self'");
    expect(address.headers['permissions-policy']).toContain('accelerometer=(self)');
    expect(address.headers['permissions-policy']).toContain('camera=()');
    expect(address.headers['referrer-policy']).toBe('no-referrer');
    expect(address.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(address.headers['x-frame-options']).toBe('SAMEORIGIN');

    const document = await rawRequest(preview.port, '/index.html');
    expect(document.headers['access-control-allow-origin']).toBeUndefined();
    expect(document.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('rejects DNS-rebinding style Host headers', async () => {
    preview = await startPreviewServer({
      rootDirectory: join(directory, 'site'),
    });

    const response = await rawRequest(preview.port, '/index.html', {
      host: 'attacker.example',
    });

    expect(response.statusCode).toBe(421);
    expect(response.body).toBe('Misdirected request');
  });

  it('serves the reserved runtime no-op endpoint without using history fallback', async () => {
    preview = await startPreviewServer({
      rootDirectory: join(directory, 'site'),
      fallbackPath: 'index.html',
    });

    const response = await rawRequest(preview.port, '/.webmirror/noop?source=telemetry', {
      accept: 'text/html,*/*',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toContain('Unavailable offline frame');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");

    const programmaticResponse = await rawRequest(preview.port, '/.webmirror/noop', {
      accept: 'application/json,*/*',
    });
    expect(programmaticResponse).toMatchObject({
      statusCode: 200,
    });
    expect(programmaticResponse.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(programmaticResponse.headers['x-webmirror-unavailable']).toBe('1');
    expect(JSON.parse(programmaticResponse.body)).toMatchObject({
      success: false,
      items: [],
      list: [],
      data: {
        list: [],
        sessionTrackingConsent: { enabled: false },
        data: { enabled: false, url: '' },
      },
    });
  });

  it('keeps Worker no-op scripts separate from unavailable dynamic scripts', async () => {
    preview = await startPreviewServer({
      rootDirectory: join(directory, 'site'),
    });

    const script = await rawRequest(preview.port, '/.webmirror/noop.js');
    const unavailableScript = await rawRequest(preview.port, '/.webmirror/unavailable.js', {
      'sec-fetch-dest': 'script',
    });
    const stylesheet = await rawRequest(preview.port, '/.webmirror/noop.css');

    expect(script).toMatchObject({
      statusCode: 200,
      body: '',
    });
    expect(script.headers['content-type']).toBe('application/javascript; charset=utf-8');
    expect(unavailableScript).toMatchObject({ statusCode: 404, body: '' });
    expect(unavailableScript.headers['content-type']).toBe('application/javascript; charset=utf-8');
    expect(unavailableScript.headers['x-webmirror-unavailable']).toBe('1');
    expect(stylesheet).toMatchObject({
      statusCode: 200,
      body: '',
    });
    expect(stylesheet.headers['content-type']).toBe('text/css; charset=utf-8');
  });

  it('serves known unavailable resource routes as local no-content responses', async () => {
    preview = await startPreviewServer({
      rootDirectory: join(directory, 'site'),
      unavailableRoutes: ['/assets/missing.bin'],
    });

    const response = await rawRequest(preview.port, '/assets/missing.bin');

    expect(response).toMatchObject({
      statusCode: 204,
      body: '',
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('serves a safe empty API contract while making unavailable scripts fail to load', async () => {
    preview = await startPreviewServer({
      rootDirectory: join(directory, 'site'),
      unavailableRoutes: ['/missing.js', '/missing.css', '/missing.json'],
    });

    const script = await rawRequest(preview.port, '/missing.js', {
      origin: 'null',
      'sec-fetch-dest': 'script',
    });
    const scriptApi = await rawRequest(preview.port, '/missing.js', {
      origin: 'null',
      'sec-fetch-dest': 'empty',
    });
    const stylesheet = await rawRequest(preview.port, '/missing.css', { origin: 'null' });
    const json = await rawRequest(preview.port, '/missing.json', { origin: 'null' });

    expect(script).toMatchObject({ statusCode: 404, body: '' });
    expect(script.headers['content-type']).toBe('application/javascript; charset=utf-8');
    expect(script.headers['access-control-allow-origin']).toBe('*');
    expect(scriptApi.statusCode).toBe(200);
    expect(JSON.parse(scriptApi.body)).toMatchObject({
      item_count: 0,
      items: [],
      total_price: 0,
    });
    expect(stylesheet).toMatchObject({ statusCode: 200, body: '' });
    expect(stylesheet.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(json.statusCode).toBe(200);
    expect(JSON.parse(json.body)).toMatchObject({
      entries: [],
      results: [],
      data: { data: { url: '' } },
    });
    expect(json.headers['content-type']).toBe('application/json; charset=utf-8');
  });

  it('serves syntactically valid neutral subtitle tracks for unavailable captions', async () => {
    preview = await startPreviewServer({
      rootDirectory: join(directory, 'site'),
      unavailableRoutes: ['/captions/missing.srt', '/captions/missing.vtt'],
    });

    const subRip = await rawRequest(preview.port, '/captions/missing.srt', { origin: 'null' });
    const webVtt = await rawRequest(preview.port, '/captions/missing.vtt', { origin: 'null' });

    expect(subRip.statusCode).toBe(200);
    expect(subRip.headers['content-type']).toBe('application/x-subrip; charset=utf-8');
    expect(subRip.body).toContain('-->');
    expect(webVtt).toMatchObject({ statusCode: 200, body: 'WEBVTT\n\n' });
    expect(webVtt.headers['content-type']).toBe('text/vtt; charset=utf-8');
  });

  it('serves a valid image response for known unavailable image routes', async () => {
    preview = await startPreviewServer({
      rootDirectory: join(directory, 'site'),
      unavailableRoutes: ['/assets/missing.jpg'],
    });

    const image = await rawRequest(preview.port, '/assets/missing.jpg', { origin: 'null' });

    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(Number(image.headers['content-length'])).toBeGreaterThan(0);
    expect(image.headers['access-control-allow-origin']).toBe('*');
  });

  it('rejects a symlinked or junction preview root', async () => {
    const linkedRoot = join(directory, 'linked-site');
    await symlink(
      join(directory, 'site'),
      linkedRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(
      startPreviewServer({
        rootDirectory: linkedRoot,
      }),
    ).rejects.toThrow('must not be a symbolic link or junction');
  });

  it('serves a single byte range and rejects invalid ranges', async () => {
    preview = await startPreviewServer({
      rootDirectory: join(directory, 'site'),
    });

    const partial = await rawRequest(preview.port, '/media.bin', {
      range: 'bytes=2-5',
    });
    const invalid = await rawRequest(preview.port, '/media.bin', {
      range: 'bytes=99-100',
    });
    const empty = await rawRequest(preview.port, '/empty.bin', {
      range: 'bytes=0-0',
    });

    expect(partial).toMatchObject({
      statusCode: 206,
      body: '2345',
    });
    expect(partial.headers['content-range']).toBe('bytes 2-5/10');
    expect(partial.headers['content-length']).toBe('4');
    expect(invalid.statusCode).toBe(416);
    expect(invalid.headers['content-range']).toBe('bytes */10');
    expect(empty.statusCode).toBe(416);
    expect(empty.headers['content-range']).toBe('bytes */0');
  });

  it('blocks encoded path traversal outside the preview root', async () => {
    preview = await startPreviewServer({
      rootDirectory: join(directory, 'site'),
    });

    const response = await rawRequest(preview.port, '/..%2fsecret.txt');

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('outside-root');
  });

  it('uses the configured HTML entry for history routes but preserves asset 404s', async () => {
    preview = await startPreviewServer({
      rootDirectory: join(directory, 'site'),
      fallbackPath: 'index.html',
    });

    const route = await rawRequest(preview.port, '/portfolio/item', {
      accept: 'text/html,application/xhtml+xml',
    });
    const dottedRoute = await rawRequest(preview.port, '/people/jane.doe', {
      accept: 'text/html,application/xhtml+xml',
    });
    const missingAsset = await rawRequest(preview.port, '/missing.js', {
      accept: 'text/html,*/*',
    });
    const programmaticHtml = await rawRequest(preview.port, '/api/storefront', {
      accept: 'text/html,*/*',
      'sec-fetch-dest': 'empty',
    });

    expect(route).toMatchObject({
      statusCode: 200,
      body: '<h1>Mirror</h1>',
    });
    expect(dottedRoute).toMatchObject({
      statusCode: 200,
      body: '<h1>Mirror</h1>',
    });
    expect(missingAsset.statusCode).toBe(404);
    expect(programmaticHtml.statusCode).toBe(200);
    expect(programmaticHtml.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(programmaticHtml.body).not.toContain('<h1>Mirror</h1>');
  });

  it('serves exact source pathname and query aliases without changing asset behavior', async () => {
    preview = await startPreviewServer({
      rootDirectory: join(directory, 'site'),
      routeAliases: [
        {
          route: '/editions/winter2026',
          localPath: 'editions/winter2026.html',
        },
        {
          route: '/editions/winter2026?locale=en-US',
          localPath: 'editions/winter2026-query.html',
        },
      ],
    });

    const route = await rawRequest(preview.port, '/editions/winter2026');
    const queryRoute = await rawRequest(preview.port, '/editions/winter2026?locale=en-US');
    const unmappedQuery = await rawRequest(preview.port, '/editions/winter2026?locale=fr-FR');
    const missingAsset = await rawRequest(preview.port, '/assets/missing.js', {
      accept: 'text/html,*/*',
    });

    expect(route).toMatchObject({
      statusCode: 200,
      body: '<h1>Winter 2026</h1>',
    });
    expect(queryRoute).toMatchObject({
      statusCode: 200,
      body: '<h1>Winter 2026 Query</h1>',
    });
    expect(unmappedQuery.statusCode).toBe(404);
    expect(missingAsset.statusCode).toBe(404);
  });

  it('serves trailing-slash source routes from their local index document', async () => {
    await mkdir(join(directory, 'site', 'webgl'), { recursive: true });
    await writeFile(join(directory, 'site', 'webgl', 'index.html'), '<h1>WebGL Route</h1>');
    preview = await startPreviewServer({
      rootDirectory: join(directory, 'site'),
      routeAliases: [
        {
          route: '/webgl/',
          localPath: 'webgl/index.html',
        },
      ],
    });

    const route = await rawRequest(preview.port, '/webgl/', {
      accept: 'text/html,application/xhtml+xml',
    });

    expect(route).toMatchObject({
      statusCode: 200,
      body: '<h1>WebGL Route</h1>',
    });
  });

  it('keeps double-slash source pathnames on loopback instead of treating them as hosts', async () => {
    const manifest = {
      source: {
        url: 'https://example.test/',
        origin: 'https://example.test',
        capturedAt: '2026-08-05T00:00:00.000Z',
      },
      resources: [
        {
          sourceUrl: 'https://example.test/',
          canonicalUrl: 'https://example.test/',
          status: 'downloaded',
          localPath: 'site/index.html',
          contentType: 'text/html',
        },
        {
          sourceUrl: 'https://api.example.test//geocoding/v5/:mode/:query.json',
          canonicalUrl: 'https://api.example.test//geocoding/v5/:mode/:query.json',
          status: 'failed',
          localPath: 'site/_external/https/api.example.test/geocoding/v5/~3amode/~3aquery.json',
          contentType: 'application/json',
          error: 'Download failed with HTTP 404',
        },
      ],
    } satisfies Pick<MirrorManifest, 'source' | 'resources'>;
    const unavailableRoutes = createPreviewUnavailableRoutes(manifest);

    expect(
      previewRouteForSourceUrl('https://api.example.test//geocoding/v5/:mode/:query.json'),
    ).toBe('/geocoding/v5/:mode/:query.json');
    expect(unavailableRoutes).toContain('/geocoding/v5/:mode/:query.json');
    expect(unavailableRoutes).not.toContain('//geocoding/v5/:mode/:query.json');

    preview = await startPreviewServer({
      rootDirectory: join(directory, 'site'),
      fallbackPath: 'index.html',
      routeAliases: createPreviewRouteAliases(manifest),
      unavailableRoutes,
    });

    const missingConfiguration = await rawRequest(preview.port, '/geocoding/v5/:mode/:query.json');
    const entry = await rawRequest(preview.port, '/');

    expect(missingConfiguration.statusCode).toBe(200);
    expect(JSON.parse(missingConfiguration.body)).toMatchObject({
      success: false,
      results: [],
    });
    expect(missingConfiguration.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(entry).toMatchObject({
      statusCode: 200,
      body: '<h1>Mirror</h1>',
    });
  });

  it('serves a blank document for a known failed HTML route instead of the SPA entry shell', async () => {
    const manifest = {
      source: {
        url: 'https://example.test/',
        origin: 'https://example.test',
        capturedAt: '2026-08-05T00:00:00.000Z',
      },
      resources: [
        {
          sourceUrl: 'https://example.test/',
          canonicalUrl: 'https://example.test/',
          status: 'downloaded',
          localPath: 'site/index.html',
          contentType: 'text/html',
        },
        {
          sourceUrl: 'https://example.test/runtime/sandbox/',
          canonicalUrl: 'https://example.test/runtime/sandbox/',
          status: 'failed',
          localPath: 'site/runtime/sandbox/index.html',
          contentType: 'text/html',
          error: 'Download failed with HTTP 403',
        },
      ],
    } satisfies Pick<MirrorManifest, 'source' | 'resources'>;
    const unavailableRoutes = createPreviewUnavailableRoutes(manifest);

    expect(unavailableRoutes).toContain('/runtime/sandbox/');
    preview = await startPreviewServer({
      rootDirectory: join(directory, 'site'),
      fallbackPath: 'index.html',
      routeAliases: createPreviewRouteAliases(manifest),
      unavailableRoutes,
    });

    const failedFrame = await rawRequest(preview.port, '/runtime/sandbox/', {
      accept: 'text/html,application/xhtml+xml',
    });
    const unknownSpaRoute = await rawRequest(preview.port, '/client-side-route', {
      accept: 'text/html,application/xhtml+xml',
    });

    expect(failedFrame.statusCode).toBe(200);
    expect(failedFrame.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(failedFrame.body).toContain('Unavailable offline frame');
    expect(failedFrame.body).not.toContain('<h1>Mirror</h1>');
    expect(unknownSpaRoute).toMatchObject({
      statusCode: 200,
      body: '<h1>Mirror</h1>',
    });
  });

  it('serves downloaded root assets through an entry-route-prefixed fallback alias', async () => {
    await mkdir(join(directory, 'site', 'assets'), { recursive: true });
    await writeFile(join(directory, 'site', 'assets', 'scene.bin'), 'offline scene');
    await writeFile(join(directory, 'site', 'assets', 'fallback.gif'), '<h1>Source fallback</h1>');
    const manifest = {
      source: {
        url: 'https://example.test/work?locale=en-US',
        origin: 'https://example.test',
        capturedAt: '2026-07-22T00:00:00.000Z',
      },
      resources: [
        {
          sourceUrl: 'https://example.test/work?locale=en-US',
          canonicalUrl: 'https://example.test/work?locale=en-US',
          status: 'downloaded',
          localPath: 'site/work.html',
          contentType: 'text/html',
        },
        {
          sourceUrl: 'https://example.test/assets/scene.bin',
          canonicalUrl: 'https://example.test/assets/scene.bin',
          status: 'downloaded',
          localPath: 'site/assets/scene.bin',
          contentType: 'application/octet-stream',
        },
        {
          sourceUrl: 'https://example.test/assets/fallback.gif',
          canonicalUrl: 'https://example.test/assets/fallback.gif',
          status: 'downloaded',
          localPath: 'site/assets/fallback.gif',
          contentType: 'text/html',
        },
      ],
    } satisfies Pick<MirrorManifest, 'source' | 'resources'>;
    preview = await startPreviewServer({
      rootDirectory: join(directory, 'site'),
      routeAliases: createPreviewRouteAliases(manifest),
    });

    const response = await rawRequest(preview.port, '/work/assets/scene.bin');
    const extensionClassifiedAsset = await rawRequest(preview.port, '/work/assets/fallback.gif');

    expect(response).toMatchObject({
      statusCode: 200,
      body: 'offline scene',
    });
    expect(extensionClassifiedAsset).toMatchObject({
      statusCode: 200,
      body: '<h1>Source fallback</h1>',
    });
  });

  it('serves unique downloaded external assets through local and route-prefixed aliases', async () => {
    const externalDirectory = join(
      directory,
      'site',
      '_external',
      'https',
      'cdn.example.test',
      'media',
    );
    await mkdir(externalDirectory, { recursive: true });
    await writeFile(join(externalDirectory, 'scene.bin'), 'external scene');
    const objectStoreDirectory = join(
      directory,
      'site',
      '_external',
      'https',
      'storage.example.test',
      'bucket.example.test',
      'media',
    );
    await mkdir(objectStoreDirectory, { recursive: true });
    await writeFile(join(objectStoreDirectory, 'proxy.bin'), 'object-store scene');
    await writeFile(
      join(objectStoreDirectory, 'escaped~20~281~29.bin'),
      'escaped object-store scene',
    );
    const manifest = {
      source: {
        url: 'https://example.test/work',
        origin: 'https://example.test',
        capturedAt: '2026-07-22T00:00:00.000Z',
      },
      resources: [
        {
          sourceUrl: 'https://example.test/work',
          canonicalUrl: 'https://example.test/work',
          status: 'downloaded',
          localPath: 'site/work.html',
          contentType: 'text/html',
        },
        {
          sourceUrl: 'https://cdn.example.test/media/scene.bin',
          canonicalUrl: 'https://cdn.example.test/media/scene.bin',
          status: 'downloaded',
          localPath: 'site/_external/https/cdn.example.test/media/scene.bin',
          contentType: 'application/octet-stream',
        },
        {
          sourceUrl: 'https://storage.example.test/bucket.example.test/media/proxy.bin',
          canonicalUrl: 'https://storage.example.test/bucket.example.test/media/proxy.bin',
          status: 'downloaded',
          localPath:
            'site/_external/https/storage.example.test/bucket.example.test/media/proxy.bin',
          contentType: 'application/octet-stream',
        },
        {
          sourceUrl: 'https://storage.example.test/bucket.example.test/media/escaped%20(1).bin',
          canonicalUrl: 'https://storage.example.test/bucket.example.test/media/escaped%20(1).bin',
          status: 'downloaded',
          localPath:
            'site/_external/https/storage.example.test/bucket.example.test/media/escaped~20~281~29.bin',
          contentType: 'application/octet-stream',
        },
      ],
    } satisfies Pick<MirrorManifest, 'source' | 'resources'>;
    preview = await startPreviewServer({
      rootDirectory: join(directory, 'site'),
      routeAliases: createPreviewRouteAliases(manifest),
    });

    const direct = await rawRequest(preview.port, '/media/scene.bin');
    const routePrefixed = await rawRequest(preview.port, '/work/media/scene.bin');
    const objectStoreDirect = await rawRequest(preview.port, '/media/proxy.bin');
    const objectStoreRoutePrefixed = await rawRequest(preview.port, '/work/media/proxy.bin');
    const escapedObjectStoreDirect = await rawRequest(preview.port, '/media/escaped~20~281~29.bin');
    const escapedObjectStoreRoutePrefixed = await rawRequest(
      preview.port,
      '/work/media/escaped~20~281~29.bin',
    );
    const escapedDelimiterLossDirect = await rawRequest(
      preview.port,
      '/media/escaped20~281~29.bin',
    );
    const escapedDelimiterLossRoutePrefixed = await rawRequest(
      preview.port,
      '/work/media/escaped20~281~29.bin',
    );

    expect(direct).toMatchObject({
      statusCode: 200,
      body: 'external scene',
    });
    expect(routePrefixed).toMatchObject({
      statusCode: 200,
      body: 'external scene',
    });
    expect(objectStoreDirect).toMatchObject({
      statusCode: 200,
      body: 'object-store scene',
    });
    expect(objectStoreRoutePrefixed).toMatchObject({
      statusCode: 200,
      body: 'object-store scene',
    });
    expect(escapedObjectStoreDirect).toMatchObject({
      statusCode: 200,
      body: 'escaped object-store scene',
    });
    expect(escapedObjectStoreRoutePrefixed).toMatchObject({
      statusCode: 200,
      body: 'escaped object-store scene',
    });
    expect(escapedDelimiterLossDirect).toMatchObject({
      statusCode: 200,
      body: 'escaped object-store scene',
    });
    expect(escapedDelimiterLossRoutePrefixed).toMatchObject({
      statusCode: 200,
      body: 'escaped object-store scene',
    });
  });

  it('does not let an external asset shadow an observed same-origin route', () => {
    const manifest = {
      source: {
        url: 'https://example.test/work',
        origin: 'https://example.test',
        capturedAt: '2026-07-22T00:00:00.000Z',
      },
      resources: [
        {
          sourceUrl: 'https://example.test/work',
          canonicalUrl: 'https://example.test/work',
          status: 'downloaded',
          localPath: 'site/work.html',
          contentType: 'text/html',
        },
        {
          sourceUrl: 'https://example.test/media/scene.bin',
          canonicalUrl: 'https://example.test/media/scene.bin',
          status: 'failed',
          error: 'Source returned 404',
        },
        {
          sourceUrl: 'https://cdn.example.test/media/scene.bin',
          canonicalUrl: 'https://cdn.example.test/media/scene.bin',
          status: 'downloaded',
          localPath: 'site/_external/https/cdn.example.test/media/scene.bin',
          contentType: 'application/octet-stream',
        },
      ],
    } satisfies Pick<MirrorManifest, 'source' | 'resources'>;

    const aliases = createPreviewRouteAliases(manifest);

    expect(aliases).toContainEqual({
      route: '/work',
      localPath: 'work.html',
    });
    expect(aliases).not.toContainEqual({
      route: '/media/scene~20~281~29.bin',
      localPath:
        '_external/https/storage.example.test/bucket.example.test/media/scene~20~281~29.bin',
    });
    expect(aliases).not.toContainEqual({
      route: '/work/media/scene~20~281~29.bin',
      localPath:
        '_external/https/storage.example.test/bucket.example.test/media/scene~20~281~29.bin',
    });
  });

  it('does not let an escaped external local-path alias shadow an observed same-origin route', () => {
    const manifest = {
      source: {
        url: 'https://example.test/work',
        origin: 'https://example.test',
        capturedAt: '2026-07-22T00:00:00.000Z',
      },
      resources: [
        {
          sourceUrl: 'https://example.test/work',
          canonicalUrl: 'https://example.test/work',
          status: 'downloaded',
          localPath: 'site/work.html',
          contentType: 'text/html',
        },
        {
          sourceUrl: 'https://example.test/media/scene~20~281~29.bin',
          canonicalUrl: 'https://example.test/media/scene~20~281~29.bin',
          status: 'failed',
          localPath: 'site/media/scene~20~281~29.bin',
          error: 'Source returned 404',
        },
        {
          sourceUrl: 'https://storage.example.test/bucket.example.test/media/scene%20(1).bin',
          canonicalUrl: 'https://storage.example.test/bucket.example.test/media/scene%20(1).bin',
          status: 'downloaded',
          localPath:
            'site/_external/https/storage.example.test/bucket.example.test/media/scene~20~281~29.bin',
          contentType: 'application/octet-stream',
        },
      ],
    } satisfies Pick<MirrorManifest, 'source' | 'resources'>;

    const aliases = createPreviewRouteAliases(manifest);

    expect(aliases).toContainEqual({
      route: '/work',
      localPath: 'work.html',
    });
    expect(aliases).not.toContainEqual({
      route: '/media/scene~20~281~29.bin',
      localPath:
        '_external/https/storage.example.test/bucket.example.test/media/scene~20~281~29.bin',
    });
    expect(aliases).not.toContainEqual({
      route: '/work/media/scene~20~281~29.bin',
      localPath:
        '_external/https/storage.example.test/bucket.example.test/media/scene~20~281~29.bin',
    });
  });

  it('builds no-op routes for known failed static resources without masking downloaded paths', () => {
    const manifest = {
      source: {
        url: 'https://example.test/work',
        origin: 'https://example.test',
        capturedAt: '2026-07-22T00:00:00.000Z',
      },
      resources: [
        {
          sourceUrl: 'https://example.test/work',
          canonicalUrl: 'https://example.test/work',
          status: 'downloaded',
          localPath: 'site/work.html',
          contentType: 'text/html',
        },
        {
          sourceUrl: 'https://example.test/assets/present.bin',
          canonicalUrl: 'https://example.test/assets/present.bin',
          status: 'downloaded',
          localPath: 'site/assets/present.bin',
          contentType: 'application/octet-stream',
        },
        {
          sourceUrl: 'https://example.test/assets/missing%20(1).bin',
          canonicalUrl: 'https://example.test/assets/missing%20(1).bin',
          status: 'failed',
          localPath: 'site/assets/missing~20~281~29.bin',
          contentType: 'application/octet-stream',
          error: 'Download exceeded the byte limit',
        },
        {
          sourceUrl: 'https://storage.example.test/bucket.example.test/media/missing%20(1).jpg',
          canonicalUrl: 'https://storage.example.test/bucket.example.test/media/missing%20(1).jpg',
          status: 'skipped',
          localPath:
            'site/_external/https/storage.example.test/bucket.example.test/media/missing~20~281~29.jpg',
          contentType: 'image/jpeg',
          error: 'Resource limit reached',
        },
      ],
    } satisfies Pick<MirrorManifest, 'source' | 'resources'>;

    expect(createPreviewUnavailableRoutes(manifest)).toEqual(
      expect.arrayContaining([
        '/assets/missing%20(1).bin',
        '/assets/missing~20~281~29.bin',
        '/assets/missing20~281~29.bin',
        '/work/assets/missing20~281~29.bin',
        '/bucket.example.test/media/missing20~281~29.jpg',
        '/media/missing20~281~29.jpg',
        '/work/media/missing20~281~29.jpg',
      ]),
    );
    expect(createPreviewUnavailableRoutes(manifest)).not.toContain('/assets/present.bin');
    expect(createPreviewUnavailableRoutes(manifest)).not.toContain('/work/assets/present.bin');
  });

  it('builds same-origin HTML route aliases from the mirror manifest', () => {
    const manifest = {
      schemaVersion: 1,
      source: {
        url: 'https://www.shopify.com/editions/winter2026?locale=en-US#features',
        origin: 'https://www.shopify.com',
        capturedAt: '2026-07-21T00:00:00.000Z',
      },
      createdAt: '2026-07-21T00:00:01.000Z',
      status: 'complete',
      summary: {
        totalResources: 4,
        downloadedResources: 4,
        failedResources: 0,
        skippedResources: 0,
        cancelledResources: 0,
        totalBytes: 4,
      },
      timings: {
        totalMs: 1,
        downloadMs: 1,
        localizationMs: 0,
      },
      resources: [
        {
          sourceUrl: 'https://www.shopify.com/editions/winter2026?locale=en-US',
          canonicalUrl: 'https://www.shopify.com/editions/winter2026?locale=en-US',
          status: 'downloaded',
          localPath: 'site/editions/winter2026-query.html',
          contentType: 'text/html',
        },
        {
          sourceUrl: 'https://www.shopify.com/editions/winter2026/features',
          canonicalUrl: 'https://www.shopify.com/editions/winter2026/features',
          status: 'downloaded',
          localPath: 'site/editions/winter2026/features.html',
          contentType: 'text/html; charset=utf-8',
        },
        {
          sourceUrl: 'https://cdn.shopify.com/editions/remote',
          canonicalUrl: 'https://cdn.shopify.com/editions/remote',
          status: 'downloaded',
          localPath: 'site/_external/https/cdn.shopify.com/remote.html',
          contentType: 'text/html',
        },
        {
          sourceUrl: 'https://www.shopify.com/assets/app.js',
          canonicalUrl: 'https://www.shopify.com/assets/app.js',
          status: 'downloaded',
          localPath: 'site/assets/app.js',
          contentType: 'application/javascript',
        },
      ],
      onlineDependencies: [],
      warnings: [],
    } satisfies MirrorManifest;

    expect(previewRouteForSourceUrl(manifest.source.url)).toBe('/editions/winter2026?locale=en-US');
    expect(createPreviewRouteAliases(manifest)).toEqual([
      {
        route: '/editions/winter2026?locale=en-US',
        localPath: 'editions/winter2026-query.html',
      },
      {
        route: '/editions/winter2026/assets/app.js',
        localPath: 'assets/app.js',
      },
      {
        route: '/editions/winter2026/features',
        localPath: 'editions/winter2026/features.html',
      },
    ]);
  });
});
