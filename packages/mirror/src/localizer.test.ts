import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { localizeDownloadedResources } from './localizer.js';
import { createTestDirectory, removeTestDirectory } from './test-utils.js';
import type { MirrorResourceManifest } from './types.js';

describe('localizeDownloadedResources', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await createTestDirectory('webmirror-localizer-');
    await mkdir(join(directory, 'site', 'assets'), { recursive: true });
  });

  afterEach(async () => {
    await removeTestDirectory(directory);
  });

  it('rewrites known references, records unresolved dependencies, and refreshes integrity', async () => {
    const htmlPath = join(directory, 'site', 'index.html');
    const cssPath = join(directory, 'site', 'assets', 'app.css');
    await writeFile(
      htmlPath,
      '<!doctype html><link rel="stylesheet" href="/assets/app.css"><img src="https://cdn.invalid/missing.png">',
    );
    await writeFile(cssPath, 'body { background: url("./missing.png") }');
    const resources: MirrorResourceManifest[] = [
      {
        sourceUrl: 'https://example.com/',
        canonicalUrl: 'https://example.com/',
        status: 'downloaded',
        localPath: 'site/index.html',
        contentType: 'text/html',
        size: 1,
        sha256: 'old',
      },
      {
        sourceUrl: 'https://example.com/assets/app.css',
        canonicalUrl: 'https://example.com/assets/app.css',
        status: 'downloaded',
        localPath: 'site/assets/app.css',
        contentType: 'text/css',
        size: 1,
        sha256: 'old',
      },
    ];
    const progress: Array<[number, number]> = [];

    const result = await localizeDownloadedResources({
      outputDirectory: directory,
      resources,
      onProgress: (completed, total) => progress.push([completed, total]),
    });

    expect(await readFile(htmlPath, 'utf8')).toContain('href="assets/app.css"');
    expect(result.onlineDependencies).toEqual([
      'https://cdn.invalid/missing.png',
      'https://example.com/assets/missing.png',
    ]);
    expect(resources[0]).toMatchObject({
      rewritten: true,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('does not report same-origin absolute aliases to existing local paths on a second pass', async () => {
    const scriptPath = join(directory, 'site', 'assets', 'app.js');
    const localAssetPath = join(directory, 'site', 'assets', 'scene~q-0123456789ab.ktx2');
    await writeFile(scriptPath, 'textureLoader.load("https://example.com/assets/scene.ktx2?v=7");');
    await writeFile(localAssetPath, Buffer.from([1, 2, 3]));
    const resources: MirrorResourceManifest[] = [
      {
        sourceUrl: 'https://example.com/assets/app.js',
        canonicalUrl: 'https://example.com/assets/app.js',
        status: 'downloaded',
        localPath: 'site/assets/app.js',
        contentType: 'application/javascript',
      },
      {
        sourceUrl: 'https://example.com/assets/scene.ktx2?v=7',
        canonicalUrl: 'https://example.com/assets/scene.ktx2?v=7',
        status: 'downloaded',
        localPath: 'site/assets/scene~q-0123456789ab.ktx2',
        contentType: 'image/ktx2',
      },
    ];

    const first = await localizeDownloadedResources({
      outputDirectory: directory,
      resources,
    });
    await writeFile(
      scriptPath,
      'textureLoader.load("https://example.com/assets/scene~q-0123456789ab.ktx2");',
    );
    const second = await localizeDownloadedResources({
      outputDirectory: directory,
      resources,
    });

    expect(first.onlineDependencies).toEqual([]);
    expect(second).toMatchObject({
      onlineDependencies: [],
      rewrittenResources: 0,
      warnings: [],
    });
    expect(await readFile(scriptPath, 'utf8')).toContain(
      '"https://example.com/assets/scene~q-0123456789ab.ktx2"',
    );
  });

  it('preserves implicit JavaScript asset leaves for runtime base URL composition', async () => {
    const scriptPath = join(directory, 'site', 'assets', 'loader.js');
    const imagePath = join(directory, 'site', 'assets', 'arrow.png');
    const source = `
      const CDN = "https://cdn.example.net/";
      const manifest = {
        items: [{ id: "arrow", url: "images/arrow.png" }],
      };
      new AssetBatch(manifest, { baseUrl: CDN }).start();
    `;
    await writeFile(scriptPath, source);
    await writeFile(imagePath, Buffer.from([1, 2, 3]));
    const resources: MirrorResourceManifest[] = [
      {
        sourceUrl: 'https://cdn.example.net/loader.js',
        canonicalUrl: 'https://cdn.example.net/loader.js',
        status: 'downloaded',
        localPath: 'site/assets/loader.js',
        contentType: 'application/javascript',
      },
      {
        sourceUrl: 'https://cdn.example.net/images/arrow.png',
        canonicalUrl: 'https://cdn.example.net/images/arrow.png',
        status: 'downloaded',
        localPath: 'site/assets/arrow.png',
        contentType: 'image/png',
      },
    ];

    const result = await localizeDownloadedResources({
      outputDirectory: directory,
      resources,
    });

    expect(result.onlineDependencies).toEqual([]);
    expect(await readFile(scriptPath, 'utf8')).toContain('url: "images/arrow.png"');
    expect(await readFile(scriptPath, 'utf8')).not.toContain('url: "/assets/arrow.png"');
  });

  it('scans JavaScript before JSON so deployment URLs localize config assets in the same pass', async () => {
    const jsonPath = join(directory, 'site', 'assets', 'runtime.json');
    const scriptPath = join(directory, 'site', 'assets', 'app.js');
    const assetPath = join(directory, 'site', 'assets', 'road.ktx2');
    await writeFile(jsonPath, JSON.stringify({ src: 'assets/images/pbr/road.ktx2' }));
    await writeFile(
      scriptPath,
      'window.RUNTIME_TEXTURES = [{ filename: "pbr/road.ktx2", bytes: 10 }, { filename: "pbr/mask.ktx2", bytes: 20 }];',
    );
    await writeFile(assetPath, Buffer.from([1, 2, 3]));
    const resources: MirrorResourceManifest[] = [
      {
        sourceUrl: 'https://example.com/assets/data/runtime.json',
        canonicalUrl: 'https://example.com/assets/data/runtime.json',
        status: 'downloaded',
        localPath: 'site/assets/runtime.json',
        contentType: 'application/json',
      },
      {
        sourceUrl: 'https://example.com/assets/js/app.js',
        canonicalUrl: 'https://example.com/assets/js/app.js',
        status: 'downloaded',
        localPath: 'site/assets/app.js',
        contentType: 'application/javascript',
      },
      {
        sourceUrl: 'https://example.com/assets/images/pbr/road.ktx2',
        canonicalUrl: 'https://example.com/assets/images/pbr/road.ktx2',
        status: 'downloaded',
        localPath: 'site/assets/road.ktx2',
        contentType: 'image/ktx2',
      },
    ];

    const result = await localizeDownloadedResources({
      outputDirectory: directory,
      resources,
    });

    expect(result.onlineDependencies).toEqual([]);
    expect(JSON.parse(await readFile(jsonPath, 'utf8'))).toEqual({ src: '/assets/road.ktx2' });
  });

  it('injects the runtime URL mapper into worker-context scripts only', async () => {
    const workerPath = join(directory, 'site', 'assets', 'worker.js');
    const libraryPath = join(directory, 'site', 'assets', 'worker-runtime.js');
    const modelPath = join(directory, 'site', 'assets', 'model.bin');
    const workerSource = `"use strict";
const runtimeRoot = "https://cdn.example.net/assets/";
importScripts(runtimeRoot + "worker-runtime.js");
self.addEventListener("message", () => fetch(runtimeRoot + "model.bin"));
`;
    await writeFile(workerPath, workerSource);
    await writeFile(libraryPath, 'self.workerRuntimeLoaded = true;\n');
    await writeFile(modelPath, Buffer.from([1, 2, 3]));
    const resources: MirrorResourceManifest[] = [
      {
        sourceUrl: 'https://cdn.example.net/assets/worker.js',
        canonicalUrl: 'https://cdn.example.net/assets/worker.js',
        status: 'downloaded',
        localPath: 'site/assets/worker.js',
        contentType: 'application/javascript',
        workerContext: true,
      },
      {
        sourceUrl: 'https://cdn.example.net/assets/worker-runtime.js',
        canonicalUrl: 'https://cdn.example.net/assets/worker-runtime.js',
        status: 'downloaded',
        localPath: 'site/assets/worker-runtime.js',
        contentType: 'application/javascript',
      },
      {
        sourceUrl: 'https://cdn.example.net/assets/model.bin',
        canonicalUrl: 'https://cdn.example.net/assets/model.bin',
        status: 'downloaded',
        localPath: 'site/assets/model.bin',
        contentType: 'application/octet-stream',
      },
    ];

    const result = await localizeDownloadedResources({
      outputDirectory: directory,
      resources,
    });
    const localizedWorker = await readFile(workerPath, 'utf8');
    const localizedLibrary = await readFile(libraryPath, 'utf8');

    expect(result.onlineDependencies).toEqual([]);
    expect(localizedWorker).toContain('"use strict";\n/* webmirror-worker-runtime-url-map-v1 */');
    expect(localizedWorker).toContain('global.fetch=function(input,init)');
    expect(localizedWorker).toContain('global.importScripts=function()');
    expect(localizedWorker).toContain(
      '["https://cdn.example.net/assets/model.bin","/assets/model.bin"]',
    );
    expect(localizedWorker).toContain('importScripts(runtimeRoot + "worker-runtime.js")');
    expect(localizedLibrary).not.toContain('webmirror-worker-runtime-url-map-v1');
    expect(resources[0]?.workerContext).toBe(true);
  });

  it('refreshes an existing worker runtime map when later localization adds resources', async () => {
    const workerPath = join(directory, 'site', 'assets', 'worker.js');
    const texturePath = join(directory, 'site', 'assets', 'images', 'pbr', 'road.ktx2');
    await writeFile(
      workerPath,
      'self.addEventListener("message", () => fetch("/images/pbr/road.ktx2"));\n',
    );
    const resources: MirrorResourceManifest[] = [
      {
        sourceUrl: 'https://example.com/assets/worker.js',
        canonicalUrl: 'https://example.com/assets/worker.js',
        status: 'downloaded',
        localPath: 'site/assets/worker.js',
        contentType: 'application/javascript',
        workerContext: true,
      },
    ];

    await localizeDownloadedResources({
      outputDirectory: directory,
      resources,
    });
    const firstPass = await readFile(workerPath, 'utf8');

    expect(firstPass).not.toContain('["/images/pbr/road.ktx2","/assets/images/pbr/road.ktx2"]');

    await mkdir(join(directory, 'site', 'assets', 'images', 'pbr'), { recursive: true });
    await writeFile(texturePath, Buffer.from([1, 2, 3]));
    resources.push({
      sourceUrl: 'https://example.com/assets/images/pbr/road.ktx2',
      canonicalUrl: 'https://example.com/assets/images/pbr/road.ktx2',
      status: 'downloaded',
      localPath: 'site/assets/images/pbr/road.ktx2',
      contentType: 'image/ktx2',
    });

    const second = await localizeDownloadedResources({
      outputDirectory: directory,
      resources,
    });
    const secondPass = await readFile(workerPath, 'utf8');

    expect(second.warnings).toEqual([]);
    expect(secondPass.match(/\/\* webmirror-worker-runtime-url-map-v1 \*\//gu)).toHaveLength(1);
    expect(secondPass).toContain('/* /webmirror-worker-runtime-url-map-v1 */');
    expect(secondPass).toContain('["/images/pbr/road.ktx2","/assets/images/pbr/road.ktx2"]');
  });
});
