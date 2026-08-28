import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Writable } from 'node:stream';

import {
  canonicalizeResourceUrl,
  createPreviewRouteAliases,
  createPreviewUnavailableRoutes,
  previewRouteForSourceUrl,
  startPreviewServer,
  type MirrorManifest,
} from '@webmirror/mirror';

import { openExternalTarget } from './open-external.js';

function parseManifest(value: unknown): MirrorManifest {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('source' in value) ||
    typeof value.source !== 'object' ||
    value.source === null ||
    !('url' in value.source) ||
    typeof value.source.url !== 'string' ||
    !('resources' in value) ||
    !Array.isArray(value.resources)
  ) {
    throw new Error('The selected directory does not contain a valid WebMirror manifest.');
  }

  return value as MirrorManifest;
}

function entryPath(manifest: MirrorManifest): string {
  const sourceUrl = canonicalizeResourceUrl(manifest.source.url);
  const entry =
    manifest.resources.find(
      (resource) =>
        resource.status === 'downloaded' &&
        resource.canonicalUrl === sourceUrl &&
        resource.localPath?.startsWith('site/'),
    ) ??
    manifest.resources.find(
      (resource) =>
        resource.status === 'downloaded' &&
        resource.contentType?.toLowerCase().startsWith('text/html') &&
        resource.localPath?.startsWith('site/'),
    );

  if (!entry?.localPath) {
    throw new Error('The mirror manifest does not contain a runnable HTML entry.');
  }

  return entry.localPath.slice('site/'.length);
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolveShutdown) => {
    const stop = () => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      resolveShutdown();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export async function serveMirrorDirectory(
  directory: string,
  options: {
    open: boolean;
    output: Writable;
  },
): Promise<number> {
  const outputDirectory = resolve(directory);
  const manifest = parseManifest(
    JSON.parse(await readFile(join(outputDirectory, 'mirror.json'), 'utf8')) as unknown,
  );
  const fallbackPath = entryPath(manifest);
  const server = await startPreviewServer({
    rootDirectory: join(outputDirectory, 'site'),
    manifest,
    fallbackPath,
    routeAliases: createPreviewRouteAliases(manifest),
    unavailableRoutes: createPreviewUnavailableRoutes(manifest),
  });
  const url = new URL(previewRouteForSourceUrl(manifest.source.url), server.url).toString();
  options.output.write(`${url}\n`);

  if (options.open) {
    await openExternalTarget(url);
  }

  try {
    await waitForShutdownSignal();
  } finally {
    await server.close();
  }

  return 0;
}
