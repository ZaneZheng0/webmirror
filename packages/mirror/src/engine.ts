import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';

import {
  isKnownNonessentialExternalUrl,
  redactSensitiveText,
  redactSensitiveUrl,
} from '@webmirror/shared';

import { ContentAddressedCache, type CacheResponseMetadata } from './cache.js';
import { discoverResourceDependencies } from './discovery.js';
import {
  downloadResource,
  downloadResourceForTesting,
  isRetryableDownloadError,
} from './downloader.js';
import {
  createAbortError,
  DownloadSizeLimitError,
  errorMessage,
  isAbortError,
  ResponseContentMismatchError,
} from './errors.js';
import { localizeDownloadedResources } from './localizer.js';
import { writeMirrorManifest } from './manifest.js';
import { normalizeContentType } from './mime.js';
import {
  imageRenditionIdentity,
  isPreferredImageRenditionUrl,
  type ImageRenditionTarget,
} from './resource-map.js';
import { redactStaticJavaScriptCredentials } from './secret-redaction.js';
import { maximumSecretScanBytes, scanFileForHighConfidenceSecrets } from './secret-scan.js';
import {
  mirrorManifestVersion,
  type CaptureResourceInput,
  type CreateMirrorOptions,
  type MirrorCaptureInput,
  type MirrorManifest,
  type MirrorProgress,
  type MirrorResourceManifest,
  type MirrorStatus,
} from './types.js';
import {
  canonicalizeResourceUrl,
  mapUrlToLocalPath,
  parseResourceUrl,
  resolvePathInsideRoot,
} from './url-mapper.js';

interface PreparedDownload {
  input: CaptureResourceInput;
  canonicalUrl: string;
  localPath: string;
  resultIndex: number;
}

interface ResourcePlan {
  results: MirrorResourceManifest[];
  seenUrls: Set<string>;
  localPaths: Map<string, string>;
}

interface PreparedResourceBatch {
  downloads: PreparedDownload[];
  addedResults: number;
}

interface ScheduledDownload {
  download: PreparedDownload;
  desiredReservationBytes: number;
  minimumRequiredBytes?: number;
}

type ResourceDownloader = typeof downloadResource;

const defaultMaximumResourceBytes = 512 * 1024 * 1024;
const minimumAdaptiveReservationBytes = 64 * 1024;
const adaptiveReservationDivisor = 8;
const maximumUnknownTailProbeFailures = 4;
const minimumMediaBudgetForAudioReserve = 1024 * 1024;
const maximumDeferredAudioReserveBytes = 32 * 1024 * 1024;

function workerContextEvidence(
  input: CaptureResourceInput,
): Pick<MirrorResourceManifest, 'resourceType' | 'workerContext'> {
  return {
    ...(input.resourceType ? { resourceType: input.resourceType } : {}),
    ...(input.workerContext ? { workerContext: true } : {}),
  };
}

function boundedConcurrency(value: number | undefined): number {
  const concurrency = value ?? 8;

  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new RangeError(
      `Concurrency must be an integer between 1 and 32, received ${concurrency}`,
    );
  }

  return concurrency;
}

function boundedDiscoveryRounds(value: number | undefined): number {
  const rounds = value ?? 8;

  if (!Number.isInteger(rounds) || rounds < 0 || rounds > 10) {
    throw new RangeError(
      `maxDiscoveryRounds must be an integer between 0 and 10, received ${rounds}`,
    );
  }

  return rounds;
}

function boundedResourceLimit(value: number | undefined): number {
  const limit = value ?? 1_500;

  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new RangeError(`maxResources must be an integer between 1 and 10000, received ${limit}`);
  }

  return limit;
}

function boundedTotalBytes(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const maximum = 64 * 1024 * 1024 * 1024;

  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(
      `maxTotalBytes must be an integer between 1 and ${maximum}, received ${value}`,
    );
  }

  return value;
}

function boundedResourceBytes(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const maximum = 8 * 1024 * 1024 * 1024;

  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(
      `maxResourceBytes must be an integer between 1 and ${maximum}, received ${value}`,
    );
  }

  return value;
}

function normalizedSizeHint(input: CaptureResourceInput): number | undefined {
  const value = input.capturedBody?.byteLength ?? input.expectedSize;

  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    return undefined;
  }

  return value;
}

function initialReservationBytes(input: CaptureResourceInput, maximumBytes: number): number {
  const capturedBytes = input.capturedBody?.byteLength;

  if (capturedBytes !== undefined && Number.isSafeInteger(capturedBytes) && capturedBytes >= 0) {
    return Math.min(maximumBytes, Math.max(1, capturedBytes));
  }

  const adaptiveBaseline = Math.min(
    maximumBytes,
    Math.max(minimumAdaptiveReservationBytes, Math.ceil(maximumBytes / adaptiveReservationDivisor)),
  );
  const sizeHint = normalizedSizeHint(input);

  return Math.min(maximumBytes, Math.max(adaptiveBaseline, sizeHint ?? 0, 1));
}

function minimumUnknownTailReservationBytes(reservationCeiling: number): number {
  return Math.min(
    minimumAdaptiveReservationBytes,
    Math.max(1, Math.ceil(reservationCeiling / 1024)),
  );
}

function boundedNavigationPageLimit(value: number | undefined): number {
  const limit = value ?? 0;

  if (!Number.isInteger(limit) || limit < 0 || limit > 100) {
    throw new RangeError(
      `maxNavigationPages must be an integer between 0 and 100, received ${limit}`,
    );
  }

  return limit;
}

function navigationScopePath(sourceUrl: URL): string | undefined {
  const pathname = sourceUrl.pathname || '/';

  if (pathname === '/') {
    return undefined;
  }

  if (pathname.endsWith('/')) {
    const scope = pathname.slice(0, -1);
    return scope === '' ? undefined : scope;
  }

  if (posix.extname(pathname)) {
    const directory = posix.dirname(pathname);
    return directory === '/' || directory === '.' ? undefined : directory;
  }

  return pathname;
}

function isNavigationWithinSourceScope(sourceUrl: URL, candidateUrl: string): boolean {
  const candidate = new URL(candidateUrl);

  if (candidate.origin !== sourceUrl.origin) {
    return false;
  }

  const scope = navigationScopePath(sourceUrl);
  return (
    scope === undefined ||
    candidate.pathname === scope ||
    candidate.pathname.startsWith(`${scope}/`)
  );
}

const expandableRuntimeExtensions = new Set([
  '.cjs',
  '.css',
  '.gltf',
  '.hdr',
  '.htm',
  '.html',
  '.js',
  '.json',
  '.mjs',
  '.webmanifest',
  '.xml',
]);
const requiredLeafExtensions = new Set([
  '.basis',
  '.bin',
  '.csv',
  '.dds',
  '.drc',
  '.glb',
  '.hdr',
  '.ktx',
  '.ktx2',
  '.otf',
  '.riv',
  '.ttf',
  '.wasm',
  '.woff',
  '.woff2',
]);
const audioExtensions = new Set(['.aac', '.flac', '.m4a', '.mp3', '.oga', '.ogg', '.opus', '.wav']);
const videoExtensions = new Set(['.m4v', '.mov', '.mp4', '.ogv', '.webm']);
const renderedMediaExtensions = new Set([...audioExtensions, ...videoExtensions]);
const imageExtensions = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.webp',
]);

type ResourceEvidenceInput = CaptureResourceInput & {
  initiatorType?: string;
  resourceType?: string;
};

