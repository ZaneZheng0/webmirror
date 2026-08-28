import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverResourceDependencies } from './discovery.js';
import { createTestDirectory, removeTestDirectory } from './test-utils.js';
import type { MirrorResourceManifest } from './types.js';

describe('discoverResourceDependencies', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await createTestDirectory('webmirror-discovery-');
    await mkdir(join(directory, 'site'), { recursive: true });
  });

  afterEach(async () => {
    await removeTestDirectory(directory);
  });

  it('reports bounded same-origin HTML navigation only when requested', async () => {
    const html = `<!doctype html>
      <link rel="stylesheet" href="/assets/app.css">
      <a href="/next.html">Next</a>
      <a href="/route">Route</a>
      <a href="/download.pdf">Download</a>
      <a href="/private?token=do-not-follow">Private</a>
      <a href="https://outside.example/page.html">Outside</a>
      <meta http-equiv="refresh" content="2; url=/redirect.html">`;
    const htmlPath = join(directory, 'site', 'index.html');
    await writeFile(htmlPath, html);
    const resources: MirrorResourceManifest[] = [
      {
        sourceUrl: 'https://example.com/index.html',
        canonicalUrl: 'https://example.com/index.html',
        status: 'downloaded',
        localPath: 'site/index.html',
        contentType: 'text/html',
      },
    ];

    const result = await discoverResourceDependencies({
      outputDirectory: directory,
      resources,
      includeSameOriginNavigation: true,
      sourceOrigin: 'https://example.com',
    });

    expect(result).toMatchObject({
      dependencies: ['https://example.com/assets/app.css'],
      workerDependencies: [],
      navigationUrls: ['https://example.com/next.html', 'https://example.com/route'],
      scannedResources: 1,
      warnings: [],
    });
  });

  it('retains statically composed Worker dependencies as worker-context resources', async () => {
    const workerPath = join(directory, 'site', 'runtime-worker.js');
    await writeFile(
      workerPath,
      `
        const runtimeRoot = ['https://example.com', '/runtime/'].join('');
        const manifest = { nestedWorker: ['nested', '-worker.js'].join('') };
        new Worker(runtimeRoot + manifest.nestedWorker, { type: 'module' });
      `,
    );
    const resources: MirrorResourceManifest[] = [
      {
        sourceUrl: 'https://example.com/runtime/runtime-worker.js',
        canonicalUrl: 'https://example.com/runtime/runtime-worker.js',
        status: 'downloaded',
        localPath: 'site/runtime-worker.js',
        contentType: 'application/javascript',
        workerContext: true,
      },
    ];

    const result = await discoverResourceDependencies({
      outputDirectory: directory,
      resources,
    });

    expect(result.dependencies).toEqual(['https://example.com/runtime/nested-worker.js']);
    expect(result.workerDependencies).toEqual(['https://example.com/runtime/nested-worker.js']);
  });

  it('marks a Worker entry discovered from a page script for Worker-localization', async () => {
    const pageScriptPath = join(directory, 'site', 'app.js');
    await writeFile(
      pageScriptPath,
      `
        const runtimeRoot = ['https://example.com', '/runtime/'].join('');
        const manifest = { worker: ['module', '-worker.js'].join('') };
        new Worker(runtimeRoot + manifest.worker, { type: 'module' });
      `,
    );
    const resources: MirrorResourceManifest[] = [
      {
        sourceUrl: 'https://example.com/app.js',
        canonicalUrl: 'https://example.com/app.js',
        status: 'downloaded',
        localPath: 'site/app.js',
        contentType: 'application/javascript',
      },
    ];

    const result = await discoverResourceDependencies({
      outputDirectory: directory,
      resources,
    });

    expect(result.dependencies).toEqual(['https://example.com/runtime/module-worker.js']);
    expect(result.workerDependencies).toEqual(['https://example.com/runtime/module-worker.js']);
  });

  it('scans JavaScript inventories before config files and shares newly discovered URLs', async () => {
    const jsonPath = join(directory, 'site', 'runtime.json');
    const scriptPath = join(directory, 'site', 'app.js');
    await writeFile(jsonPath, JSON.stringify({ image: 'assets/images/pbr/normal.ktx2' }));
    await writeFile(
      scriptPath,
      `
        window.RUNTIME_TEXTURES = [
          { filename: "pbr/base.ktx2", bytes: 10 },
          { filename: "pbr/mask.ktx2", bytes: 20 },
          { filename: "pbr/normal.ktx2", bytes: 30 },
        ];
      `,
    );
    const resources: MirrorResourceManifest[] = [
      {
        sourceUrl: 'https://example.com/assets/data/runtime.json',
        canonicalUrl: 'https://example.com/assets/data/runtime.json',
        status: 'downloaded',
        localPath: 'site/runtime.json',
        contentType: 'application/json',
      },
      {
        sourceUrl: 'https://example.com/assets/js/app.js',
        canonicalUrl: 'https://example.com/assets/js/app.js',
        status: 'downloaded',
        localPath: 'site/app.js',
        contentType: 'application/javascript',
      },
    ];

    const result = await discoverResourceDependencies({
      outputDirectory: directory,
      resources,
      knownResourceUrls: [
        'https://example.com/assets/images/pbr/base.ktx2',
        'https://example.com/assets/images/pbr/mask.ktx2',
      ],
    });

    expect(result.dependencies).toContain('https://example.com/assets/images/pbr/normal.ktx2');
    expect(result.dependencies).not.toContain(
      'https://example.com/assets/data/assets/images/pbr/normal.ktx2',
    );
    expect(result.scannedResources).toBe(2);
  });
});
