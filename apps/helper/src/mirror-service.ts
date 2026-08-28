import { ZipArchive } from 'archiver';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  canonicalizeResourceUrl,
  createAbortError,
  createMirror,
  createMirrorForTesting,
  createPreviewRouteAliases,
  createPreviewUnavailableRoutes,
  isAbortError,
  localizeDownloadedResources,
  previewRouteForSourceUrl,
  resolveDownloadTarget,
  startPreviewServer,
  writeMirrorManifest,
  type CaptureResourceInput,
  type CreateMirrorOptions,
  type MirrorCaptureInput,
  type MirrorManifest,
  type MirrorProgress,
  type MirrorResourceManifest,
  type MirrorStatus,
  type PreviewServer,
} from '@webmirror/mirror';
import {
  nativeMessagingProtocolVersion,
  nativeResourceBodiesMaxBytes,
  nativeResourceBodiesMaxCount,
  nativeResourceBodyChunkBytes,
  nativeResourceBodyMaxBytes,
  redactSensitiveText,
  redactSensitiveUrl,
  type NativeCaptureCompletionReason,
  type NativeHostErrorCode,
  type NativeJobActionRequest,
  type NativeMirrorCancelRequest,
  type NativeMirrorCreateRequest,
  type NativeMirrorResultSummary,
  type NativePostHandshakeRequest,
  type NativeResourceBodyRequest,
  type NativeResourceBodyResult,
} from '@webmirror/shared';
import {
  renderValidationReport,
  runValidation,
  type RunValidationOptions,
  type ValidationResult,
} from '@webmirror/validation';

import type { NativeHostSender } from './native-messaging.js';
import { openExternalTarget } from './open-external.js';

type MirrorCreator = (
  input: MirrorCaptureInput,
  options: CreateMirrorOptions,
) => Promise<MirrorManifest>;

type PreviewStarter = typeof startPreviewServer;
type ValidationRunner = (options: RunValidationOptions) => Promise<ValidationResult>;

const mirrorConcurrency = 8;
const mirrorMaxResourceBytes = 256 * 1024 * 1024;
const mirrorMaxTotalBytes = 512 * 1024 * 1024;
const mirrorMaxDeferredMediaBytes = 128 * 1024 * 1024;
const mirrorTimeoutMs = 60_000;
const mirrorMaxRetries = 1;
const mirrorRetryDelayMs = 200;
const mirrorMaxNavigationPages = 8;
const automaticRetryConcurrency = 2;
const automaticRetryMaxRetries = 3;
const automaticRetryDelayMs = 1_000;
const validationTimeoutMs = 60_000;
const bodyStagingPrefix = 'webmirror-bodies-';
const orphanedBodyStagingTtlMs = 60 * 60_000;
const validationJsonFileName = 'validation.json';
const validationReportFileName = 'report.html';
const maximumNativeOnlineDependencyLength = 8_192;

interface ManagedJob {
  request: NativeMirrorCreateRequest;
  abortController: AbortController;
  outputDirectory: string;
  startedAt: number;
  artifactCommitted?: boolean;
  preview?: PreviewServer;
  reportPreview?: PreviewServer;
  result?: NativeMirrorResultSummary;
  manifest?: MirrorManifest;
  mirrorStatus?: MirrorStatus;
  mirrorOnlineDependencies?: string[];
  mirrorWarnings?: string[];
  retrySourcesByLocalPath: Map<string, CaptureResourceInput>;
}

interface StagedResourceBody {
  jobId: string;
  bodyId: string;
  sourceUrl: string;
  sourceOrigin: string;
  reuseScope: NativeResourceBodyReuseScope;
  filePath: string;
  expectedByteLength: number;
  expectedSha256: string;
  receivedBytes: number;
  hash: Hash;
  fileHandle: FileHandle | undefined;
  complete: boolean;
}

type NativeResourceBodyReuseScope = NonNullable<
  Extract<NativeResourceBodyRequest, { type: 'resource_body_start' }>['reuseScope']
>;

export interface NativeMirrorServiceOptions {
  outputRoot?: string;
  cacheRoot?: string;
  createMirror?: MirrorCreator;
  startPreviewServer?: PreviewStarter;
  runValidation?: ValidationRunner;
  now?: () => Date;
  openExternal?: (target: string) => Promise<void>;
  launchExecutable?: string;
  bodyStagingParent?: string;
  validateCapturedBodySource?: (sourceUrl: string) => Promise<void>;
}

class ResourceBodyTransferError extends Error {
  readonly code: NativeHostErrorCode;

  constructor(code: NativeHostErrorCode, message: string) {
    super(message);
    this.name = 'ResourceBodyTransferError';
    this.code = code;
  }
}

function normalizedBodyReuseScope(value: unknown): NativeResourceBodyReuseScope {
  if (value === undefined || value === 'same_origin') {
    return 'same_origin';
  }

  if (value === 'public_cross_origin') {
    return value;
  }

  throw new ResourceBodyTransferError(
    'RESOURCE_BODY_INVALID',
    'The captured response body reuse scope is invalid.',
  );
}

function assertCapturedBodyScope(
  sourceUrl: string,
  sourceOrigin: string,
  reuseScope: NativeResourceBodyReuseScope,
): void {
  const source = new URL(sourceUrl);

  if (reuseScope === 'same_origin') {
    if (source.origin !== sourceOrigin) {
      throw new ResourceBodyTransferError(
        'RESOURCE_BODY_INVALID',
        'A same-origin captured response body must match the captured page origin.',
      );
    }
    return;
  }

  if (source.protocol !== 'https:' || source.origin === sourceOrigin) {
    throw new ResourceBodyTransferError(
      'RESOURCE_BODY_INVALID',
      'A public cross-origin captured response body must use HTTPS and a different origin.',
    );
  }
}

function defaultOutputRoot(): string {
  const configured = process.env.WEBMIRROR_OUTPUT_ROOT;

  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error('WEBMIRROR_OUTPUT_ROOT must be an absolute path.');
    }

    return resolve(configured);
  }

  return join(homedir(), 'Documents', 'WebMirror');
}

function defaultCacheRoot(): string {
  const configured = process.env.WEBMIRROR_CACHE_ROOT;

  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error('WEBMIRROR_CACHE_ROOT must be an absolute path.');
    }

    return resolve(configured);
  }

  return join(
    process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
    'WebMirror',
    'cache',
    'v1',
  );
}

async function discardPersistedValidationArtifacts(outputDirectory: string): Promise<void> {
  await Promise.allSettled([
    rm(join(outputDirectory, validationJsonFileName), { force: true }),
    rm(join(outputDirectory, validationReportFileName), { force: true }),
  ]);
}

function safePathPart(value: string, fallback: string): string {
  const normalized = value
    .normalize('NFKD')
    .replaceAll(/[^a-zA-Z0-9._-]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, 64);
  return normalized || fallback;
}