function normalizedEvidenceValue(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function isImageResourceInput(value: string, input?: CaptureResourceInput): boolean {
  const evidence = input as ResourceEvidenceInput | undefined;
  const resourceType = normalizedEvidenceValue(evidence?.resourceType);
  const contentType = normalizeContentType(input?.contentType);

  if (resourceType === 'image' || contentType?.startsWith('image/')) {
    return true;
  }

  try {
    return imageExtensions.has(posix.extname(new URL(value).pathname).toLowerCase());
  } catch {
    return false;
  }
}

function dependencyPriority(value: string, input?: CaptureResourceInput): number {
  const evidence = input as ResourceEvidenceInput | undefined;
  const resourceType = normalizedEvidenceValue(evidence?.resourceType);
  const initiatorType = normalizedEvidenceValue(evidence?.initiatorType);
  const contentType = normalizeContentType(input?.contentType);
  let extension: string | undefined;

  try {
    extension = posix.extname(new URL(value).pathname).toLowerCase();
  } catch {
    extension = undefined;
  }

  if (
    resourceType === 'font' ||
    contentType?.startsWith('font/') ||
    contentType === 'application/wasm' ||
    contentType === 'model/gltf-binary' ||
    (extension !== undefined && requiredLeafExtensions.has(extension))
  ) {
    return 1;
  }

  if (
    resourceType === 'audio' ||
    resourceType === 'texttrack' ||
    contentType?.startsWith('audio/') ||
    (extension !== undefined && audioExtensions.has(extension))
  ) {
    return 2;
  }

  if (
    resourceType === 'media' ||
    resourceType === 'video' ||
    contentType?.startsWith('video/') ||
    (extension !== undefined && videoExtensions.has(extension))
  ) {
    return 3;
  }

  if (resourceType === 'image' || contentType?.startsWith('image/')) {
    return 4;
  }

  if (
    resourceType === 'document' ||
    resourceType === 'script' ||
    resourceType === 'stylesheet' ||
    resourceType === 'xhr' ||
    resourceType === 'fetch' ||
    resourceType === 'manifest' ||
    initiatorType === 'parser' ||
    initiatorType === 'script' ||
    contentType === 'text/html' ||
    contentType === 'application/xhtml+xml' ||
    contentType === 'text/css' ||
    contentType === 'application/javascript' ||
    contentType === 'application/ecmascript' ||
    contentType === 'text/javascript' ||
    contentType === 'text/ecmascript' ||
    contentType === 'application/json' ||
    contentType === 'application/manifest+json' ||
    contentType === 'model/gltf+json' ||
    contentType?.endsWith('+json')
  ) {
    return 0;
  }

  if (extension !== undefined) {
    if (expandableRuntimeExtensions.has(extension)) {
      return 0;
    }

    if (requiredLeafExtensions.has(extension)) {
      return 1;
    }

    if (renderedMediaExtensions.has(extension)) {
      return videoExtensions.has(extension) ? 3 : 2;
    }

    if (imageExtensions.has(extension)) {
      return 4;
    }
  }

  // Unknown URLs discovered from executable text are treated as expandable until
  // their response MIME proves otherwise. This preserves extensionless modules,
  // manifests, and fetch endpoints ahead of optional media.
  return 0;
}

function prioritizedDependencies(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => {
    const priorityDifference = dependencyPriority(left) - dependencyPriority(right);
    return priorityDifference === 0 ? left.localeCompare(right) : priorityDifference;
  });
}

function prioritizedInputs(inputs: readonly CaptureResourceInput[]): CaptureResourceInput[] {
  return [...inputs].sort((left, right) => {
    const priorityDifference =
      dependencyPriority(left.sourceUrl, left) - dependencyPriority(right.sourceUrl, right);
    return priorityDifference === 0
      ? left.sourceUrl.localeCompare(right.sourceUrl)
      : priorityDifference;
  });
}

function isDeferredRequiredAsset(value: string, input?: CaptureResourceInput): boolean {
  return dependencyPriority(value, input) === 1;
}

function isDeferredRenderedAsset(value: string, input?: CaptureResourceInput): boolean {
  return dependencyPriority(value, input) >= 2;
}

type DeferredMediaKind = 'audio' | 'video';

function deferredMediaKind(
  value: string,
  input?: CaptureResourceInput,
): DeferredMediaKind | undefined {
  const priority = dependencyPriority(value, input);
  return priority === 2 ? 'audio' : priority === 3 ? 'video' : undefined;
}

function deferredVideoAdmissionLimit(
  maxDeferredMediaBytes: number | undefined,
): number | undefined {
  if (
    maxDeferredMediaBytes === undefined ||
    maxDeferredMediaBytes < minimumMediaBudgetForAudioReserve
  ) {
    return maxDeferredMediaBytes;
  }

  const reservedAudioBytes = Math.min(
    maximumDeferredAudioReserveBytes,
    Math.floor(maxDeferredMediaBytes / 4),
  );
  return Math.max(0, maxDeferredMediaBytes - reservedAudioBytes);
}

function coalesceRenderedAssetInputs(
  candidates: ReadonlyMap<string, CaptureResourceInput>,
  target?: ImageRenditionTarget,
): CaptureResourceInput[] {
  const selected = new Map<string, CaptureResourceInput>();
  const selectedImageUrlsByIdentity = new Map<string, string>();

  for (const canonicalUrl of prioritizedDependencies([...candidates.keys()])) {
    const input = candidates.get(canonicalUrl);

    if (!input) {
      continue;
    }

    if (!isImageResourceInput(canonicalUrl, input)) {
      selected.set(canonicalUrl, input);
      continue;
    }

    const identity = imageRenditionIdentity(canonicalUrl);
    const existingUrl = selectedImageUrlsByIdentity.get(identity);

    if (!existingUrl) {
      selectedImageUrlsByIdentity.set(identity, canonicalUrl);
      selected.set(canonicalUrl, input);
      continue;
    }

    if (!isPreferredImageRenditionUrl(canonicalUrl, existingUrl, target)) {
      continue;
    }

    selected.delete(existingUrl);
    selectedImageUrlsByIdentity.set(identity, canonicalUrl);
    selected.set(canonicalUrl, input);
  }

  return prioritizedDependencies([...selected.keys()]).flatMap((canonicalUrl) => {
    const input = selected.get(canonicalUrl);
    return input ? [input] : [];
  });
}

interface ResourceCandidateBuckets {
  expandable: CaptureResourceInput[];
  required: Map<string, CaptureResourceInput>;
  rendered: Map<string, CaptureResourceInput>;
  rejected: CaptureResourceInput[];
  knownUrls: Set<string>;
}

function mergeResourceEvidence(
  existing: CaptureResourceInput,
  candidate: CaptureResourceInput,
): CaptureResourceInput {
  const preferred =
    !existing.capturedBody && candidate.capturedBody
      ? candidate
      : existing.contentType || !candidate.contentType
        ? existing
        : candidate;

  return {
    ...existing,
    ...candidate,
    ...preferred,
    sourceUrl: preferred.sourceUrl,
  };
}

