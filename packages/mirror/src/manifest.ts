import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { MirrorManifest } from './types.js';
import { resolvePathInsideRoot } from './url-mapper.js';

export async function writeMirrorManifest(
  outputDirectory: string,
  manifest: MirrorManifest,
): Promise<string> {
  const manifestPath = resolvePathInsideRoot(outputDirectory, 'mirror.json');
  const tempPath = resolvePathInsideRoot(
    outputDirectory,
    `.mirror-${randomUUID().replaceAll('-', '')}.json.tmp`,
  );
  await mkdir(dirname(manifestPath), { recursive: true });

  try {
    await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });

    try {
      await rename(tempPath, manifestPath);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error;
      }

      await rm(manifestPath, { force: true });
      await rename(tempPath, manifestPath);
    }

    return manifestPath;
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}