function outputDirectoryFor(
  outputRoot: string,
  request: NativeMirrorCreateRequest,
  now: Date,
): string {
  const source = new URL(request.capture.sourceUrl);
  const host = safePathPart(source.hostname, 'site');
  const timestamp = now
    .toISOString()
    .replaceAll(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
  const jobSuffix = safePathPart(request.jobId, 'job').slice(0, 12);
  return join(outputRoot, `${host}-${timestamp}-${jobSuffix}`);
}

function mirrorInput(
  request: NativeMirrorCreateRequest,
  stagedBodies: ReadonlyMap<string, StagedResourceBody> | undefined,
  allowedBodyIds?: ReadonlySet<string>,
): MirrorCaptureInput {
  const referencedBodyIds = new Set<string>();
  const captureOrigin = new URL(request.capture.sourceUrl).origin;

  return {
    sourceUrl: request.capture.sourceUrl,
    capturedAt: request.capture.capturedAt,
    resources: request.capture.resources.map((resource) => {
      if (resource.bodyId && referencedBodyIds.has(resource.bodyId)) {
        throw new ResourceBodyTransferError(
          'RESOURCE_BODY_INVALID',
          `Captured response body ${resource.bodyId} is referenced more than once.`,
        );
      }

      if (resource.bodyId) {
        referencedBodyIds.add(resource.bodyId);
      }

      const stagedBody = resource.bodyId ? stagedBodies?.get(resource.bodyId) : undefined;
      const useStagedBody =
        stagedBody !== undefined &&
        (allowedBodyIds === undefined || allowedBodyIds.has(resource.bodyId ?? ''));

      if (resource.bodyId && (!stagedBody || !stagedBody.complete)) {
        throw new ResourceBodyTransferError(
          'RESOURCE_BODY_NOT_FOUND',
          `Captured response body ${resource.bodyId} is not staged and verified.`,
        );
      }

      if (
        stagedBody &&
        (stagedBody.sourceUrl !== canonicalizeResourceUrl(resource.sourceUrl) ||
          stagedBody.sourceOrigin !== captureOrigin)
      ) {
        throw new ResourceBodyTransferError(
          'RESOURCE_BODY_INVALID',
          `Captured response body ${resource.bodyId} does not match its declared resource source.`,
        );
      }

      if (stagedBody) {
        assertCapturedBodyScope(stagedBody.sourceUrl, captureOrigin, stagedBody.reuseScope);
      }

      return {
        sourceUrl: resource.sourceUrl,
        method: resource.method,
        ...(resource.contentType ? { contentType: resource.contentType } : {}),
        ...(resource.expectedSize !== undefined ? { expectedSize: resource.expectedSize } : {}),
        ...(resource.resourceType ? { resourceType: resource.resourceType } : {}),
        ...(resource.initiatorType ? { initiatorType: resource.initiatorType } : {}),
        ...(resource.workerContext ? { workerContext: true } : {}),
        ...(useStagedBody
          ? {
              capturedBody: {
                filePath: stagedBody.filePath,
                byteLength: stagedBody.expectedByteLength,
                sha256: stagedBody.expectedSha256,
                ...(resource.contentType ? { contentType: resource.contentType } : {}),
                httpStatus: 200,
              },
            }
          : {}),
      };
    }),
    warnings: [...request.capture.warnings],
    ...(request.capture.title ? { title: request.capture.title } : {}),
    ...(request.capture.browser ? { browser: { ...request.capture.browser } } : {}),
    ...(request.capture.viewport ? { viewport: { ...request.capture.viewport } } : {}),
    ...(request.capture.runtimeCapabilities
      ? { runtimeCapabilities: request.capture.runtimeCapabilities }
      : {}),
  };
}

function sourceEntryPath(manifest: MirrorManifest): string | undefined {
  const sourceUrl = canonicalizeResourceUrl(manifest.source.url);
  const exact = manifest.resources.find(
    (resource) =>
      resource.status === 'downloaded' &&
      resource.localPath?.startsWith('site/') &&
      resource.canonicalUrl === sourceUrl,
  );
  const fallback = manifest.resources.find(
    (resource) =>
      resource.status === 'downloaded' &&
      resource.localPath?.startsWith('site/') &&
      resource.contentType?.toLowerCase().startsWith('text/html'),
  );
  return (exact ?? fallback)?.localPath?.slice('site/'.length);
}

function previewEntryUrl(preview: PreviewServer, sourceUrl: string): string {
  return new URL(previewRouteForSourceUrl(sourceUrl), preview.url).toString();
}

function errorDetail(code: NativeHostErrorCode, message: string) {
  return { code, message };
}

function resourceBodyStage(request: NativeResourceBodyRequest): NativeResourceBodyResult['stage'] {
  switch (request.type) {
    case 'resource_body_start':
      return 'start';
    case 'resource_body_chunk':
      return 'chunk';
    case 'resource_body_end':
      return 'end';
  }
}

function decodeStrictBase64(value: string): Buffer {
  if (
    value.length === 0 ||
    value.length > Math.ceil(nativeResourceBodyChunkBytes / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new ResourceBodyTransferError(
      'RESOURCE_BODY_INVALID',
      'The resource body chunk is not valid bounded base64 data.',
    );
  }

  const bytes = Buffer.from(value, 'base64');

  if (bytes.byteLength > nativeResourceBodyChunkBytes || bytes.toString('base64') !== value) {
    throw new ResourceBodyTransferError(
      'RESOURCE_BODY_INVALID',
      'The resource body chunk is not canonical base64 data.',
    );
  }

  return bytes;
}

async function writeAll(fileHandle: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let offset = 0;

  while (offset < bytes.byteLength) {
    const result = await fileHandle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      position + offset,
    );

    if (result.bytesWritten <= 0) {
      throw new Error('The resource body staging file stopped accepting data.');
    }

    offset += result.bytesWritten;
  }
}

function summarizeResources(resources: readonly MirrorResourceManifest[]) {
  return {
    totalResources: resources.length,
    downloadedResources: resources.filter((resource) => resource.status === 'downloaded').length,
    failedResources: resources.filter((resource) => resource.status === 'failed').length,
    skippedResources: resources.filter((resource) => resource.status === 'skipped').length,
    cancelledResources: resources.filter((resource) => resource.status === 'cancelled').length,
    totalBytes: resources.reduce((total, resource) => total + (resource.size ?? 0), 0),
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function resourceStatus(
  resources: readonly MirrorResourceManifest[],
  onlineDependencies: readonly string[],
): MirrorStatus {
  if (resources.some((resource) => resource.status === 'cancelled')) {
    return 'cancelled';
  }

  const downloaded = resources.some((resource) => resource.status === 'downloaded');
  const incomplete =
    onlineDependencies.length > 0 ||
    resources.some(
      (resource) =>
        resource.status === 'failed' ||
        resource.status === 'skipped' ||
        resource.status === 'pending',
    );

  if (!incomplete) {
    return 'complete';
  }

  return downloaded ? 'partial' : 'failed';
}

interface OnlineDependencySanitization {
  dependencies: string[];
  warnings: string[];
}

function sanitizeOnlineDependencies(values: readonly string[]): OnlineDependencySanitization {
  const dependencies = new Set<string>();
  let ignoredCount = 0;

  for (const value of values) {
    if (value.length === 0 || value.length > maximumNativeOnlineDependencyLength) {
      ignoredCount += 1;
      continue;
    }

    try {
      const url = new URL(value);

      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
        ignoredCount += 1;
        continue;
      }

      dependencies.add(url.toString());
    } catch {
      ignoredCount += 1;
    }
  }

  return {
    dependencies: [...dependencies].sort(),
    warnings:
      ignoredCount === 0
        ? []
        : [
            `Ignored ${ignoredCount} malformed online dependency ${
              ignoredCount === 1 ? 'value' : 'values'
            } before sending the Native Messaging result.`,
          ],
  };
}

function captureStatus(reason: NativeCaptureCompletionReason | undefined): MirrorStatus {
  switch (reason) {
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'maximum_duration':
    case 'detached':
      return 'partial';
    case 'network_idle':
    case undefined:
      return 'complete';
    default:
      return 'failed';
  }
}

async function writeLaunchCommand(
  outputDirectory: string,
  launchExecutable: string,
): Promise<void> {
  const executable = launchExecutable.replaceAll('"', '""');
  const script = [
    '@echo off',
    'setlocal',
    `"${executable}" --serve "%~dp0" --open`,
    'if errorlevel 1 pause',
    '',
  ].join('\r\n');
  await writeFile(join(outputDirectory, 'launch.cmd'), script, 'utf8');
}

function createZipArchive(sourceDirectory: string, destinationPath: string): Promise<void> {
  return new Promise((resolveArchive, reject) => {
    const output = createWriteStream(destinationPath, { flags: 'wx' });
    const archive = new ZipArchive({ zlib: { level: 6 } });
    let settled = false;

    const rejectOnce = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    output.once('close', () => {
      if (!settled) {
        settled = true;
        resolveArchive();
      }
    });
    output.once('error', rejectOnce);
    archive.once('error', rejectOnce);
    archive.pipe(output);
    archive.directory(sourceDirectory, false);
    void archive.finalize();
  });
}

async function replaceZip(sourceDirectory: string): Promise<string> {
  const destinationPath = `${sourceDirectory}.zip`;
  const temporaryPath = `${destinationPath}.part-${process.pid}-${Date.now()}`;
  await rm(temporaryPath, { force: true });

  try {
    await createZipArchive(sourceDirectory, temporaryPath);
    await rm(destinationPath, { force: true });
    await rename(temporaryPath, destinationPath);
    return destinationPath;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function defaultLaunchExecutable(): string {
  if (process.env.WEBMIRROR_SEA === '1') {
    return process.execPath;
  }

  return (
    process.env.WEBMIRROR_HELPER_EXECUTABLE ??
    join(process.env.LOCALAPPDATA ?? dirname(process.execPath), 'WebMirror', 'webmirror-helper.exe')
  );
}

export class NativeMirrorService {
  readonly #outputRoot: string;
  readonly #cacheRoot: string;
  readonly #createMirror: MirrorCreator;
  readonly #startPreviewServer: PreviewStarter;
  readonly #runValidation: ValidationRunner;
  readonly #now: () => Date;
  readonly #openExternal: (target: string) => Promise<void>;
  readonly #launchExecutable: string;
  readonly #bodyStagingParent: string;
  readonly #validateCapturedBodySource: (sourceUrl: string) => Promise<void>;
  readonly #jobs = new Map<string, ManagedJob>();
  readonly #stagedBodiesByJob = new Map<string, Map<string, StagedResourceBody>>();
  readonly #cancelledJobs = new Set<string>();
  #activeJobId: string | undefined;
  #stagingJobId: string | undefined;
  #bodyStagingRoot: string | undefined;
  #bodyStagingSweepDone = false;
  #reservedBodyBytes = 0;
  #bodyRequestQueue = Promise.resolve();
  #disposed = false;

  constructor(options: NativeMirrorServiceOptions = {}) {
    this.#outputRoot = resolve(options.outputRoot ?? defaultOutputRoot());
    this.#cacheRoot = resolve(options.cacheRoot ?? defaultCacheRoot());
    this.#createMirror =
      options.createMirror ??
      (process.env.WEBMIRROR_ALLOW_PRIVATE_NETWORK_FOR_TESTS === '1'
        ? createMirrorForTesting
        : createMirror);
    this.#startPreviewServer = options.startPreviewServer ?? startPreviewServer;
    this.#runValidation = options.runValidation ?? runValidation;
    this.#now = options.now ?? (() => new Date());
    this.#openExternal = options.openExternal ?? openExternalTarget;
    this.#bodyStagingParent = resolve(options.bodyStagingParent ?? tmpdir());
    this.#validateCapturedBodySource =
      options.validateCapturedBodySource ??
      (async (sourceUrl) => {
        await resolveDownloadTarget(
          sourceUrl,
          process.env.WEBMIRROR_ALLOW_PRIVATE_NETWORK_FOR_TESTS === '1',
        );
      });
    this.#launchExecutable = options.launchExecutable ?? defaultLaunchExecutable();
  }

  handleRequest(request: NativePostHandshakeRequest, send: NativeHostSender): Promise<void> {
    switch (request.type) {
      case 'resource_body_start':
      case 'resource_body_chunk':
      case 'resource_body_end':
        return this.#queueBodyRequest(request, send);
      case 'mirror_create':
        return this.#bodyRequestQueue.then(() => this.#create(request, send));
      case 'mirror_cancel':
        return this.#bodyRequestQueue.then(() => this.#cancel(request, send));
      case 'job_action':
        return this.#action(request, send);
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;

    for (const job of this.#jobs.values()) {
      job.abortController.abort();
      await job.preview?.close().catch(() => undefined);
      await job.reportPreview?.close().catch(() => undefined);
    }

    await this.#bodyRequestQueue.catch(() => undefined);
    await this.#cleanupStagedBodies();
    this.#jobs.clear();
    this.#cancelledJobs.clear();
    this.#activeJobId = undefined;
  }

  #queueBodyRequest(request: NativeResourceBodyRequest, send: NativeHostSender): Promise<void> {
    const task = this.#bodyRequestQueue.then(() => this.#handleBodyRequest(request, send));
    this.#bodyRequestQueue = task.catch(() => undefined);
    return task;
  }

  async #handleBodyRequest(
    request: NativeResourceBodyRequest,
    send: NativeHostSender,
  ): Promise<void> {
    const stage = resourceBodyStage(request);
    let response: NativeResourceBodyResult;

    try {
      const result = await this.#processBodyRequest(request);
      response = {
        type: 'resource_body_result',
        requestId: request.requestId,
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: request.jobId,
        bodyId: request.bodyId,
        stage,
        accepted: true,
        nextOffset: result.nextOffset,
        complete: result.complete,
        error: null,
      };
    } catch (error) {
      const staged = this.#stagedBodiesByJob.get(request.jobId)?.get(request.bodyId);
      const nextOffset = staged?.receivedBytes ?? 0;

      if (request.type !== 'resource_body_start') {
        await this.#cleanupStagedBody(request.jobId, request.bodyId);
      } else if (!staged) {
        await this.#removeEmptyBodyStagingRoot();
      }

      const normalized =
        error instanceof ResourceBodyTransferError
          ? error
          : new ResourceBodyTransferError(
              'RESOURCE_BODY_INVALID',
              error instanceof Error
                ? error.message
                : 'The captured response body could not be staged.',
            );
      response = {
        type: 'resource_body_result',
        requestId: request.requestId,
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: request.jobId,
        bodyId: request.bodyId,
        stage,
        accepted: false,
        nextOffset,
        complete: false,
        error: errorDetail(normalized.code, normalized.message),
      };
    }

    await send(response);
  }

  async #processBodyRequest(
    request: NativeResourceBodyRequest,
  ): Promise<{ nextOffset: number; complete: boolean }> {
    if (this.#disposed) {
      throw new ResourceBodyTransferError(
        'RESOURCE_BODY_INVALID',
        'The Native Messaging connection is closing.',
      );
    }

    switch (request.type) {
      case 'resource_body_start':
        return this.#startBody(request);
      case 'resource_body_chunk':
        return this.#appendBodyChunk(request);
      case 'resource_body_end':
        return this.#finishBody(request);
    }
  }

  async #startBody(
    request: Extract<NativeResourceBodyRequest, { type: 'resource_body_start' }>,
  ): Promise<{ nextOffset: number; complete: false }> {
    if (this.#cancelledJobs.has(request.jobId)) {
      throw new ResourceBodyTransferError(
        'RESOURCE_BODY_INVALID',
        'The captured response body belongs to a cancelled job.',
      );
    }

    if (this.#activeJobId || (this.#stagingJobId && this.#stagingJobId !== request.jobId)) {
      throw new ResourceBodyTransferError(
        'JOB_ALREADY_RUNNING',
        `Another WebMirror job is already running (${this.#activeJobId ?? this.#stagingJobId}).`,
      );
    }

    if (
      request.byteLength > nativeResourceBodyMaxBytes ||
      this.#reservedBodyBytes + request.byteLength > nativeResourceBodiesMaxBytes
    ) {
      throw new ResourceBodyTransferError(
        'RESOURCE_BODY_LIMIT_EXCEEDED',
        'Captured response bodies exceed the configured per-resource or per-job limit.',
      );
    }

    const sourceUrl = canonicalizeResourceUrl(request.sourceUrl);
    const sourceOriginUrl = new URL(request.sourceOrigin);
    const sourceOrigin = sourceOriginUrl.origin;
    const reuseScope = normalizedBodyReuseScope(request.reuseScope);

    if (
      (sourceOriginUrl.protocol !== 'http:' && sourceOriginUrl.protocol !== 'https:') ||
      sourceOriginUrl.username ||
      sourceOriginUrl.password ||
      sourceOriginUrl.href !== `${sourceOrigin}/`
    ) {
      throw new ResourceBodyTransferError(
        'RESOURCE_BODY_INVALID',
        'The captured response body source origin is invalid.',
      );
    }

    assertCapturedBodyScope(sourceUrl, sourceOrigin, reuseScope);

    try {
      await this.#validateCapturedBodySource(sourceUrl);
    } catch {
      throw new ResourceBodyTransferError(
        'RESOURCE_BODY_INVALID',
        'The captured response body source failed the Helper address policy.',
      );
    }

    const bodies = this.#stagedBodiesByJob.get(request.jobId) ?? new Map();

    if (bodies.has(request.bodyId)) {
      throw new ResourceBodyTransferError(
        'RESOURCE_BODY_INVALID',
        'A captured response body with this id is already staged.',
      );
    }

    if (bodies.size >= nativeResourceBodiesMaxCount) {
      throw new ResourceBodyTransferError(
        'RESOURCE_BODY_LIMIT_EXCEEDED',
        'The captured response body count exceeds the configured per-job limit.',
      );
    }

    const stagingRoot = await this.#ensureBodyStagingRoot();
    const filePath = join(stagingRoot, `${randomUUID()}.body`);
    const fileHandle = await open(filePath, 'wx', 0o600);
    const staged: StagedResourceBody = {
      jobId: request.jobId,
      bodyId: request.bodyId,
      sourceUrl,
      sourceOrigin,
      reuseScope,
      filePath,
      expectedByteLength: request.byteLength,
      expectedSha256: request.sha256,
      receivedBytes: 0,
      hash: createHash('sha256'),
      fileHandle,
      complete: false,
    };
    bodies.set(request.bodyId, staged);
    this.#stagedBodiesByJob.set(request.jobId, bodies);
    this.#stagingJobId = request.jobId;
    this.#reservedBodyBytes += request.byteLength;
    return { nextOffset: 0, complete: false };
  }

  async #appendBodyChunk(
    request: Extract<NativeResourceBodyRequest, { type: 'resource_body_chunk' }>,
  ): Promise<{ nextOffset: number; complete: false }> {
    const staged = this.#requireStagedBody(request.jobId, request.bodyId);

    if (staged.complete || !staged.fileHandle) {
      throw new ResourceBodyTransferError(
        'RESOURCE_BODY_INVALID',
        'The captured response body has already been finalized.',
      );
    }

    if (request.offset !== staged.receivedBytes) {
      throw new ResourceBodyTransferError(
        'RESOURCE_BODY_INVALID',
        `Captured response body offset ${request.offset} does not match ${staged.receivedBytes}.`,
      );
    }

    const bytes = decodeStrictBase64(request.data);

    if (staged.receivedBytes + bytes.byteLength > staged.expectedByteLength) {
      throw new ResourceBodyTransferError(
        'RESOURCE_BODY_INVALID',
        'The captured response body exceeds its declared byte length.',
      );
    }

    await writeAll(staged.fileHandle, bytes, staged.receivedBytes);
    staged.hash.update(bytes);
    staged.receivedBytes += bytes.byteLength;
    return { nextOffset: staged.receivedBytes, complete: false };
  }

  async #finishBody(
    request: Extract<NativeResourceBodyRequest, { type: 'resource_body_end' }>,
  ): Promise<{ nextOffset: number; complete: true }> {
    const staged = this.#requireStagedBody(request.jobId, request.bodyId);

    if (staged.complete || !staged.fileHandle) {
      throw new ResourceBodyTransferError(
        'RESOURCE_BODY_INVALID',
        'The captured response body has already been finalized.',
      );
    }

    if (
      request.byteLength !== staged.expectedByteLength ||
      request.sha256 !== staged.expectedSha256 ||
      staged.receivedBytes !== staged.expectedByteLength
    ) {
      throw new ResourceBodyTransferError(
        'RESOURCE_BODY_INVALID',
        'The captured response body length or digest declaration is inconsistent.',
      );
    }

    await staged.fileHandle.close();
    staged.fileHandle = undefined;
    const actualSha256 = staged.hash.digest('hex');

    if (actualSha256 !== staged.expectedSha256) {
      throw new ResourceBodyTransferError(
        'RESOURCE_BODY_HASH_MISMATCH',
        'The captured response body failed SHA-256 verification.',
      );
    }

    staged.complete = true;
    return { nextOffset: staged.receivedBytes, complete: true };
  }

  #requireStagedBody(jobId: string, bodyId: string): StagedResourceBody {
    const staged = this.#stagedBodiesByJob.get(jobId)?.get(bodyId);

    if (!staged) {
      throw new ResourceBodyTransferError(
        'RESOURCE_BODY_NOT_FOUND',
        'The captured response body was not started for this job.',
      );
    }

    return staged;
  }

  async #ensureBodyStagingRoot(): Promise<string> {
    if (this.#bodyStagingRoot) {
      return this.#bodyStagingRoot;
    }

    await mkdir(this.#bodyStagingParent, { recursive: true, mode: 0o700 });

    if (!this.#bodyStagingSweepDone) {
      this.#bodyStagingSweepDone = true;
      await this.#cleanupOrphanedBodyStagingRoots();
    }

    this.#bodyStagingRoot = await mkdtemp(join(this.#bodyStagingParent, bodyStagingPrefix));
    return this.#bodyStagingRoot;
  }

  async #cleanupOrphanedBodyStagingRoots(): Promise<void> {
    const now = Date.now();
    const entries = await readdir(this.#bodyStagingParent, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(bodyStagingPrefix)) {
        continue;
      }

      const candidate = join(this.#bodyStagingParent, entry.name);

      try {
        const metadata = await stat(candidate);

        if (now - metadata.mtimeMs >= orphanedBodyStagingTtlMs) {
          await rm(candidate, { recursive: true, force: true });
        }
      } catch {
        // A concurrent Helper or operating-system cleanup may remove the candidate first.
      }
    }
  }

  async #cleanupStagedBody(jobId: string, bodyId: string): Promise<void> {
    const bodies = this.#stagedBodiesByJob.get(jobId);
    const staged = bodies?.get(bodyId);

    if (!bodies || !staged) {
      return;
    }

    bodies.delete(bodyId);
    this.#reservedBodyBytes = Math.max(0, this.#reservedBodyBytes - staged.expectedByteLength);
    await staged.fileHandle?.close().catch(() => undefined);
    staged.fileHandle = undefined;
    await rm(staged.filePath, { force: true }).catch(() => undefined);

    if (bodies.size === 0) {
      this.#stagedBodiesByJob.delete(jobId);

      if (this.#stagingJobId === jobId) {
        this.#stagingJobId = undefined;
      }
    }

    await this.#removeEmptyBodyStagingRoot();
  }

  async #cleanupStagedBodies(jobId?: string): Promise<void> {
    const jobs = jobId
      ? [[jobId, this.#stagedBodiesByJob.get(jobId)] as const]
      : [...this.#stagedBodiesByJob.entries()];

    for (const [stagedJobId, bodies] of jobs) {
      if (!bodies) {
        continue;
      }

      for (const staged of bodies.values()) {
        await staged.fileHandle?.close().catch(() => undefined);
        staged.fileHandle = undefined;
        await rm(staged.filePath, { force: true }).catch(() => undefined);
        this.#reservedBodyBytes = Math.max(0, this.#reservedBodyBytes - staged.expectedByteLength);
      }

      this.#stagedBodiesByJob.delete(stagedJobId);

      if (this.#stagingJobId === stagedJobId) {
        this.#stagingJobId = undefined;
      }
    }

    await this.#removeEmptyBodyStagingRoot();
  }

  async #removeEmptyBodyStagingRoot(): Promise<void> {
    if (this.#stagedBodiesByJob.size > 0 || !this.#bodyStagingRoot) {
      return;
    }

    const stagingRoot = this.#bodyStagingRoot;
    this.#bodyStagingRoot = undefined;
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  async #allowedCapturedBodyIds(
    request: NativeMirrorCreateRequest,
  ): Promise<{ allowed: Set<string>; skipped: number }> {
    const allowed = new Set<string>();
    const sourceOrigin = new URL(request.capture.sourceUrl).origin;
    const stagedBodies = this.#stagedBodiesByJob.get(request.jobId);
    let skipped = 0;

    for (const resource of request.capture.resources) {
      if (!resource.bodyId) {
        continue;
      }

      const stagedBody = stagedBodies?.get(resource.bodyId);

      if (!stagedBody || !stagedBody.complete) {
        throw new ResourceBodyTransferError(
          'RESOURCE_BODY_NOT_FOUND',
          `Captured response body ${resource.bodyId} is not staged and verified.`,
        );
      }

      const sourceUrl = canonicalizeResourceUrl(resource.sourceUrl);

      if (stagedBody.sourceUrl !== sourceUrl || stagedBody.sourceOrigin !== sourceOrigin) {
        throw new ResourceBodyTransferError(
          'RESOURCE_BODY_INVALID',
          `Captured response body ${resource.bodyId} does not match its declared resource source.`,
        );
      }

      assertCapturedBodyScope(sourceUrl, sourceOrigin, stagedBody.reuseScope);

      try {
        await this.#validateCapturedBodySource(sourceUrl);
        allowed.add(resource.bodyId);
      } catch {
        skipped += 1;
      }
    }

    return { allowed, skipped };
  }

  async #create(request: NativeMirrorCreateRequest, send: NativeHostSender): Promise<void> {
    if (this.#cancelledJobs.has(request.jobId)) {
      await this.#cleanupStagedBodies(request.jobId);
      await send({
        type: 'mirror_result',
        requestId: request.requestId,
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: request.jobId,
        success: false,
        result: null,
        error: errorDetail('JOB_NOT_FOUND', 'The mirror job was already cancelled.'),
      });
      return;
    }

    if (this.#activeJobId || (this.#stagingJobId && this.#stagingJobId !== request.jobId)) {
      await send({
        type: 'mirror_result',
        requestId: request.requestId,
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: request.jobId,
        success: false,
        result: null,
        error: errorDetail(
          'JOB_ALREADY_RUNNING',
          `Another WebMirror job is already running (${this.#activeJobId ?? this.#stagingJobId}).`,
        ),
      });
      return;
    }

    const now = this.#now();
    const outputDirectory = outputDirectoryFor(this.#outputRoot, request, now);
    const job: ManagedJob = {
      request,
      abortController: new AbortController(),
      outputDirectory,
      startedAt: now.getTime(),
      retrySourcesByLocalPath: new Map(),
    };
    this.#jobs.set(request.jobId, job);
    this.#activeJobId = request.jobId;

    const progress = async (
      state: 'downloading' | 'localizing' | 'starting_preview' | 'fast_validating' | 'ready',
      message: string,
      snapshot?: MirrorProgress,
    ): Promise<void> => {
      await send({
        type: 'mirror_progress',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: request.jobId,
        state,
        discoveredResources: snapshot?.totalResources ?? request.capture.resources.length,
        completedResources: snapshot?.completedResources ?? 0,
        downloadedBytes: snapshot?.downloadedBytes ?? 0,
        warningCount:
          request.capture.warnings.length +
          (snapshot?.failedResources ?? 0) +
          (snapshot?.skippedResources ?? 0),
        elapsedMs: Math.max(0, this.#now().getTime() - job.startedAt),
        message,
      });
    };

    try {
      await mkdir(this.#outputRoot, { recursive: true });
      await mkdir(outputDirectory, { recursive: false });
      await progress('downloading', 'Downloading discovered resources.');
      const bodyPolicy = await this.#allowedCapturedBodyIds(request);
      const captureInput = mirrorInput(
        request,
        this.#stagedBodiesByJob.get(request.jobId),
        bodyPolicy.allowed,
      );

      if (bodyPolicy.skipped > 0) {
        captureInput.warnings = [
          ...(captureInput.warnings ?? []),
          `${bodyPolicy.skipped} captured response body or bodies were not reused because the resource failed the Helper address policy.`,
        ];
      }

      let lastProgressWrite = Promise.resolve();
      const manifest = await this.#createMirror(captureInput, {
        outputDirectory,
        cacheDirectory: this.#cacheRoot,
        signal: job.abortController.signal,
        concurrency: mirrorConcurrency,
        maxResourceBytes: mirrorMaxResourceBytes,
        maxTotalBytes: mirrorMaxTotalBytes,
        maxDeferredMediaBytes: mirrorMaxDeferredMediaBytes,
        maxNavigationPages: mirrorMaxNavigationPages,
        timeoutMs: mirrorTimeoutMs,
        maxRetries: mirrorMaxRetries,
        retryDelayMs: mirrorRetryDelayMs,
        onProgress: (snapshot) => {
          const state = snapshot.phase === 'localizing' ? 'localizing' : 'downloading';
          const message =
            snapshot.phase === 'localizing'
              ? `Localized ${snapshot.localizedResources} of ${snapshot.totalTextResources} text resources.`
              : `Downloaded ${snapshot.downloadedResources} of ${snapshot.totalResources} resources.`;
          lastProgressWrite = progress(state, message, snapshot);
        },
        onResourcePlanned: (resource) => {
          job.retrySourcesByLocalPath.set(resource.localPath, {
            sourceUrl: resource.sourceUrl,
            ...(resource.method ? { method: resource.method } : {}),
            ...(resource.contentType ? { contentType: resource.contentType } : {}),
            ...(resource.expectedSize !== undefined ? { expectedSize: resource.expectedSize } : {}),
            ...(resource.resourceType ? { resourceType: resource.resourceType } : {}),
            ...(resource.initiatorType ? { initiatorType: resource.initiatorType } : {}),
            ...(resource.workerContext ? { workerContext: true } : {}),
          });
        },
      });
      job.manifest = manifest;
      job.mirrorStatus = manifest.status;
      job.artifactCommitted =
        manifest.status !== 'cancelled' && sourceEntryPath(manifest) !== undefined;
      await this.#cleanupStagedBodies(request.jobId);
      const initialOnlineDependencies = sanitizeOnlineDependencies(manifest.onlineDependencies);
      manifest.onlineDependencies = initialOnlineDependencies.dependencies;
      manifest.warnings = [...manifest.warnings, ...initialOnlineDependencies.warnings];
      job.mirrorOnlineDependencies = [...manifest.onlineDependencies];
      job.mirrorWarnings = [...manifest.warnings];

      const retryableFailures = manifest.resources.filter(
        (resource) => resource.status === 'failed' && resource.retryable === true,
      );

      if (retryableFailures.length > 0) {
        await progress(
          'downloading',
          `Retrying ${retryableFailures.length} transient network failure(s) with reduced concurrency.`,
        );

        try {
          const retried = await this.#retryResources(job, retryableFailures, {
            concurrency: automaticRetryConcurrency,
            maxRetries: automaticRetryMaxRetries,
            retryDelayMs: automaticRetryDelayMs,
            onProgress: (snapshot) => {
              lastProgressWrite = progress(
                'downloading',
                `Retry pass processed ${snapshot.completedResources} of ${snapshot.totalResources} transient resource(s).`,
                snapshot,
              );
            },
          });

          job.mirrorWarnings = uniqueStrings([
            ...(job.mirrorWarnings ?? []),
            `Automatically recovered ${retried.recoveredResources} of ${retryableFailures.length} transient network failure(s) with reduced concurrency.`,
          ]);
          manifest.warnings = [...job.mirrorWarnings];
        } catch (error) {
          if (isAbortError(error) || job.abortController.signal.aborted) {
            throw createAbortError();
          }

          const message = error instanceof Error ? error.message : 'Unknown automatic retry error';
          job.mirrorWarnings = uniqueStrings([
            ...(job.mirrorWarnings ?? []),
            `Automatic transient-resource retry could not finish: ${redactSensitiveText(message)}`,
          ]);
          manifest.warnings = [...job.mirrorWarnings];
        }
      }

      await writeMirrorManifest(outputDirectory, manifest);
      await lastProgressWrite;

      if (
        manifest.status === 'cancelled' ||
        (job.abortController.signal.aborted && !job.artifactCommitted)
      ) {
        const cancelledResult: NativeMirrorResultSummary = {
          status: 'cancelled',
          outputDirectory,
          manifestPath: join(outputDirectory, 'mirror.json'),
          totalResources: manifest.summary.totalResources,
          downloadedResources: manifest.summary.downloadedResources,
          failedResources:
            manifest.summary.failedResources +
            manifest.summary.skippedResources +
            manifest.summary.cancelledResources,
          downloadedBytes: manifest.summary.totalBytes,
          warningCount: manifest.warnings.length,
          elapsedMs: Math.max(0, this.#now().getTime() - job.startedAt),
          onlineDependencies: manifest.onlineDependencies,
        };
        job.result = cancelledResult;
        await send({
          type: 'mirror_result',
          requestId: request.requestId,
          protocolVersion: nativeMessagingProtocolVersion,
          jobId: request.jobId,
          success: true,
          result: cancelledResult,
          error: null,
        });
        return;
      }

      if (job.abortController.signal.aborted) {
        throw createAbortError();
      }

      await progress('localizing', 'Finalizing localized resource paths.');
      const entryPath = sourceEntryPath(manifest);

      if (!entryPath) {
        throw new Error('The captured page entry document was not downloaded.');
      }

      await progress('starting_preview', 'Starting the loopback preview server.');
      const preview = await this.#startPreviewServer({
        rootDirectory: join(outputDirectory, 'site'),
        manifest,
        fallbackPath: entryPath,
        routeAliases: createPreviewRouteAliases(manifest),
        unavailableRoutes: createPreviewUnavailableRoutes(manifest),
      });
      job.preview = preview;
      const entryUrl = previewEntryUrl(preview, manifest.source.url);
      await writeLaunchCommand(outputDirectory, this.#launchExecutable);
      await progress('fast_validating', 'Validating the local mirror.');
      const result = await this.#validateJob(job, entryUrl);

      try {
        await progress('ready', 'The local mirror is ready.');
      } catch {
        // Validation and its durable result are already complete. Continue with the final result
        // instead of allowing a progress-channel failure to downgrade the saved artifact.
      }

      if (job.abortController.signal.aborted || this.#activeJobId !== request.jobId) {
        throw createAbortError();
      }

      this.#activeJobId = undefined;
      await send({
        type: 'mirror_result',
        requestId: request.requestId,
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: request.jobId,
        success: true,
        result,
        error: null,
      });
    } catch (error) {
      const cancelled = isAbortError(error) || job.abortController.signal.aborted;
      const failureMessage = error instanceof Error ? error.message : 'The mirror job failed.';

      if (!cancelled && job.result) {
        return;
      }

      if (cancelled) {
        const completedAt = this.#now();

        if (job.artifactCommitted && job.manifest) {
          if (job.result) {
            await send({
              type: 'mirror_result',
              requestId: request.requestId,
              protocolVersion: nativeMessagingProtocolVersion,
              jobId: request.jobId,
              success: true,
              result: job.result,
              error: null,
            });
            return;
          }

          await discardPersistedValidationArtifacts(job.outputDirectory);
          const manifest = job.manifest;
          manifest.summary = summarizeResources(manifest.resources);
          manifest.status = 'partial';
          manifest.warnings = uniqueStrings([
            ...(job.mirrorWarnings ?? manifest.warnings),
            'The mirror artifact was preserved, but validation was interrupted before it completed.',
          ]);
          job.mirrorStatus = 'partial';
          job.mirrorWarnings = [...manifest.warnings];
          await writeMirrorManifest(job.outputDirectory, manifest);
          const entryPath = sourceEntryPath(manifest);
          const entryUrl =
            job.preview && entryPath
              ? previewEntryUrl(job.preview, manifest.source.url)
              : undefined;
          const preservedResult: NativeMirrorResultSummary = {
            status: 'partial',
            outputDirectory: job.outputDirectory,
            ...(job.preview ? { previewUrl: job.preview.url } : {}),
            ...(entryUrl ? { entryUrl } : {}),
            manifestPath: join(job.outputDirectory, 'mirror.json'),
            totalResources: manifest.summary.totalResources,
            downloadedResources: manifest.summary.downloadedResources,
            failedResources:
              manifest.summary.failedResources +
              manifest.summary.skippedResources +
              manifest.summary.cancelledResources,
            downloadedBytes: manifest.summary.totalBytes,
            warningCount: manifest.warnings.length,
            elapsedMs: Math.max(0, completedAt.getTime() - job.startedAt),
            onlineDependencies: manifest.onlineDependencies,
          };
          job.result = preservedResult;
          await send({
            type: 'mirror_result',
            requestId: request.requestId,
            protocolVersion: nativeMessagingProtocolVersion,
            jobId: request.jobId,
            success: true,
            result: preservedResult,
            error: null,
          });
          return;
        }

        await discardPersistedValidationArtifacts(job.outputDirectory);
        const manifest =
          job.manifest ??
          ({
            schemaVersion: 1,
            source: {
              url: redactSensitiveUrl(request.capture.sourceUrl),
              origin: new URL(request.capture.sourceUrl).origin,
              capturedAt: request.capture.capturedAt,
              ...(request.capture.title ? { title: request.capture.title } : {}),
            },
            createdAt: completedAt.toISOString(),
            status: 'cancelled',
            ...(request.capture.browser ? { browser: { ...request.capture.browser } } : {}),
            ...(request.capture.viewport ? { viewport: { ...request.capture.viewport } } : {}),
            ...(request.capture.runtimeCapabilities
              ? { runtimeCapabilities: request.capture.runtimeCapabilities }
              : {}),
            summary: {
              totalResources: request.capture.resources.length,
              downloadedResources: 0,
              failedResources: 0,
              skippedResources: 0,
              cancelledResources: request.capture.resources.length,
              totalBytes: 0,
            },
            timings: {
              totalMs: Math.max(0, completedAt.getTime() - job.startedAt),
              downloadMs: 0,
              localizationMs: 0,
            },
            resources: request.capture.resources.map((resource) => ({
              sourceUrl: redactSensitiveUrl(resource.sourceUrl),
              canonicalUrl: redactSensitiveUrl(canonicalizeResourceUrl(resource.sourceUrl)),
              status: 'cancelled',
              error: 'Download cancelled',
            })),
            onlineDependencies: [],
            warnings: [],
          } satisfies MirrorManifest);
        manifest.status = 'cancelled';
        manifest.summary = summarizeResources(manifest.resources);
        manifest.warnings = [
          ...(job.mirrorWarnings ?? manifest.warnings),
          'The WebMirror job was cancelled.',
        ];
        job.manifest = manifest;
        await writeMirrorManifest(job.outputDirectory, manifest);
        const entryPath = sourceEntryPath(manifest);
        const entryUrl =
          job.preview && entryPath ? previewEntryUrl(job.preview, manifest.source.url) : undefined;
        const cancelledResult: NativeMirrorResultSummary = {
          status: 'cancelled',
          outputDirectory: job.outputDirectory,
          ...(job.preview ? { previewUrl: job.preview.url } : {}),
          ...(entryUrl ? { entryUrl } : {}),
          manifestPath: join(job.outputDirectory, 'mirror.json'),
          totalResources: manifest.summary.totalResources,
          downloadedResources: manifest.summary.downloadedResources,
          failedResources:
            manifest.summary.failedResources +
            manifest.summary.skippedResources +
            manifest.summary.cancelledResources,
          downloadedBytes: manifest.summary.totalBytes,
          warningCount: manifest.warnings.length,
          elapsedMs: Math.max(0, completedAt.getTime() - job.startedAt),
          onlineDependencies: manifest.onlineDependencies,
        };
        job.result = cancelledResult;
        await send({
          type: 'mirror_result',
          requestId: request.requestId,
          protocolVersion: nativeMessagingProtocolVersion,
          jobId: request.jobId,
          success: true,
          result: cancelledResult,
          error: null,
        });
        return;
      }

      if (job.manifest) {
        job.manifest.status = 'failed';
        job.manifest.warnings = [
          ...(job.mirrorWarnings ?? job.manifest.warnings),
          redactSensitiveText(failureMessage),
        ];
        await writeMirrorManifest(job.outputDirectory, job.manifest).catch(() => undefined);
      }

      await send({
        type: 'mirror_result',
        requestId: request.requestId,
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: request.jobId,
        success: false,
        result: null,
        error: errorDetail('MIRROR_FAILED', failureMessage),
      });
    } finally {
      await this.#cleanupStagedBodies(request.jobId);

      if (this.#activeJobId === request.jobId) {
        this.#activeJobId = undefined;
      }
    }
  }

  async #cancel(request: NativeMirrorCancelRequest, send: NativeHostSender): Promise<void> {
    const job = this.#jobs.get(request.jobId);
    const staged = this.#stagedBodiesByJob.has(request.jobId);
    const accepted = Boolean((job && this.#activeJobId === request.jobId) || staged);

    if (job && this.#activeJobId === request.jobId) {
      this.#cancelledJobs.add(request.jobId);
      job.abortController.abort();
    } else if (staged) {
      this.#cancelledJobs.add(request.jobId);
      await this.#cleanupStagedBodies(request.jobId);
    }

    await send({
      type: 'mirror_cancel_result',
      requestId: request.requestId,
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: request.jobId,
      accepted,
      error: accepted ? null : errorDetail('JOB_NOT_FOUND', 'The active mirror job was not found.'),
    });
  }

  async #validateJob(job: ManagedJob, entryUrl: string): Promise<NativeMirrorResultSummary> {
    const manifest = job.manifest;

    if (!manifest || !job.preview) {
      throw new Error('The mirror is not ready for validation.');
    }

    const validation = await this.#runValidation({
      entryUrl,
      outputDirectory: job.outputDirectory,
      sourceUrl: job.request.capture.sourceUrl,
      signal: job.abortController.signal,
      timeoutMs: validationTimeoutMs,
      settleTimeMs: 2_000,
      canvasSettleTimeoutMs: 10_000,
      ...(job.request.capture.browser ? { browser: { ...job.request.capture.browser } } : {}),
      ...(job.request.capture.runtimeCapabilities
        ? { runtimeCapabilities: job.request.capture.runtimeCapabilities }
        : {}),
      ...(job.request.capture.viewport
        ? {
            viewport: {
              width: job.request.capture.viewport.width,
              height: job.request.capture.viewport.height,
              deviceScaleFactor: job.request.capture.viewport.deviceScaleFactor,
            },
          }
        : {}),
    });
    const throwIfCancelled = async (): Promise<void> => {
      if (!job.abortController.signal.aborted) {
        return;
      }

      await discardPersistedValidationArtifacts(job.outputDirectory);
      throw createAbortError();
    };
    await throwIfCancelled();
    const calculatedMirrorStatus = resourceStatus(
      manifest.resources,
      job.mirrorOnlineDependencies ?? manifest.onlineDependencies,
    );
    const mirrorStatus =
      job.mirrorStatus === 'cancelled' || calculatedMirrorStatus === 'cancelled'
        ? 'cancelled'
        : job.mirrorStatus === 'failed' || calculatedMirrorStatus === 'failed'
          ? 'failed'
          : job.mirrorStatus === 'partial' || calculatedMirrorStatus === 'partial'
            ? 'partial'
            : 'complete';
    const capturedStatus = captureStatus(job.request.capture.completionReason);
    const finalStatus =
      capturedStatus === 'cancelled'
        ? 'cancelled'
        : validation.status === 'failed' || mirrorStatus === 'failed' || capturedStatus === 'failed'
          ? 'failed'
          : mirrorStatus === 'partial' ||
              validation.status === 'partial' ||
              capturedStatus === 'partial'
            ? 'partial'
            : 'complete';
    const onlineDependencySanitization = sanitizeOnlineDependencies([
      ...(job.mirrorOnlineDependencies ?? manifest.onlineDependencies),
    ]);
    const onlineDependencies = onlineDependencySanitization.dependencies;
    const persistentMirrorWarnings = [
      ...(job.mirrorWarnings ?? manifest.warnings),
      ...onlineDependencySanitization.warnings,
    ];
    manifest.summary = summarizeResources(manifest.resources);
    manifest.status = finalStatus;
    manifest.onlineDependencies = onlineDependencies;
    manifest.warnings = [...persistentMirrorWarnings, ...validation.warnings, ...validation.errors];
    job.mirrorOnlineDependencies = [...onlineDependencies];
    job.mirrorWarnings = persistentMirrorWarnings;
    await writeMirrorManifest(job.outputDirectory, manifest);
    await throwIfCancelled();
    validation.status = finalStatus === 'cancelled' ? 'failed' : finalStatus;
    validation.score =
      validation.status === 'complete'
        ? validation.score
        : validation.status === 'partial'
          ? Math.min(99, validation.score)
          : Math.min(59, validation.score);
    validation.warnings = [...persistentMirrorWarnings, ...validation.warnings];
    await writeFile(
      join(job.outputDirectory, validation.artifacts.validationJson),
      `${JSON.stringify(validation, null, 2)}\n`,
      'utf8',
    );
    await throwIfCancelled();
    await writeFile(
      join(job.outputDirectory, validation.artifacts.reportHtml),
      renderValidationReport(validation),
      'utf8',
    );
    await throwIfCancelled();

    if (!job.reportPreview) {
      job.reportPreview = await this.#startPreviewServer({
        rootDirectory: job.outputDirectory,
      });
      await throwIfCancelled();
    }

    const reportUrl = new URL(validation.artifacts.reportHtml, job.reportPreview.url).toString();
    const result: NativeMirrorResultSummary = {
      status: finalStatus,
      outputDirectory: job.outputDirectory,
      previewUrl: job.preview.url,
      entryUrl,
      manifestPath: join(job.outputDirectory, 'mirror.json'),
      validationPath: join(job.outputDirectory, validation.artifacts.validationJson),
      reportUrl,
      ...(job.result?.zipPath ? { zipPath: job.result.zipPath } : {}),
      totalResources: manifest.summary.totalResources,
      downloadedResources: manifest.summary.downloadedResources,
      failedResources: manifest.summary.failedResources + manifest.summary.skippedResources,
      downloadedBytes: manifest.summary.totalBytes,
      warningCount:
        manifest.warnings.length +
        manifest.summary.failedResources +
        manifest.summary.skippedResources,
      elapsedMs: Math.max(0, this.#now().getTime() - job.startedAt),
      completenessScore:
        finalStatus === 'complete'
          ? 100
          : finalStatus === 'partial'
            ? Math.min(99, validation.score)
            : Math.min(59, validation.score),
      onlineDependencies,
    };
    job.result = result;
    return result;
  }

  #retryInputsForResources(
    job: ManagedJob,
    failedResources: readonly MirrorResourceManifest[],
  ): CaptureResourceInput[] {
    const failedUrls = new Set(
      failedResources.flatMap((resource) => [
        redactSensitiveUrl(resource.sourceUrl),
        redactSensitiveUrl(resource.canonicalUrl),
      ]),
    );
    const retryInputsByUrl = new Map<string, CaptureResourceInput>();

    for (const resource of failedResources) {
      const retrySource = resource.localPath
        ? job.retrySourcesByLocalPath.get(resource.localPath)
        : undefined;

      if (retrySource) {
        retryInputsByUrl.set(retrySource.sourceUrl, retrySource);
      }
    }

    for (const resource of job.request.capture.resources) {
      if (failedUrls.has(redactSensitiveUrl(resource.sourceUrl))) {
        retryInputsByUrl.set(resource.sourceUrl, resource);
      }
    }

    return [...retryInputsByUrl.values()];
  }

  async #retryResources(
    job: ManagedJob,
    failedResources: readonly MirrorResourceManifest[],
    options: {
      concurrency: number;
      maxRetries: number;
      retryDelayMs: number;
      onProgress?: (snapshot: MirrorProgress) => void;
    },
  ): Promise<{ recoveredResources: number }> {
    const manifest = job.manifest;

    if (!manifest) {
      throw new Error('The mirror is not ready for resource retry.');
    }

    if (failedResources.length === 0) {
      throw new Error('This mirror does not have retryable failed resources.');
    }

    const retryInputs = this.#retryInputsForResources(job, failedResources);

    if (retryInputs.length === 0) {
      throw new Error('The failed resources no longer have a safe retry source.');
    }

    const remainingBytes = mirrorMaxTotalBytes - manifest.summary.totalBytes;

    if (remainingBytes <= 0) {
      throw new Error(
        'No remaining mirror byte budget is available for retrying failed resources.',
      );
    }

    const retryRequest: NativeMirrorCreateRequest = {
      ...job.request,
      capture: {
        ...job.request.capture,
        resources: job.request.capture.resources.map(
          ({ bodyId: _bodyId, ...resource }) => resource,
        ),
      },
    };
    const input = mirrorInput(retryRequest, undefined);
    const retryManifest = await this.#createMirror(
      {
        ...input,
        resources: retryInputs,
      },
      {
        outputDirectory: job.outputDirectory,
        cacheDirectory: this.#cacheRoot,
        signal: job.abortController.signal,
        concurrency: options.concurrency,
        maxResourceBytes: mirrorMaxResourceBytes,
        maxTotalBytes: remainingBytes,
        timeoutMs: mirrorTimeoutMs,
        maxRetries: options.maxRetries,
        retryDelayMs: options.retryDelayMs,
        maxDiscoveryRounds: 0,
        writeManifest: false,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        onResourcePlanned: (resource) => {
          job.retrySourcesByLocalPath.set(resource.localPath, {
            sourceUrl: resource.sourceUrl,
            ...(resource.method ? { method: resource.method } : {}),
            ...(resource.contentType ? { contentType: resource.contentType } : {}),
            ...(resource.expectedSize !== undefined ? { expectedSize: resource.expectedSize } : {}),
            ...(resource.resourceType ? { resourceType: resource.resourceType } : {}),
            ...(resource.initiatorType ? { initiatorType: resource.initiatorType } : {}),
            ...(resource.workerContext ? { workerContext: true } : {}),
          });
        },
      },
    );
    const retriedLocalPaths = new Set<string>();
    let recoveredResources = 0;

    for (const retried of retryManifest.resources) {
      const index = manifest.resources.findIndex(
        (resource) =>
          (retried.localPath && resource.localPath === retried.localPath) ||
          resource.canonicalUrl === retried.canonicalUrl,
      );

      if (index < 0) {
        continue;
      }

      manifest.resources[index] = retried;

      if (retried.status === 'downloaded' && retried.localPath) {
        retriedLocalPaths.add(retried.localPath);
        recoveredResources += 1;
      }
    }

    const localization = await localizeDownloadedResources({
      outputDirectory: job.outputDirectory,
      resources: manifest.resources,
    });
    const successfulUrls = new Set(
      manifest.resources
        .filter(
          (resource) =>
            resource.status === 'downloaded' && retriedLocalPaths.has(resource.localPath ?? ''),
        )
        .flatMap((resource) => [
          redactSensitiveUrl(resource.sourceUrl),
          redactSensitiveUrl(resource.canonicalUrl),
        ]),
    );
    const baseOnlineDependencies = (
      job.mirrorOnlineDependencies ?? manifest.onlineDependencies
    ).filter((dependency) => !successfulUrls.has(redactSensitiveUrl(dependency)));
    const onlineDependencySanitization = sanitizeOnlineDependencies([
      ...baseOnlineDependencies,
      ...retryManifest.onlineDependencies,
      ...localization.onlineDependencies,
    ]);
    job.mirrorOnlineDependencies = onlineDependencySanitization.dependencies;
    job.mirrorWarnings = uniqueStrings([
      ...(job.mirrorWarnings ?? []),
      ...retryManifest.warnings,
      ...localization.warnings,
      ...onlineDependencySanitization.warnings,
    ]);
    manifest.summary = summarizeResources(manifest.resources);
    manifest.onlineDependencies = [...job.mirrorOnlineDependencies];
    manifest.warnings = [...job.mirrorWarnings];
    manifest.status = resourceStatus(manifest.resources, manifest.onlineDependencies);
    job.mirrorStatus = manifest.status;
    await writeMirrorManifest(job.outputDirectory, manifest);
    return { recoveredResources };
  }

  async #retryFailedResources(job: ManagedJob): Promise<NativeMirrorResultSummary> {
    const manifest = job.manifest;
    const entryUrl = job.result?.entryUrl;

    if (!manifest || !entryUrl) {
      throw new Error('The mirror is not ready for resource retry.');
    }

    const failedResources = manifest.resources.filter(
      (resource) => resource.status === 'failed' && resource.localPath,
    );

    await this.#retryResources(job, failedResources, {
      concurrency: mirrorConcurrency,
      maxRetries: mirrorMaxRetries,
      retryDelayMs: mirrorRetryDelayMs,
    });
    return this.#validateJob(job, entryUrl);
  }

  async #action(request: NativeJobActionRequest, send: NativeHostSender): Promise<void> {
    const job = this.#jobs.get(request.jobId);

    if (!job?.result) {
      await send({
        type: 'job_action_result',
        requestId: request.requestId,
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: request.jobId,
        action: request.action,
        success: false,
        error: errorDetail('JOB_NOT_FOUND', 'The completed mirror job was not found.'),
      });
      return;
    }

    const longRunning = request.action === 'retry_failed' || request.action === 'revalidate';

    if (longRunning && this.#activeJobId) {
      await send({
        type: 'job_action_result',
        requestId: request.requestId,
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: request.jobId,
        action: request.action,
        success: false,
        error: errorDetail(
          'JOB_ALREADY_RUNNING',
          `Another WebMirror operation is already running (${this.#activeJobId}).`,
        ),
      });
      return;
    }

    if (longRunning) {
      this.#activeJobId = request.jobId;
    }

    try {
      switch (request.action) {
        case 'open_preview': {
          if (!job.result.entryUrl) {
            throw new Error('This job does not have a preview URL.');
          }

          await this.#openExternal(job.result.entryUrl);
          await this.#sendActionSuccess(request, send, { url: job.result.entryUrl });
          return;
        }
        case 'open_output':
          try {
            const output = await stat(job.outputDirectory);

            if (!output.isDirectory()) {
              throw new Error('The mirror output path is no longer a directory.');
            }
          } catch (error) {
            if (
              error instanceof Error &&
              'code' in error &&
              (error as NodeJS.ErrnoException).code === 'ENOENT'
            ) {
              throw new Error(
                'The mirror output directory no longer exists. Create the mirror again.',
                { cause: error },
              );
            }

            throw error;
          }

          await this.#openExternal(job.outputDirectory);
          await this.#sendActionSuccess(request, send, { path: job.outputDirectory });
          return;
        case 'open_report': {
          if (!job.result.reportUrl) {
            throw new Error('This job does not have a validation report yet.');
          }

          await this.#openExternal(job.result.reportUrl);
          await this.#sendActionSuccess(request, send, { url: job.result.reportUrl });
          return;
        }
        case 'export_zip': {
          if (job.manifest?.resources.some((resource) => resource.securityIssue)) {
            throw new Error('ZIP export is disabled because sensitive content was quarantined.');
          }

          const zipPath = await replaceZip(job.outputDirectory);
          job.result.zipPath = zipPath;
          await this.#sendActionSuccess(request, send, { path: zipPath });
          return;
        }
        case 'retry_failed': {
          await this.#sendActionProgress(job, send, 'downloading', 'Retrying failed resources.');
          const result = await this.#retryFailedResources(job);
          await this.#sendActionProgress(
            job,
            send,
            'ready',
            'Failed resources were retried and validated.',
          );
          await this.#sendActionSuccess(request, send, {
            ...(result.reportUrl ? { url: result.reportUrl } : {}),
            result,
          });
          return;
        }
        case 'revalidate': {
          if (!job.result.entryUrl) {
            throw new Error('This job does not have a preview entry URL.');
          }

          await this.#sendActionProgress(
            job,
            send,
            'fast_validating',
            'Revalidating the local mirror.',
          );
          const result = await this.#validateJob(job, job.result.entryUrl);
          await this.#sendActionProgress(job, send, 'ready', 'The local mirror was revalidated.');
          await this.#sendActionSuccess(request, send, {
            ...(result.reportUrl ? { url: result.reportUrl } : {}),
            result,
          });
          return;
        }
      }
    } catch (error) {
      await send({
        type: 'job_action_result',
        requestId: request.requestId,
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: request.jobId,
        action: request.action,
        success: false,
        error: errorDetail(
          'INVALID_ACTION',
          error instanceof Error ? error.message : 'The requested action failed.',
        ),
      });
    } finally {
      if (longRunning && this.#activeJobId === request.jobId) {
        this.#activeJobId = undefined;
      }
    }
  }

  async #sendActionProgress(
    job: ManagedJob,
    send: NativeHostSender,
    state: 'downloading' | 'fast_validating' | 'ready',
    message: string,
  ): Promise<void> {
    const summary = job.manifest?.summary;
    await send({
      type: 'mirror_progress',
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: job.request.jobId,
      state,
      discoveredResources: summary?.totalResources ?? job.request.capture.resources.length,
      completedResources:
        (summary?.downloadedResources ?? 0) +
        (summary?.failedResources ?? 0) +
        (summary?.skippedResources ?? 0),
      downloadedBytes: summary?.totalBytes ?? 0,
      warningCount: job.result?.warningCount ?? 0,
      elapsedMs: Math.max(0, this.#now().getTime() - job.startedAt),
      message,
    });
  }

  async #sendActionSuccess(
    request: NativeJobActionRequest,
    send: NativeHostSender,
    result: {
      path?: string;
      url?: string;
      result?: NativeMirrorResultSummary;
    },
  ): Promise<void> {
    await send({
      type: 'job_action_result',
      requestId: request.requestId,
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: request.jobId,
      action: request.action,
      success: true,
      ...result,
      error: null,
    });
  }
}

export function outputNameForTesting(
  outputRoot: string,
  request: NativeMirrorCreateRequest,
  now: Date,
): string {
  return basename(outputDirectoryFor(outputRoot, request, now));
}