function bucketResourceCandidates(
  resources: readonly CaptureResourceInput[],
  sourceUrl: URL,
): ResourceCandidateBuckets {
  const candidates = new Map<string, CaptureResourceInput>();
  const rejected: CaptureResourceInput[] = [];

  for (const input of resources) {
    try {
      const canonicalUrl = canonicalizeResourceUrl(input.sourceUrl);

      if (isKnownNonessentialExternalUrl(canonicalUrl)) {
        continue;
      }

      const existing = candidates.get(canonicalUrl);
      candidates.set(canonicalUrl, existing ? mergeResourceEvidence(existing, input) : input);
    } catch {
      rejected.push(input);
    }
  }

  const sourceCanonicalUrl = canonicalizeResourceUrl(sourceUrl.toString());

  const expandable: CaptureResourceInput[] = [];
  const required = new Map<string, CaptureResourceInput>();
  const rendered = new Map<string, CaptureResourceInput>();

  for (const [canonicalUrl, input] of candidates) {
    if (isDeferredRenderedAsset(canonicalUrl, input)) {
      rendered.set(canonicalUrl, input);
    } else if (isDeferredRequiredAsset(canonicalUrl, input)) {
      required.set(canonicalUrl, input);
    } else {
      expandable.push(input);
    }
  }

  const orderedExpandable = prioritizedInputs(expandable);
  const sourceIndex = orderedExpandable.findIndex((input) => {
    try {
      return canonicalizeResourceUrl(input.sourceUrl) === sourceCanonicalUrl;
    } catch {
      return false;
    }
  });

  if (sourceIndex > 0) {
    const [sourceInput] = orderedExpandable.splice(sourceIndex, 1);

    if (sourceInput) {
      orderedExpandable.unshift(sourceInput);
    }
  }

  return {
    expandable: orderedExpandable,
    required,
    rendered,
    rejected,
    knownUrls: new Set(candidates.keys()),
  };
}

function renditionTargetForCapture(input: MirrorCaptureInput): ImageRenditionTarget | undefined {
  return input.viewport
    ? {
        width: input.viewport.width,
        height: input.viewport.height,
        deviceScaleFactor: input.viewport.deviceScaleFactor,
      }
    : undefined;
}

function appendCollisionIndex(localPath: string, index: number): string {
  const extension = posix.extname(localPath);
  const stem = extension ? localPath.slice(0, -extension.length) : localPath;
  return `${stem}~u-${index}${extension}`;
}

function mirrorStatus(resources: readonly MirrorResourceManifest[]): MirrorStatus {
  if (resources.some((resource) => resource.status === 'cancelled')) {
    return 'cancelled';
  }

  const downloaded = resources.filter((resource) => resource.status === 'downloaded').length;
  const incomplete = resources.some(
    (resource) =>
      resource.status === 'pending' ||
      resource.status === 'failed' ||
      resource.status === 'skipped',
  );

  if (!incomplete) {
    return 'complete';
  }

  return downloaded > 0 ? 'partial' : 'failed';
}

function summarize(resources: readonly MirrorResourceManifest[]) {
  return {
    totalResources: resources.length,
    downloadedResources: resources.filter((resource) => resource.status === 'downloaded').length,
    failedResources: resources.filter((resource) => resource.status === 'failed').length,
    skippedResources: resources.filter((resource) => resource.status === 'skipped').length,
    cancelledResources: resources.filter((resource) => resource.status === 'cancelled').length,
    totalBytes: resources.reduce((total, resource) => total + (resource.size ?? 0), 0),
  };
}

function redactManifestForStorage(manifest: MirrorManifest): void {
  manifest.source.url = redactSensitiveUrl(manifest.source.url);
  manifest.resources = manifest.resources.map((resource) => ({
    ...resource,
    sourceUrl: redactSensitiveUrl(resource.sourceUrl),
    canonicalUrl: redactSensitiveUrl(resource.canonicalUrl),
    ...(resource.finalUrl ? { finalUrl: redactSensitiveUrl(resource.finalUrl) } : {}),
    ...(resource.error ? { error: redactSensitiveText(resource.error) } : {}),
  }));
  manifest.onlineDependencies = manifest.onlineDependencies.map(redactSensitiveUrl);
  manifest.warnings = manifest.warnings.map(redactSensitiveText);
}

function progressSnapshot(
  resources: readonly MirrorResourceManifest[],
  completedResources: number,
  currentUrl?: string,
  phase: MirrorProgress['phase'] = 'downloading',
  localizedResources = 0,
  totalTextResources = 0,
): MirrorProgress {
  const completed = resources.filter(
    (resource) =>
      resource.status === 'downloaded' ||
      resource.status === 'failed' ||
      resource.status === 'skipped' ||
      resource.status === 'cancelled',
  );

  return {
    phase,
    totalResources: resources.length,
    completedResources: Math.min(completedResources, completed.length),
    downloadedResources: completed.filter((resource) => resource.status === 'downloaded').length,
    failedResources: completed.filter((resource) => resource.status === 'failed').length,
    skippedResources: completed.filter((resource) => resource.status === 'skipped').length,
    cancelledResources: completed.filter((resource) => resource.status === 'cancelled').length,
    downloadedBytes: completed.reduce((total, resource) => total + (resource.size ?? 0), 0),
    localizedResources,
    totalTextResources,
    ...(currentUrl ? { currentUrl } : {}),
  };
}

function notifyProgress(
  options: CreateMirrorOptions,
  resources: readonly MirrorResourceManifest[],
  completedResources: number,
  currentUrl?: string,
  phase: MirrorProgress['phase'] = 'downloading',
  localizedResources = 0,
  totalTextResources = 0,
): void {
  if (!options.onProgress) {
    return;
  }

  try {
    options.onProgress(
      progressSnapshot(
        resources,
        completedResources,
        currentUrl,
        phase,
        localizedResources,
        totalTextResources,
      ),
    );
  } catch {
    // Progress observers must not change the mirror result.
  }
}

function isJavaScriptResource(resource: MirrorResourceManifest): boolean {
  const contentType = normalizeContentType(resource.contentType);

  return (
    contentType === 'application/javascript' ||
    contentType === 'application/x-javascript' ||
    contentType === 'text/javascript' ||
    ['.cjs', '.js', '.mjs'].includes(posix.extname(resource.localPath ?? '').toLowerCase())
  );
}

async function replaceRedactedTextFile(path: string, contents: Buffer): Promise<void> {
  const temporaryPath = `${path}.redact-${randomUUID()}.tmp`;

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
}

async function scanDownloadedResources(
  outputDirectory: string,
  resources: MirrorResourceManifest[],
  signal: AbortSignal | undefined,
  onlyLocalPaths?: ReadonlySet<string>,
): Promise<string[]> {
  const candidates = resources.filter(
    (resource) =>
      resource.status === 'downloaded' &&
      resource.localPath &&
      (onlyLocalPaths === undefined || onlyLocalPaths.has(resource.localPath)),
  );
  const warnings: string[] = [];
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < candidates.length) {
      const resource = candidates[nextIndex];
      nextIndex += 1;

      if (!resource?.localPath) {
        continue;
      }

      if (signal?.aborted) {
        throw createAbortError();
      }

      const filePath = resolvePathInsideRoot(outputDirectory, resource.localPath);
      const scan = await scanFileForHighConfidenceSecrets(
        filePath,
        resource.contentType,
        resource.localPath,
      );

      if (scan.findings.length === 0) {
        continue;
      }

      const hasRedactableFinding = scan.findings.some(
        (finding) => finding !== 'scan_limit_exceeded',
      );

      if (!hasRedactableFinding) {
        warnings.push(
          `Sensitive-content scanning was skipped for ${resource.localPath} because it exceeds the ${maximumSecretScanBytes}-byte scan limit; the downloaded resource was retained without inspection.`,
        );
        continue;
      }

      if (isJavaScriptResource(resource)) {
        const source = await readFile(filePath, 'utf8');
        const redaction = redactStaticJavaScriptCredentials(source);

        if (redaction.replacements > 0) {
          const sanitized = Buffer.from(redaction.text, 'utf8');
          await replaceRedactedTextFile(filePath, sanitized);

          const rescanned = await scanFileForHighConfidenceSecrets(
            filePath,
            resource.contentType,
            resource.localPath,
          );

          if (rescanned.findings.length === 0) {
            resource.size = sanitized.byteLength;
            resource.sha256 = createHash('sha256').update(sanitized).digest('hex');
            resource.credentialsRedacted = true;
            warnings.push(
              `Static credential literals were redacted from ${resource.localPath}; features that require those external credentials are unavailable in the offline mirror.`,
            );
            continue;
          }
        }
      }

      await rm(filePath, { force: true });
      resource.status = 'failed';
      resource.securityIssue = 'sensitive_content';
      resource.error = `High-confidence sensitive content was detected (${scan.findings.join(
        ', ',
      )}).`;
      delete resource.size;
      delete resource.sha256;
      warnings.push(
        `A local resource was quarantined after high-confidence sensitive-content detection: ${resource.localPath}.`,
      );
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(4, Math.max(1, candidates.length)) }, () => worker()),
  );
  return warnings;
}

