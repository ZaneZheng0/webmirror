import { readFile, stat } from 'node:fs/promises';
import { posix } from 'node:path';

import { isSensitiveQueryName } from '@webmirror/shared';
import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';

import { errorMessage } from './errors.js';
import { createDownloadedResourceUrlMap } from './resource-map.js';
import { rewriteTypeForResource } from './resource-type.js';
import { rewriteResource } from './rewriter.js';
import type { MirrorResourceManifest } from './types.js';
import { resolvePathInsideRoot } from './url-mapper.js';

export interface DiscoverResourceDependenciesOptions {
  outputDirectory: string;
  resources: readonly MirrorResourceManifest[];
  maxTextBytes?: number;
  onlyLocalPaths?: ReadonlySet<string>;
  includeSameOriginNavigation?: boolean;
  sourceOrigin?: string;
  knownResourceUrls?: readonly string[];
}

export interface DiscoverResourceDependenciesResult {
  dependencies: string[];
  workerDependencies: string[];
  navigationUrls: string[];
  scannedResources: number;
  warnings: string[];
}

const defaultMaxTextBytes = 32 * 1024 * 1024;
const navigableHtmlExtensions = new Set(['.htm', '.html']);

function isElement(node: DefaultTreeAdapterTypes.Node): node is DefaultTreeAdapterTypes.Element {
  return 'tagName' in node;
}

function attribute(element: DefaultTreeAdapterTypes.Element, name: string): string | undefined {
  return element.attrs.find((candidate) => candidate.name === name)?.value;
}

function relationTokens(element: DefaultTreeAdapterTypes.Element): Set<string> {
  return new Set((attribute(element, 'rel') ?? '').toLowerCase().split(/\s+/u).filter(Boolean));
}

function discoverNavigationUrls(text: string, resourceUrl: string, sourceOrigin: string): string[] {
  const source = new URL(sourceOrigin);
  const navigationUrls = new Set<string>();
  const document = parse(text);

  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if (isElement(node) && (node.tagName === 'a' || node.tagName === 'area')) {
      const href = attribute(node, 'href');
      const relations = relationTokens(node);

      if (
        href &&
        !attribute(node, 'download') &&
        !relations.has('external') &&
        !relations.has('nofollow')
      ) {
        try {
          const target = new URL(href, resourceUrl);
          const extension = posix.extname(target.pathname).toLowerCase();
          const hasSensitiveQuery = [...target.searchParams.keys()].some(isSensitiveQueryName);

          if (
            (target.protocol === 'http:' || target.protocol === 'https:') &&
            !target.username &&
            !target.password &&
            target.origin === source.origin &&
            !hasSensitiveQuery &&
            (!extension || navigableHtmlExtensions.has(extension))
          ) {
            target.hash = '';
            navigationUrls.add(target.toString());
          }
        } catch {
          // Invalid and unsupported navigation values stay outside the mirror plan.
        }
      }
    }

    if ('childNodes' in node) {
      for (const child of node.childNodes) {
        visit(child);
      }
    }

    if (isElement(node) && node.tagName === 'template' && 'content' in node) {
      visit(node.content);
    }
  };

  visit(document);
  return [...navigationUrls].sort();
}

export async function discoverResourceDependencies(
  options: DiscoverResourceDependenciesOptions,
): Promise<DiscoverResourceDependenciesResult> {
  const maximumTextBytes = options.maxTextBytes ?? defaultMaxTextBytes;

  if (!Number.isSafeInteger(maximumTextBytes) || maximumTextBytes <= 0) {
    throw new RangeError('maxTextBytes must be a positive integer.');
  }

  const mapping = createDownloadedResourceUrlMap(options.resources);
  const dependencies = new Set<string>();
  const workerDependencies = new Set<string>();
  const navigationUrls = new Set<string>();
  const knownResourceUrls = new Set(options.knownResourceUrls ?? []);
  const warnings: string[] = [];
  let scannedResources = 0;

  const resources = options.resources
    .map((resource, index) => ({ resource, index, type: rewriteTypeForResource(resource) }))
    .filter(
      (candidate) =>
        candidate.resource.status === 'downloaded' &&
        candidate.resource.localPath &&
        candidate.type &&
        (!options.onlyLocalPaths || options.onlyLocalPaths.has(candidate.resource.localPath)),
    )
    .sort((left, right) => {
      const priority = (type: ReturnType<typeof rewriteTypeForResource>): number =>
        type === 'javascript' ? 0 : type === 'json' ? 1 : type === 'css' ? 2 : 3;
      const priorityOrder = priority(left.type) - priority(right.type);
      return priorityOrder === 0 ? left.index - right.index : priorityOrder;
    });

  for (const candidate of resources) {
    const { resource, type } = candidate;
    const localPath = resource.localPath;

    if (!localPath || !type) {
      continue;
    }

    try {
      const absolutePath = resolvePathInsideRoot(options.outputDirectory, localPath);
      const metadata = await stat(absolutePath);

      if (metadata.size > maximumTextBytes) {
        warnings.push(
          `Skipped ${localPath} dependency discovery because it exceeds ${maximumTextBytes} bytes.`,
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
      });
      const directlyDiscoveredWorkerDependencies = new Set(result.workerDependencies ?? []);

      for (const dependency of [...result.unresolvedDependencies, ...result.onlineDependencies]) {
        dependencies.add(dependency);
        knownResourceUrls.add(dependency);

        if (resource.workerContext || directlyDiscoveredWorkerDependencies.has(dependency)) {
          workerDependencies.add(dependency);
        }
      }

      if (options.includeSameOriginNavigation && options.sourceOrigin && type === 'html') {
        for (const navigationUrl of discoverNavigationUrls(
          text,
          resource.finalUrl ?? resource.canonicalUrl,
          options.sourceOrigin,
        )) {
          navigationUrls.add(navigationUrl);
        }
      }
    } catch (error) {
      warnings.push(`Could not discover dependencies in ${localPath}: ${errorMessage(error)}`);
    } finally {
      scannedResources += 1;
    }
  }

  return {
    dependencies: [...dependencies].sort(),
    workerDependencies: [...workerDependencies].sort(),
    navigationUrls: [...navigationUrls].sort(),
    scannedResources,
    warnings,
  };
}
