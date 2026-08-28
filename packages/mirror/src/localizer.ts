import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

import { errorMessage } from './errors.js';
import { createDownloadedResourceUrlMap } from './resource-map.js';
import { rewriteTypeForResource } from './resource-type.js';
import { rewriteResource } from './rewriter.js';
import type { MirrorResourceManifest } from './types.js';
import { resolvePathInsideRoot } from './url-mapper.js';

export interface LocalizeResourcesOptions {
  outputDirectory: string;
  resources: MirrorResourceManifest[];
  maxTextBytes?: number;
  onlyLocalPaths?: ReadonlySet<string>;
  onProgress?: (localizedResources: number, totalTextResources: number) => void;
}

export interface LocalizeResourcesResult {
  onlineDependencies: string[];
  warnings: string[];
  rewrittenResources: number;
}

const defaultMaxTextBytes = 32 * 1024 * 1024;

async function replaceTextFile(path: string, text: string): Promise<Buffer> {
  const contents = Buffer.from(text, 'utf8');
  const temporaryPath = `${path}.rewrite-${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, contents, { flag: 'wx' });

    try {
      await rename(temporaryPath, path);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error;
      }

      await rm(path, { force: true });
      await rename(temporaryPath, path);
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }

  return contents;
}

function updateIntegrity(resource: MirrorResourceManifest, contents: Uint8Array): void {
  resource.size = contents.byteLength;
  resource.sha256 = createHash('sha256').update(contents).digest('hex');
}

export async function localizeDownloadedResources(
  options: LocalizeResourcesOptions,
): Promise<LocalizeResourcesResult> {
  const maximumTextBytes = options.maxTextBytes ?? defaultMaxTextBytes;

  if (!Number.isSafeInteger(maximumTextBytes) || maximumTextBytes <= 0) {
    throw new RangeError('maxTextBytes must be a positive integer.');
  }

  const mapping = createDownloadedResourceUrlMap(options.resources);
  const textResources = options.resources
    .map((resource, index) => ({ resource, index, type: rewriteTypeForResource(resource) }))
    .filter(
      (candidate) =>
        candidate.resource.status === 'downloaded' &&
        Boolean(candidate.resource.localPath) &&
        (!options.onlyLocalPaths ||
          (candidate.resource.localPath !== undefined &&
            options.onlyLocalPaths.has(candidate.resource.localPath))) &&
        candidate.type !== undefined,
    )
    .sort((left, right) => {
      const priority = (type: ReturnType<typeof rewriteTypeForResource>): number =>
        type === 'javascript' ? 0 : type === 'json' ? 1 : type === 'css' ? 2 : 3;
      const priorityOrder = priority(left.type) - priority(right.type);
      return priorityOrder === 0 ? left.index - right.index : priorityOrder;
    });
  const knownResourceUrls = new Set(
    options.resources.flatMap((resource) =>
      resource.status === 'downloaded'
        ? [resource.canonicalUrl, resource.finalUrl].filter(
            (value): value is string => typeof value === 'string' && value.length > 0,
          )
        : [],
    ),
  );
  const onlineDependencies = new Set<string>();
  const warnings: string[] = [];
  let rewrittenResources = 0;
  let localizedResources = 0;

  for (const candidate of textResources) {
    const { resource, type } = candidate;
    const localPath = resource.localPath;

    if (!type || !localPath) {
      continue;
    }

    try {
      const absolutePath = resolvePathInsideRoot(options.outputDirectory, localPath);
      const metadata = await stat(absolutePath);

      if (metadata.size > maximumTextBytes) {
        warnings.push(
          `Skipped ${localPath} localization because it exceeds ${maximumTextBytes} bytes.`,
        );
        continue;
      }

      const contents = await readFile(absolutePath);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
      const result = rewriteResource({
        type,
        text,
        resourceUrl: resource.finalUrl ?? resource.canonicalUrl,
        urlToLocalPath: mapping,
        currentLocalPath: localPath,
        knownResourceUrls: [...knownResourceUrls],
        ...(resource.workerContext ? { workerContext: true } : {}),
      });

      for (const dependency of [...result.unresolvedDependencies, ...result.onlineDependencies]) {
        onlineDependencies.add(dependency);
        knownResourceUrls.add(dependency);
      }

      if (result.text !== text) {
        const rewritten = await replaceTextFile(absolutePath, result.text);
        updateIntegrity(resource, rewritten);
        resource.rewritten = true;
        rewrittenResources += 1;
      } else {
        updateIntegrity(resource, contents);
      }
    } catch (error) {
      warnings.push(`Could not localize ${localPath}: ${errorMessage(error)}`);
    } finally {
      localizedResources += 1;
      options.onProgress?.(localizedResources, textResources.length);
    }
  }

  return {
    onlineDependencies: [...onlineDependencies].sort(),
    warnings,
    rewrittenResources,
  };
}