async function commitCacheCandidates(
  cacheDirectory: string | undefined,
  outputDirectory: string,
  resources: readonly MirrorResourceManifest[],
  candidates: ReadonlyMap<number, CacheResponseMetadata>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!cacheDirectory || candidates.size === 0) {
    return;
  }

  const cache = new ContentAddressedCache(cacheDirectory);
  const indexes = [...candidates.keys()];
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < indexes.length) {
      const resultIndex = indexes[nextIndex];
      nextIndex += 1;

      if (signal?.aborted) {
        throw createAbortError();
      }

      if (resultIndex === undefined) {
        continue;
      }

      const resource = resources[resultIndex];
      const candidate = candidates.get(resultIndex);

      if (
        !resource ||
        resource.status !== 'downloaded' ||
        resource.bodySource !== 'network' ||
        resource.credentialsRedacted === true ||
        !resource.localPath ||
        !candidate
      ) {
        continue;
      }

      const filePath = resolvePathInsideRoot(outputDirectory, resource.localPath);
      await cache.put(resource.canonicalUrl, filePath, candidate, signal ? { signal } : {});
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(4, Math.max(1, indexes.length)) }, () => worker()),
  );
}

function appendResources(
  plan: ResourcePlan,
  resources: readonly CaptureResourceInput[],
  sourceOrigin: string,
): PreparedResourceBatch {
  const initialResultCount = plan.results.length;
  const downloads: PreparedDownload[] = [];

  for (const input of resources) {
    let canonicalUrl: string;

    try {
      canonicalUrl = canonicalizeResourceUrl(input.sourceUrl);
    } catch (error) {
      plan.results.push({
        sourceUrl: input.sourceUrl,
        canonicalUrl: input.sourceUrl,
        status: 'skipped',
        ...workerContextEvidence(input),
        error: errorMessage(error),
      });
      continue;
    }

    if (isKnownNonessentialExternalUrl(canonicalUrl)) {
      continue;
    }

    if (plan.seenUrls.has(canonicalUrl)) {
      continue;
    }

    plan.seenUrls.add(canonicalUrl);

    if ((input.method ?? 'GET').toUpperCase() !== 'GET') {
      plan.results.push({
        sourceUrl: input.sourceUrl,
        canonicalUrl,
        status: 'skipped',
        ...workerContextEvidence(input),
        error: `Unsupported request method: ${input.method}`,
      });
      continue;
    }

    try {
      let localPath = mapUrlToLocalPath(canonicalUrl, {
        sourceOrigin,
        ...(input.contentType ? { contentType: input.contentType } : {}),
      });
      const baseLocalPath = localPath;
      let collisionIndex = 2;
      let existingUrl = plan.localPaths.get(localPath.toLowerCase());

      while (existingUrl && existingUrl !== canonicalUrl) {
        localPath = appendCollisionIndex(baseLocalPath, collisionIndex);
        collisionIndex += 1;
        existingUrl = plan.localPaths.get(localPath.toLowerCase());
      }

      plan.localPaths.set(localPath.toLowerCase(), canonicalUrl);
      const resultIndex = plan.results.length;
      plan.results.push({
        sourceUrl: input.sourceUrl,
        canonicalUrl,
        status: 'pending',
        localPath,
        ...(input.contentType ? { contentType: input.contentType } : {}),
        ...workerContextEvidence(input),
      });
      downloads.push({
        input,
        canonicalUrl,
        localPath,
        resultIndex,
      });
    } catch (error) {
      plan.results.push({
        sourceUrl: input.sourceUrl,
        canonicalUrl,
        status: 'skipped',
        ...workerContextEvidence(input),
        error: errorMessage(error),
      });
    }
  }

  return {
    downloads,
    addedResults: plan.results.length - initialResultCount,
  };
}

async function createMirrorWithDownloader(
  input: MirrorCaptureInput,
  options: CreateMirrorOptions,
  resourceDownloader: ResourceDownloader,
): Promise<MirrorManifest> {
  const sourceUrl = parseResourceUrl(input.sourceUrl);
  const concurrency = boundedConcurrency(options.concurrency);
  const maxDiscoveryRounds = boundedDiscoveryRounds(options.maxDiscoveryRounds);
  const configuredResourceLimit = boundedResourceLimit(options.maxResources);
  const maxNavigationPages = boundedNavigationPageLimit(options.maxNavigationPages);
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const plan: ResourcePlan = {
    results: [],
    seenUrls: new Set<string>(),
    localPaths: new Map<string, string>(),
  };
  const cacheCandidates = new Map<number, CacheResponseMetadata>();
  const maxResourceBytes = boundedResourceBytes(options.maxResourceBytes);
  const maxTotalBytes = boundedTotalBytes(options.maxTotalBytes);
  const maxDeferredMediaBytes = boundedTotalBytes(options.maxDeferredMediaBytes);
  const maxDeferredVideoAdmissionBytes = deferredVideoAdmissionLimit(maxDeferredMediaBytes);
  const reservationCeiling =
    maxTotalBytes === undefined
      ? undefined
      : Math.min(maxResourceBytes ?? defaultMaximumResourceBytes, maxTotalBytes);
  const minimumUnknownTailBytes =
    reservationCeiling === undefined
      ? undefined
      : minimumUnknownTailReservationBytes(reservationCeiling);
  const resourceLimit = configuredResourceLimit;
  const discoveryWarnings: string[] = [];
  const securityWarnings: string[] = [];
  let resourceBoundaryReported = false;
  let byteBoundaryReported = false;
  let discoveryRoundBoundaryReported = false;
  let navigationBoundaryReported = false;
  let capturedNavigationPages = 0;
  let unknownTailProbeFailures = 0;
  let unknownTailBudgetClosed = false;

  const reportResourceBoundary = (context: string, omittedAtLeast: number): void => {
    if (resourceBoundaryReported) {
      return;
    }

    resourceBoundaryReported = true;
    discoveryWarnings.push(
      `Capability boundary: the resource limit of ${resourceLimit} was reached ${context}; at least ${Math.max(
        1,
        omittedAtLeast,
      )} reachable resource(s) were omitted and the mirror is partial.`,
    );
  };
  const reportByteBoundary = (context: string): void => {
    if (byteBoundaryReported || maxTotalBytes === undefined) {
      return;
    }

    byteBoundaryReported = true;
    discoveryWarnings.push(
      `Capability boundary: the total download limit of ${maxTotalBytes} bytes was reached ${context}; remaining resources were omitted and the mirror is partial.`,
    );
  };
  const reportDiscoveryRoundBoundary = (omittedAtLeast: number): void => {
    if (discoveryRoundBoundaryReported) {
      return;
    }

    discoveryRoundBoundaryReported = true;
    discoveryWarnings.push(
      `Capability boundary: static dependency discovery reached the ${maxDiscoveryRounds}-round limit; at least ${Math.max(
        1,
        omittedAtLeast,
      )} reachable resource(s) require a deeper graph traversal and the mirror is partial.`,
    );
  };
  const reportNavigationBoundary = (omittedAtLeast: number): void => {
    if (navigationBoundaryReported) {
      return;
    }

    navigationBoundaryReported = true;
    discoveryWarnings.push(
      `Capability boundary: same-origin navigation capture reached the ${maxNavigationPages}-page limit; at least ${Math.max(
        1,
        omittedAtLeast,
      )} linked page(s) were not mirrored and the mirror is partial.`,
    );
  };
  const notifyPlannedResources = (downloads: readonly PreparedDownload[]): void => {
    for (const download of downloads) {
      options.onResourcePlanned?.({
        ...download.input,
        canonicalUrl: download.canonicalUrl,
        localPath: download.localPath,
      });
    }
  };
  const initialCandidates = bucketResourceCandidates(input.resources, sourceUrl);
  const rejectedInitialBatch = appendResources(plan, initialCandidates.rejected, sourceUrl.origin);
  const selectedInitialExpandable = initialCandidates.expandable.slice(0, resourceLimit);

  if (selectedInitialExpandable.length < initialCandidates.expandable.length) {
    reportResourceBoundary(
      'while retaining browser-observed runtime resources from the active page',
      initialCandidates.expandable.length - selectedInitialExpandable.length,
    );
  }

  const initialBatch = appendResources(plan, selectedInitialExpandable, sourceUrl.origin);
  notifyPlannedResources(initialBatch.downloads);
  const results = plan.results;
  let completedDownloads =
    rejectedInitialBatch.addedResults -
    rejectedInitialBatch.downloads.length +
    initialBatch.addedResults -
    initialBatch.downloads.length;
  let downloadedBytes = 0;
  let reservedDownloadBytes = 0;
  let downloadedDeferredMediaBytes = 0;
  let reservedDeferredMediaBytes = 0;

  const downloadBatch = async (downloads: readonly PreparedDownload[]): Promise<void> => {
    if (downloads.length === 0) {
      notifyProgress(options, results, completedDownloads);
      return;
    }

    const queue: ScheduledDownload[] = downloads.map((download) => ({
      download,
      desiredReservationBytes:
        reservationCeiling === undefined
          ? 0
          : initialReservationBytes(download.input, reservationCeiling),
    }));
    const budgetWaiters: Array<() => void> = [];
    const wakeBudgetWaiters = (): void => {
      for (const resolve of budgetWaiters.splice(0)) {
        resolve();
      }
    };
    const waitForBudgetChange = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        budgetWaiters.push(resolve);
      });
    };
    options.signal?.addEventListener('abort', wakeBudgetWaiters);
    notifyProgress(options, results, completedDownloads);

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const scheduled = queue.shift();

        if (!scheduled) {
          return;
        }

        const { download } = scheduled;

        if (options.signal?.aborted) {
          results[download.resultIndex] = {
            sourceUrl: download.input.sourceUrl,
            canonicalUrl: download.canonicalUrl,
            status: 'cancelled',
            localPath: download.localPath,
            ...workerContextEvidence(download.input),
            error: 'Download cancelled',
          };
          completedDownloads += 1;
          notifyProgress(options, results, completedDownloads, download.canonicalUrl);
          continue;
        }

        let reservedBytes = 0;
        let maximumDownloadBytes = maxResourceBytes;
        let byteBudgetExhausted = false;
        let tailBudgetReservation = false;
        const mediaKind = deferredMediaKind(download.canonicalUrl, download.input);
        const deferredMedia = mediaKind !== undefined;
        const deferredMediaLimit =
          mediaKind === 'video' ? maxDeferredVideoAdmissionBytes : maxDeferredMediaBytes;
        let reservedMediaBytes = 0;
        let mediaBudgetExhausted = false;

        if (maxTotalBytes !== undefined && reservationCeiling !== undefined) {
          while (options.signal?.aborted !== true) {
            const remainingBytes = Math.max(
              0,
              maxTotalBytes - downloadedBytes - reservedDownloadBytes,
            );
            const sizeHint = normalizedSizeHint(download.input);

            if (remainingBytes >= scheduled.desiredReservationBytes) {
              reservedBytes = scheduled.desiredReservationBytes;
              reservedDownloadBytes += reservedBytes;
              maximumDownloadBytes = reservedBytes;
              break;
            }

            if (reservedDownloadBytes > 0) {
              await waitForBudgetChange();
              continue;
            }

            if (
              remainingBytes <= 0 ||
              (scheduled.minimumRequiredBytes !== undefined &&
                scheduled.minimumRequiredBytes > remainingBytes) ||
              (sizeHint !== undefined && sizeHint > remainingBytes) ||
              (unknownTailBudgetClosed && sizeHint === undefined) ||
              (minimumUnknownTailBytes !== undefined &&
                remainingBytes <= minimumUnknownTailBytes &&
                sizeHint === undefined)
            ) {
              byteBudgetExhausted = true;

              if (
                minimumUnknownTailBytes !== undefined &&
                remainingBytes <= minimumUnknownTailBytes &&
                sizeHint === undefined
              ) {
                unknownTailBudgetClosed = true;
              }

              break;
            }

            reservedBytes = remainingBytes;
            reservedDownloadBytes += reservedBytes;
            maximumDownloadBytes = reservedBytes;
            tailBudgetReservation = true;
            break;
          }
        }

        if (
          !byteBudgetExhausted &&
          deferredMedia &&
          deferredMediaLimit !== undefined &&
          reservationCeiling !== undefined
        ) {
          while (options.signal?.aborted !== true) {
            const remainingMediaBytes = Math.max(
              0,
              deferredMediaLimit - downloadedDeferredMediaBytes - reservedDeferredMediaBytes,
            );
            const sizeHint = normalizedSizeHint(download.input);

            if (remainingMediaBytes >= reservedBytes) {
              reservedMediaBytes = reservedBytes;
              reservedDeferredMediaBytes += reservedMediaBytes;
              break;
            }

            if (reservedDeferredMediaBytes > 0) {
              await waitForBudgetChange();
              continue;
            }

            if (
              remainingMediaBytes <= 0 ||
              (sizeHint !== undefined && sizeHint > remainingMediaBytes)
            ) {
              mediaBudgetExhausted = true;
              break;
            }

            reservedMediaBytes = remainingMediaBytes;
            reservedDeferredMediaBytes += reservedMediaBytes;
            maximumDownloadBytes = Math.min(
              maximumDownloadBytes ?? remainingMediaBytes,
              remainingMediaBytes,
            );
            break;
          }
        }

        if (options.signal?.aborted) {
          results[download.resultIndex] = {
            sourceUrl: download.input.sourceUrl,
            canonicalUrl: download.canonicalUrl,
            status: 'cancelled',
            localPath: download.localPath,
            ...workerContextEvidence(download.input),
            error: 'Download cancelled',
          };
          completedDownloads += 1;
          notifyProgress(options, results, completedDownloads, download.canonicalUrl);
          continue;
        }

        if (byteBudgetExhausted || mediaBudgetExhausted) {
          reservedDownloadBytes = Math.max(0, reservedDownloadBytes - reservedBytes);
          reservedDeferredMediaBytes = Math.max(0, reservedDeferredMediaBytes - reservedMediaBytes);
          wakeBudgetWaiters();
          results[download.resultIndex] = {
            sourceUrl: download.input.sourceUrl,
            canonicalUrl: download.canonicalUrl,
            status: 'skipped',
            localPath: download.localPath,
            ...(download.input.contentType ? { contentType: download.input.contentType } : {}),
            ...workerContextEvidence(download.input),
            error: mediaBudgetExhausted
              ? mediaKind === 'video' && deferredMediaLimit !== maxDeferredMediaBytes
                ? `Deferred video admission limit of ${deferredMediaLimit} bytes was reached while reserving capacity for later audio resources`
                : `Deferred media download limit of ${maxDeferredMediaBytes} bytes was reached`
              : `Task download limit of ${maxTotalBytes} bytes was reached`,
          };

          if (byteBudgetExhausted) {
            reportByteBoundary(`before ${download.canonicalUrl} could be downloaded`);
          }
          completedDownloads += 1;
          notifyProgress(options, results, completedDownloads, download.canonicalUrl);
          continue;
        }

        let adaptiveRetry: ScheduledDownload | undefined;

        try {
          const result = await resourceDownloader(download.canonicalUrl, {
            rootDirectory: options.outputDirectory,
            localPath: download.localPath,
            ...(download.input.contentType
              ? { expectedContentType: download.input.contentType }
              : {}),
            ...(download.input.resourceType
              ? { expectedResourceType: download.input.resourceType }
              : {}),
            ...(download.input.expectedSize !== undefined
              ? { expectedSize: download.input.expectedSize }
              : {}),
            ...(maximumDownloadBytes !== undefined ? { maxBytes: maximumDownloadBytes } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
            ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
            ...(options.maxRedirects !== undefined ? { maxRedirects: options.maxRedirects } : {}),
            ...(options.cacheDirectory ? { cacheDirectory: options.cacheDirectory } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(download.input.capturedBody ? { capturedBody: download.input.capturedBody } : {}),
          });

          results[download.resultIndex] = {
            sourceUrl: download.input.sourceUrl,
            canonicalUrl: download.canonicalUrl,
            status: 'downloaded',
            localPath: result.localPath,
            finalUrl: result.finalUrl,
            contentType: result.contentType,
            httpStatus: result.httpStatus,
            size: result.size,
            sha256: result.sha256,
            attempts: result.attempts,
            bodySource: result.bodySource,
            ...workerContextEvidence(download.input),
          };
          downloadedBytes += result.size;

          if (deferredMedia) {
            downloadedDeferredMediaBytes += result.size;
          }

          if (tailBudgetReservation) {
            unknownTailProbeFailures = 0;
          }

          if (result.cacheCandidate) {
            cacheCandidates.set(download.resultIndex, result.cacheCandidate);
          }
        } catch (error) {
          const cancelled = isAbortError(error) || options.signal?.aborted === true;
          const sizeLimitError = error instanceof DownloadSizeLimitError ? error : undefined;
          const tailBudgetExceeded = tailBudgetReservation && sizeLimitError !== undefined;
          const deferredMediaBudgetExceeded =
            deferredMedia &&
            deferredMediaLimit !== undefined &&
            sizeLimitError !== undefined &&
            reservedMediaBytes > 0 &&
            (sizeLimitError.requiredBytes === undefined ||
              sizeLimitError.requiredBytes > deferredMediaLimit - downloadedDeferredMediaBytes);
          const canIncreaseAdaptiveReservation =
            !cancelled &&
            !deferredMediaBudgetExceeded &&
            !tailBudgetReservation &&
            sizeLimitError !== undefined &&
            reservationCeiling !== undefined &&
            reservedBytes > 0 &&
            reservedBytes < reservationCeiling &&
            (sizeLimitError.requiredBytes === undefined ||
              sizeLimitError.requiredBytes <= reservationCeiling);

          if (canIncreaseAdaptiveReservation) {
            const nextReservationBytes = Math.min(
              reservationCeiling,
              Math.max(reservedBytes + 1, reservedBytes * 2, sizeLimitError.requiredBytes ?? 0),
            );
            adaptiveRetry = {
              download,
              desiredReservationBytes: nextReservationBytes,
              ...(sizeLimitError.requiredBytes !== undefined
                ? { minimumRequiredBytes: sizeLimitError.requiredBytes }
                : scheduled.minimumRequiredBytes !== undefined
                  ? { minimumRequiredBytes: scheduled.minimumRequiredBytes }
                  : {}),
            };
          }

          if (
            !cancelled &&
            maxTotalBytes !== undefined &&
            sizeLimitError !== undefined &&
            tailBudgetExceeded
          ) {
            reportByteBoundary(`while downloading ${download.canonicalUrl}`);

            if (normalizedSizeHint(download.input) === undefined) {
              unknownTailProbeFailures += 1;
              unknownTailBudgetClosed = unknownTailProbeFailures >= maximumUnknownTailProbeFailures;
            }
          }

          if (!adaptiveRetry) {
            results[download.resultIndex] = {
              sourceUrl: download.input.sourceUrl,
              canonicalUrl: download.canonicalUrl,
              status: cancelled
                ? 'cancelled'
                : tailBudgetExceeded || deferredMediaBudgetExceeded
                  ? 'skipped'
                  : 'failed',
              localPath: download.localPath,
              ...(download.input.contentType ? { contentType: download.input.contentType } : {}),
              ...workerContextEvidence(download.input),
              ...(!cancelled && !tailBudgetExceeded
                ? {
                    // The downloader already performed its bounded retry loop.
                    // A remaining shape/MIME mismatch is semantic (commonly a
                    // deterministic SPA shell), not a transient network outage,
                    // and must not trigger the Helper's bulk retry pass.
                    retryable:
                      !(error instanceof ResponseContentMismatchError) &&
                      isRetryableDownloadError(error),
                  }
                : {}),
              error: cancelled
                ? 'Download cancelled'
                : deferredMediaBudgetExceeded
                  ? mediaKind === 'video' && deferredMediaLimit !== maxDeferredMediaBytes
                    ? `Deferred video admission limit of ${deferredMediaLimit} bytes was reached while reserving capacity for later audio resources`
                    : `Deferred media download limit of ${maxDeferredMediaBytes} bytes was reached`
                  : tailBudgetExceeded
                    ? `Task download limit of ${maxTotalBytes} bytes was reached`
                    : errorMessage(error),
            };
          }
        } finally {
          reservedDownloadBytes = Math.max(0, reservedDownloadBytes - reservedBytes);
          reservedDeferredMediaBytes = Math.max(0, reservedDeferredMediaBytes - reservedMediaBytes);

          if (adaptiveRetry) {
            queue.unshift(adaptiveRetry);
          }

          wakeBudgetWaiters();

          if (!adaptiveRetry) {
            completedDownloads += 1;
            notifyProgress(options, results, completedDownloads, download.canonicalUrl);
          }
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(concurrency, downloads.length) }, () => worker()),
      );
    } finally {
      options.signal?.removeEventListener('abort', wakeBudgetWaiters);
      wakeBudgetWaiters();
    }
  };

  const downloadedLocalPaths = (downloads: readonly PreparedDownload[]): ReadonlySet<string> =>
    new Set(
      downloads.flatMap((download) => {
        const resource = results[download.resultIndex];
        return resource?.status === 'downloaded' && resource.localPath ? [resource.localPath] : [];
      }),
    );

  await downloadBatch(initialBatch.downloads);

  securityWarnings.push(
    ...(await scanDownloadedResources(
      options.outputDirectory,
      results,
      options.signal,
      new Set(initialBatch.downloads.map((download) => download.localPath)),
    )),
  );

  interface DependencyClosureResult {
    navigationUrls: string[];
    reachedResourceLimit: boolean;
  }

  const downloadDependencyClosure = async (
    initialFrontier: ReadonlySet<string>,
    includeSameOriginNavigation: boolean,
    seedRequiredAssets: ReadonlyMap<string, CaptureResourceInput> = new Map(),
    seedRenderedAssets: ReadonlyMap<string, CaptureResourceInput> = new Map(),
    additionalKnownUrls: ReadonlySet<string> = new Set(),
  ): Promise<DependencyClosureResult> => {
    let frontier = initialFrontier;
    let roundsCompleted = 0;
    let reachedResourceLimit = false;
    const navigationUrls = new Set<string>();
    const deferredRequiredAssets = new Map(seedRequiredAssets);
    const deferredRenderedAssets = new Map(seedRenderedAssets);
    const knownResourceUrls = (): string[] => [
      ...plan.seenUrls,
      ...additionalKnownUrls,
      ...deferredRequiredAssets.keys(),
      ...deferredRenderedAssets.keys(),
    ];

    while (
      roundsCompleted < maxDiscoveryRounds &&
      frontier.size > 0 &&
      options.signal?.aborted !== true
    ) {
      const discovery = await discoverResourceDependencies({
        outputDirectory: options.outputDirectory,
        resources: results,
        onlyLocalPaths: frontier,
        includeSameOriginNavigation,
        sourceOrigin: sourceUrl.origin,
        knownResourceUrls: knownResourceUrls(),
      });
      roundsCompleted += 1;
      discoveryWarnings.push(...discovery.warnings);

      for (const navigationUrl of discovery.navigationUrls) {
        navigationUrls.add(navigationUrl);
      }

      const candidates = new Map<string, CaptureResourceInput>();
      const workerDependencies = new Set(discovery.workerDependencies);

      for (const dependency of prioritizedDependencies(discovery.dependencies)) {
        try {
          const canonicalUrl = canonicalizeResourceUrl(dependency);

          if (
            plan.seenUrls.has(canonicalUrl) ||
            candidates.has(canonicalUrl) ||
            deferredRequiredAssets.has(canonicalUrl) ||
            deferredRenderedAssets.has(canonicalUrl)
          ) {
            continue;
          }

          const candidate = {
            sourceUrl: canonicalUrl,
            method: 'GET',
            ...(workerDependencies.has(canonicalUrl) ? { workerContext: true } : {}),
          } satisfies CaptureResourceInput;

          if (isDeferredRenderedAsset(canonicalUrl)) {
            deferredRenderedAssets.set(canonicalUrl, candidate);
          } else if (isDeferredRequiredAsset(canonicalUrl)) {
            deferredRequiredAssets.set(canonicalUrl, candidate);
          } else {
            candidates.set(canonicalUrl, candidate);
          }
        } catch {
          // The final localization pass reports malformed or unsupported references.
        }
      }

      if (candidates.size === 0) {
        frontier = new Set<string>();
        break;
      }

      const remainingCapacity = Math.max(0, resourceLimit - plan.seenUrls.size);
      const selectedInputs = [...candidates.values()].slice(0, remainingCapacity);
      reachedResourceLimit = selectedInputs.length < candidates.size;

      if (reachedResourceLimit) {
        reportResourceBoundary(
          'while preserving the current document runtime dependency closure',
          candidates.size - selectedInputs.length,
        );
      }

      if (selectedInputs.length === 0) {
        frontier = new Set<string>();
        break;
      }

      const discoveredBatch = appendResources(plan, selectedInputs, sourceUrl.origin);
      notifyPlannedResources(discoveredBatch.downloads);
      completedDownloads += discoveredBatch.addedResults - discoveredBatch.downloads.length;
      await downloadBatch(discoveredBatch.downloads);
      securityWarnings.push(
        ...(await scanDownloadedResources(
          options.outputDirectory,
          results,
          options.signal,
          new Set(discoveredBatch.downloads.map((download) => download.localPath)),
        )),
      );
      frontier = downloadedLocalPaths(discoveredBatch.downloads);

      if (reachedResourceLimit) {
        break;
      }
    }

    if (
      maxDiscoveryRounds > 0 &&
      !reachedResourceLimit &&
      roundsCompleted >= maxDiscoveryRounds &&
      frontier.size > 0 &&
      options.signal?.aborted !== true
    ) {
      const remaining = await discoverResourceDependencies({
        outputDirectory: options.outputDirectory,
        resources: results,
        onlyLocalPaths: frontier,
        includeSameOriginNavigation,
        sourceOrigin: sourceUrl.origin,
        knownResourceUrls: knownResourceUrls(),
      });
      discoveryWarnings.push(...remaining.warnings);

      for (const navigationUrl of remaining.navigationUrls) {
        navigationUrls.add(navigationUrl);
      }

      let unseenDependencies = 0;
      const workerDependencies = new Set(remaining.workerDependencies);

      for (const dependency of prioritizedDependencies(remaining.dependencies)) {
        try {
          const canonicalUrl = canonicalizeResourceUrl(dependency);

          if (
            plan.seenUrls.has(canonicalUrl) ||
            deferredRequiredAssets.has(canonicalUrl) ||
            deferredRenderedAssets.has(canonicalUrl)
          ) {
            continue;
          }

          if (isDeferredRenderedAsset(canonicalUrl)) {
            deferredRenderedAssets.set(canonicalUrl, {
              sourceUrl: canonicalUrl,
              method: 'GET',
              ...(workerDependencies.has(canonicalUrl) ? { workerContext: true } : {}),
            });
          } else if (isDeferredRequiredAsset(canonicalUrl)) {
            deferredRequiredAssets.set(canonicalUrl, {
              sourceUrl: canonicalUrl,
              method: 'GET',
              ...(workerDependencies.has(canonicalUrl) ? { workerContext: true } : {}),
            });
          } else {
            unseenDependencies += 1;
          }
        } catch {
          // Malformed references remain reportable during final localization.
        }
      }

      if (unseenDependencies > 0) {
        reportDiscoveryRoundBoundary(unseenDependencies);
      }
    }

    if (!reachedResourceLimit && deferredRequiredAssets.size > 0) {
      const requiredInputs = prioritizedInputs([...deferredRequiredAssets.values()]);
      const remainingCapacity = Math.max(0, resourceLimit - plan.seenUrls.size);
      const selectedInputs = requiredInputs.slice(0, remainingCapacity);
      reachedResourceLimit = selectedInputs.length < requiredInputs.length;

      if (reachedResourceLimit) {
        reportResourceBoundary(
          'while retaining fonts, WASM, models, and other runtime leaves after the expandable dependency closure',
          requiredInputs.length - selectedInputs.length,
        );
      }

      if (selectedInputs.length > 0) {
        const requiredBatch = appendResources(plan, selectedInputs, sourceUrl.origin);
        notifyPlannedResources(requiredBatch.downloads);
        completedDownloads += requiredBatch.addedResults - requiredBatch.downloads.length;
        await downloadBatch(requiredBatch.downloads);
        securityWarnings.push(
          ...(await scanDownloadedResources(
            options.outputDirectory,
            results,
            options.signal,
            new Set(requiredBatch.downloads.map((download) => download.localPath)),
          )),
        );
      }
    }

    if (!reachedResourceLimit && deferredRenderedAssets.size > 0) {
      const renderedInputs = coalesceRenderedAssetInputs(
        deferredRenderedAssets,
        renditionTargetForCapture(input),
      );
      const remainingCapacity = Math.max(0, resourceLimit - plan.seenUrls.size);
      const selectedInputs = renderedInputs.slice(0, remainingCapacity);
      reachedResourceLimit = selectedInputs.length < renderedInputs.length;

      if (reachedResourceLimit) {
        reportResourceBoundary(
          'while retaining rendered media after the runtime dependency closure',
          renderedInputs.length - selectedInputs.length,
        );
      }

      if (selectedInputs.length > 0) {
        const renderedBatch = appendResources(plan, selectedInputs, sourceUrl.origin);
        notifyPlannedResources(renderedBatch.downloads);
        completedDownloads += renderedBatch.addedResults - renderedBatch.downloads.length;
        await downloadBatch(renderedBatch.downloads);
        securityWarnings.push(
          ...(await scanDownloadedResources(
            options.outputDirectory,
            results,
            options.signal,
            new Set(renderedBatch.downloads.map((download) => download.localPath)),
          )),
        );
      }
    }

    return {
      navigationUrls: [...navigationUrls].sort(),
      reachedResourceLimit,
    };
  };

  const primaryClosure = await downloadDependencyClosure(
    downloadedLocalPaths(initialBatch.downloads),
    false,
    initialCandidates.required,
    initialCandidates.rendered,
    initialCandidates.knownUrls,
  );
  const navigationQueue: string[] = [];
  const queuedNavigationUrls = new Set<string>();
  const excludedNavigationUrls = new Set<string>();
  const enqueueNavigationUrls = (values: readonly string[]): void => {
    for (const value of values) {
      try {
        const canonicalUrl = canonicalizeResourceUrl(value);

        if (!isNavigationWithinSourceScope(sourceUrl, canonicalUrl)) {
          excludedNavigationUrls.add(canonicalUrl);
          continue;
        }

        if (!plan.seenUrls.has(canonicalUrl) && !queuedNavigationUrls.has(canonicalUrl)) {
          queuedNavigationUrls.add(canonicalUrl);
          navigationQueue.push(canonicalUrl);
        }
      } catch {
        // Invalid or unsupported navigation references stay outside the plan.
      }
    }

    navigationQueue.sort();
  };

  if (
    maxDiscoveryRounds > 0 &&
    maxNavigationPages > 0 &&
    !primaryClosure.reachedResourceLimit &&
    options.signal?.aborted !== true
  ) {
    const navigationDiscovery = await discoverResourceDependencies({
      outputDirectory: options.outputDirectory,
      resources: results,
      includeSameOriginNavigation: true,
      sourceOrigin: sourceUrl.origin,
    });
    discoveryWarnings.push(...navigationDiscovery.warnings);
    enqueueNavigationUrls(navigationDiscovery.navigationUrls);
  }

  while (navigationQueue.length > 0 && options.signal?.aborted !== true) {
    if (capturedNavigationPages >= maxNavigationPages) {
      reportNavigationBoundary(navigationQueue.length);
      break;
    }

    if (plan.seenUrls.size >= resourceLimit) {
      reportResourceBoundary(
        'before optional same-origin navigation pages could be retained',
        navigationQueue.length,
      );
      break;
    }

    const navigationUrl = navigationQueue.shift();

    if (!navigationUrl) {
      break;
    }

    queuedNavigationUrls.delete(navigationUrl);

    if (plan.seenUrls.has(navigationUrl)) {
      continue;
    }

    const navigationBatch = appendResources(
      plan,
      [
        {
          sourceUrl: navigationUrl,
          method: 'GET',
          contentType: 'text/html',
        },
      ],
      sourceUrl.origin,
    );
    capturedNavigationPages += navigationBatch.addedResults > 0 ? 1 : 0;
    notifyPlannedResources(navigationBatch.downloads);
    completedDownloads += navigationBatch.addedResults - navigationBatch.downloads.length;
    await downloadBatch(navigationBatch.downloads);
    securityWarnings.push(
      ...(await scanDownloadedResources(
        options.outputDirectory,
        results,
        options.signal,
        new Set(navigationBatch.downloads.map((download) => download.localPath)),
      )),
    );
    const navigationClosure = await downloadDependencyClosure(
      downloadedLocalPaths(navigationBatch.downloads),
      true,
    );
    enqueueNavigationUrls(navigationClosure.navigationUrls);

    if (navigationClosure.reachedResourceLimit) {
      break;
    }
  }

  if (excludedNavigationUrls.size > 0) {
    discoveryWarnings.push(
      `Capability boundary: ${excludedNavigationUrls.size} same-origin linked route(s) outside the active route subtree were not mirrored.`,
    );
  }

  const downloadFinishedAt = now();
  securityWarnings.push(
    ...(await scanDownloadedResources(options.outputDirectory, results, options.signal)),
  );
  await commitCacheCandidates(
    options.cacheDirectory,
    options.outputDirectory,
    results,
    cacheCandidates,
    options.signal,
  );
  const localization = await localizeDownloadedResources({
    outputDirectory: options.outputDirectory,
    resources: results,
    onProgress: (localizedResources, total) => {
      notifyProgress(
        options,
        results,
        completedDownloads,
        undefined,
        'localizing',
        localizedResources,
        total,
      );
    },
  });
  const finishedAt = now();
  const resolvedStatus = mirrorStatus(results);
  const status =
    resolvedStatus === 'complete' &&
    (localization.onlineDependencies.length > 0 ||
      discoveryWarnings.length > 0 ||
      localization.warnings.length > 0 ||
      securityWarnings.length > 0)
      ? 'partial'
      : resolvedStatus;
  const manifest: MirrorManifest = {
    schemaVersion: mirrorManifestVersion,
    source: {
      url: sourceUrl.toString(),
      origin: sourceUrl.origin,
      capturedAt: input.capturedAt ?? startedAt.toISOString(),
      ...(input.title ? { title: input.title } : {}),
    },
    createdAt: finishedAt.toISOString(),
    status,
    ...(input.browser ? { browser: input.browser } : {}),
    ...(input.viewport ? { viewport: input.viewport } : {}),
    ...(input.runtimeCapabilities ? { runtimeCapabilities: input.runtimeCapabilities } : {}),
    summary: summarize(results),
    timings: {
      totalMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      downloadMs: Math.max(0, downloadFinishedAt.getTime() - startedAt.getTime()),
      localizationMs: Math.max(0, finishedAt.getTime() - downloadFinishedAt.getTime()),
    },
    resources: results,
    onlineDependencies: localization.onlineDependencies,
    warnings: [
      ...(input.warnings ?? []),
      ...discoveryWarnings,
      ...localization.warnings,
      ...securityWarnings,
    ],
  };

  redactManifestForStorage(manifest);

  if (options.writeManifest !== false) {
    await writeMirrorManifest(options.outputDirectory, manifest);
  }

  return manifest;
}

export function createMirror(
  input: MirrorCaptureInput,
  options: CreateMirrorOptions,
): Promise<MirrorManifest> {
  return createMirrorWithDownloader(input, options, downloadResource);
}

export function createMirrorForTesting(
  input: MirrorCaptureInput,
  options: CreateMirrorOptions,
): Promise<MirrorManifest> {
  return createMirrorWithDownloader(input, options, downloadResourceForTesting);
}
