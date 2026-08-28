import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isNativeHostResponse,
  nativeMessagingProtocolVersion,
  type NativeHostResponse,
  type NativeMirrorCreateRequest,
} from '@webmirror/shared';
import type {
  CreateMirrorOptions,
  MirrorCaptureInput,
  MirrorManifest,
  PreviewServerOptions,
} from '@webmirror/mirror';
import type { RunValidationOptions, ValidationResult } from '@webmirror/validation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NativeMirrorService, outputNameForTesting } from './mirror-service.js';

function createRequest(jobId = 'job-123'): NativeMirrorCreateRequest {
  return {
    type: 'mirror_create',
    requestId: 'request-create',
    protocolVersion: nativeMessagingProtocolVersion,
    jobId,
    capture: {
      sourceUrl: 'https://example.com/',
      title: 'Example',
      capturedAt: '2026-01-01T00:00:00.000Z',
      completionReason: 'network_idle',
      resources: [
        {
          sourceUrl: 'https://example.com/',
          method: 'GET',
          contentType: 'text/html',
        },
      ],
      warnings: [],
    },
  };
}

function createRetryRequest(jobId: string): NativeMirrorCreateRequest {
  const request = createRequest(jobId);
  request.capture.resources = [
    {
      sourceUrl: request.capture.sourceUrl,
      method: 'GET',
      contentType: 'text/html',
    },
    {
      sourceUrl: 'https://example.com/transient.bin',
      method: 'GET',
      contentType: 'application/octet-stream',
    },
  ];
  return request;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function stageResponseBody(
  service: NativeMirrorService,
  send: (message: NativeHostResponse) => Promise<void>,
  input: {
    jobId: string;
    bodyId: string;
    sourceUrl: string;
    sourceOrigin: string;
    reuseScope?: 'same_origin' | 'public_cross_origin';
    body: Buffer;
  },
): Promise<void> {
  const digest = sha256(input.body);
  await service.handleRequest(
    {
      type: 'resource_body_start',
      requestId: `${input.bodyId}-start`,
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: input.jobId,
      bodyId: input.bodyId,
      sourceUrl: input.sourceUrl,
      sourceOrigin: input.sourceOrigin,
      ...(input.reuseScope ? { reuseScope: input.reuseScope } : {}),
      byteLength: input.body.byteLength,
      sha256: digest,
    },
    send,
  );
  await service.handleRequest(
    {
      type: 'resource_body_chunk',
      requestId: `${input.bodyId}-chunk`,
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: input.jobId,
      bodyId: input.bodyId,
      offset: 0,
      data: input.body.toString('base64'),
    },
    send,
  );
  await service.handleRequest(
    {
      type: 'resource_body_end',
      requestId: `${input.bodyId}-end`,
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: input.jobId,
      bodyId: input.bodyId,
      byteLength: input.body.byteLength,
      sha256: digest,
    },
    send,
  );
}

function successfulValidation(entryUrl: string): ValidationResult {
  return {
    schemaVersion: 2 as const,
    status: 'complete' as const,
    score: 100,
    startedAt: '2026-01-02T03:04:05.000Z',
    completedAt: '2026-01-02T03:04:06.000Z',
    durationMs: 1_000,
    entry: {
      requestedUrl: entryUrl,
      ok: true,
      finalUrl: entryUrl,
      httpStatus: 200,
      contentType: 'text/html',
    },
    checks: {
      http: { passed: true, failures: [], local404s: [] },
      runtime: {
        passed: true,
        pageErrors: [],
        consoleErrors: [],
        blockingConsoleErrors: [],
      },
      remoteDependencies: { passed: true, dependencies: [] },
      diagnostics: {
        passed: true,
        truncated: false,
        estimatedRecordedEventBytes: 0,
        eventByteBudget: 65_536,
        droppedEvents: 0,
        categories: {
          httpFailures: { recorded: 0, dropped: 0, droppedBlocking: 0, eventLimit: 64 },
          consoleErrors: { recorded: 0, dropped: 0, droppedBlocking: 0, eventLimit: 64 },
          pageErrors: { recorded: 0, dropped: 0, droppedBlocking: 0, eventLimit: 64 },
          remoteDependencies: {
            recorded: 0,
            dropped: 0,
            droppedBlocking: 0,
            eventLimit: 64,
          },
        },
      },
      screenshot: { passed: true, path: 'screenshots/validation-first-view.png' },
      canvas: {
        checked: true,
        present: false,
        passed: true,
        truncated: false,
        omitted: 0,
        inspected: 0,
        nonEmpty: 0,
        empty: 0,
        unreadable: 0,
        details: [],
      },
      interactions: {
        checked: false,
        passed: true,
        attempted: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
        actions: [],
        errors: [],
      },
      perceptual: {
        checked: false,
        passed: true,
        compared: 0,
        matched: 0,
        partial: 0,
        mismatched: 0,
        errors: 0,
        checkpoints: [],
      },
    },
    errors: [],
    warnings: [],
    artifacts: {
      validationJson: 'validation.json',
      reportHtml: 'report.html',
      screenshot: 'screenshots/validation-first-view.png',
    },
  };
}

async function createCompleteMirror(
  input: MirrorCaptureInput,
  options: CreateMirrorOptions,
): Promise<MirrorManifest> {
  await mkdir(join(options.outputDirectory, 'site'), { recursive: true });
  await writeFile(join(options.outputDirectory, 'site', 'index.html'), '<h1>Mirror</h1>');
  const manifest: MirrorManifest = {
    schemaVersion: 1,
    source: {
      url: input.sourceUrl,
      origin: new URL(input.sourceUrl).origin,
      capturedAt: input.capturedAt ?? '2026-01-01T00:00:00.000Z',
    },
    createdAt: '2026-01-02T03:04:05.000Z',
    status: 'complete',
    summary: {
      totalResources: 1,
      downloadedResources: 1,
      failedResources: 0,
      skippedResources: 0,
      cancelledResources: 0,
      totalBytes: 15,
    },
    timings: { totalMs: 10, downloadMs: 8, localizationMs: 2 },
    resources: [
      {
        sourceUrl: input.sourceUrl,
        canonicalUrl: input.sourceUrl,
        status: 'downloaded',
        localPath: 'site/index.html',
        contentType: 'text/html',
        size: 15,
      },
    ],
    onlineDependencies: [],
    warnings: [],
  };
  await writeFile(join(options.outputDirectory, 'mirror.json'), JSON.stringify(manifest), 'utf8');
  return manifest;
}

async function createRetryFixtureMirror(
  input: MirrorCaptureInput,
  options: CreateMirrorOptions,
  state: 'initial' | 'recovered',
  totalBytes = 15,
): Promise<MirrorManifest> {
  const entryBody = Buffer.from('<h1>Mirror</h1>', 'utf8');
  const entryUrl = input.sourceUrl;
  const transientUrl =
    input.resources.find((resource) => resource.sourceUrl !== entryUrl)?.sourceUrl ??
    `${entryUrl}transient.bin`;
  const transientBody = Buffer.from('recovered', 'utf8');
  const includesEntry = input.resources.some((resource) => resource.sourceUrl === entryUrl);

  options.onProgress?.({
    phase: 'downloading',
    totalResources: input.resources.length,
    completedResources: input.resources.length,
    downloadedResources: state === 'recovered' ? input.resources.length : includesEntry ? 1 : 0,
    failedResources: state === 'initial' ? 1 : 0,
    skippedResources: 0,
    cancelledResources: 0,
    downloadedBytes: totalBytes,
    localizedResources: 0,
    totalTextResources: 0,
    currentUrl: transientUrl,
  });

  await mkdir(join(options.outputDirectory, 'site'), { recursive: true });
  await writeFile(join(options.outputDirectory, 'site', 'index.html'), entryBody);

  const resources: MirrorManifest['resources'] = includesEntry
    ? [
        {
          sourceUrl: entryUrl,
          canonicalUrl: entryUrl,
          status: 'downloaded',
          localPath: 'site/index.html',
          contentType: 'text/html',
          size: entryBody.byteLength,
          sha256: sha256(entryBody),
        },
      ]
    : [];

  if (state === 'initial') {
    resources.push({
      sourceUrl: transientUrl,
      canonicalUrl: transientUrl,
      status: 'failed',
      localPath: 'site/transient.bin',
      contentType: 'application/octet-stream',
      retryable: true,
      error: 'Download failed with HTTP 503',
    });
  } else {
    await writeFile(join(options.outputDirectory, 'site', 'transient.bin'), transientBody);
    resources.push({
      sourceUrl: transientUrl,
      canonicalUrl: transientUrl,
      status: 'downloaded',
      localPath: 'site/transient.bin',
      contentType: 'application/octet-stream',
      size: transientBody.byteLength,
      sha256: sha256(transientBody),
    });
  }

  const manifest: MirrorManifest = {
    schemaVersion: 1,
    source: {
      url: entryUrl,
      origin: new URL(entryUrl).origin,
      capturedAt: input.capturedAt ?? '2026-01-01T00:00:00.000Z',
    },
    createdAt: '2026-01-02T03:04:05.000Z',
    status: state === 'initial' ? 'partial' : 'complete',
    summary: {
      totalResources: resources.length,
      downloadedResources: resources.filter((resource) => resource.status === 'downloaded').length,
      failedResources: resources.filter((resource) => resource.status === 'failed').length,
      skippedResources: 0,
      cancelledResources: 0,
      totalBytes,
    },
    timings: { totalMs: 10, downloadMs: 8, localizationMs: 2 },
    resources,
    onlineDependencies: [],
    warnings: [],
  };
  await writeFile(join(options.outputDirectory, 'mirror.json'), JSON.stringify(manifest), 'utf8');
  return manifest;
}

function rejectWhenAborted(signal: AbortSignal | undefined, message: string): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => {
      const error = new Error(message);
      error.name = 'AbortError';
      reject(error);
    };

    if (signal?.aborted) {
      rejectAbort();
    } else {
      signal?.addEventListener('abort', rejectAbort, { once: true });
    }
  });
}

describe('NativeMirrorService', () => {
  let outputRoot: string;
  let bodyStagingParent: string;

  beforeEach(async () => {
    outputRoot = await mkdtemp(join(tmpdir(), 'webmirror-service-'));
    bodyStagingParent = await mkdtemp(join(tmpdir(), 'webmirror-body-staging-'));
  });

  afterEach(async () => {
    await rm(outputRoot, { recursive: true, force: true });
    await rm(bodyStagingParent, { recursive: true, force: true });
  });

  it('propagates browser runtime evidence into the mirror input without private request data', async () => {
    const request = createRequest('runtime-evidence-job');
    request.capture.resources = [
      {
        sourceUrl: 'https://example.com/runtime.js',
        method: 'GET',
        contentType: 'application/javascript',
        expectedSize: 128,
        resourceType: 'Script',
        initiatorType: 'parser',
        workerContext: true,
      },
    ];
    let observedInput: MirrorCaptureInput | undefined;
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: async (input, options) => {
        observedInput = input;
        return createCompleteMirror(input, options);
      },
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43136,
        url: 'http://127.0.0.1:43136/',
        close: async () => undefined,
      }),
      runValidation: async (options) => successfulValidation(options.entryUrl),
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });

    await service.handleRequest(request, async () => undefined);

    expect(observedInput?.resources).toEqual([
      {
        sourceUrl: 'https://example.com/runtime.js',
        method: 'GET',
        contentType: 'application/javascript',
        expectedSize: 128,
        resourceType: 'Script',
        initiatorType: 'parser',
        workerContext: true,
      },
    ]);
    expect(JSON.stringify(observedInput)).not.toContain('headers');
    expect(JSON.stringify(observedInput)).not.toContain('cookie');
    expect(JSON.stringify(observedInput)).not.toContain('authorization');
    await service.dispose();
  });

  it('stages, verifies, consumes, and cleans a browser response body', async () => {
    const body = Buffer.from('<!doctype html><title>Captured</title>', 'utf8');
    const digest = sha256(body);
    const messages: NativeHostResponse[] = [];
    let observedBody = Buffer.alloc(0);
    let observedMirrorOptions: CreateMirrorOptions | undefined;
    const service = new NativeMirrorService({
      outputRoot,
      bodyStagingParent,
      validateCapturedBodySource: async () => undefined,
      createMirror: async (input, options) => {
        observedMirrorOptions = options;
        const capturedBody = input.resources[0]?.capturedBody;

        if (!capturedBody) {
          throw new Error('Expected a staged captured response body.');
        }

        observedBody = await readFile(capturedBody.filePath);
        return createCompleteMirror(input, options);
      },
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43130,
        url: 'http://127.0.0.1:43130/',
        close: async () => undefined,
      }),
      runValidation: async (options) => successfulValidation(options.entryUrl),
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });
    const send = async (message: NativeHostResponse) => {
      messages.push(message);
    };
    await service.handleRequest(
      {
        type: 'resource_body_start',
        requestId: 'body-start',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'body-job',
        bodyId: 'body-1',
        sourceUrl: 'https://example.com/',
        sourceOrigin: 'https://example.com/',
        byteLength: body.byteLength,
        sha256: digest,
      },
      send,
    );
    await service.handleRequest(
      {
        type: 'resource_body_chunk',
        requestId: 'body-chunk',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'body-job',
        bodyId: 'body-1',
        offset: 0,
        data: body.toString('base64'),
      },
      send,
    );
    await service.handleRequest(
      {
        type: 'resource_body_end',
        requestId: 'body-end',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'body-job',
        bodyId: 'body-1',
        byteLength: body.byteLength,
        sha256: digest,
      },
      send,
    );
    const request = createRequest('body-job');
    request.capture.resources = [
      {
        ...request.capture.resources[0]!,
        expectedSize: body.byteLength,
        bodyId: 'body-1',
      },
    ];
    await service.handleRequest(request, send);

    expect(observedBody).toEqual(body);
    expect(observedMirrorOptions).toMatchObject({
      concurrency: 8,
      maxResourceBytes: 256 * 1024 * 1024,
      maxTotalBytes: 512 * 1024 * 1024,
      timeoutMs: 60_000,
      maxRetries: 1,
      retryDelayMs: 200,
    });
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'resource_body_result',
          stage: 'end',
          accepted: true,
          complete: true,
        }),
        expect.objectContaining({
          type: 'mirror_result',
          success: true,
        }),
      ]),
    );
    await expect(readdir(bodyStagingParent)).resolves.toEqual([]);
    await service.dispose();
  });

  it('reuses an address-policy-approved public HTTPS cross-origin body', async () => {
    const body = Buffer.from('public cross-origin static body', 'utf8');
    let capturedBodyWasExposed = false;
    let observedBody = Buffer.alloc(0);
    const validatedSources: string[] = [];
    const service = new NativeMirrorService({
      outputRoot,
      bodyStagingParent,
      validateCapturedBodySource: async (sourceUrl) => {
        validatedSources.push(sourceUrl);
      },
      createMirror: async (input, options) => {
        const publicResource = input.resources.find(
          (resource) => resource.sourceUrl === 'https://cdn.example.net/public.js',
        );
        capturedBodyWasExposed = publicResource?.capturedBody !== undefined;

        if (publicResource?.capturedBody) {
          observedBody = await readFile(publicResource.capturedBody.filePath);
        }

        expect(publicResource).not.toHaveProperty('headers');
        return createCompleteMirror(input, options);
      },
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43131,
        url: 'http://127.0.0.1:43131/',
        close: async () => undefined,
      }),
      runValidation: async (options) => successfulValidation(options.entryUrl),
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });
    const messages: NativeHostResponse[] = [];
    const send = async (message: NativeHostResponse) => {
      messages.push(message);
    };

    await stageResponseBody(service, send, {
      jobId: 'public-cross-origin-job',
      bodyId: 'public-cross-origin-body',
      sourceUrl: 'https://cdn.example.net/public.js',
      sourceOrigin: 'https://example.com/',
      reuseScope: 'public_cross_origin',
      body,
    });
    const request = createRequest('public-cross-origin-job');
    request.capture.resources = [
      {
        sourceUrl: 'https://cdn.example.net/public.js',
        method: 'GET',
        contentType: 'application/javascript',
        expectedSize: body.byteLength,
        bodyId: 'public-cross-origin-body',
      },
    ];
    await service.handleRequest(request, send);

    expect(capturedBodyWasExposed).toBe(true);
    expect(observedBody).toEqual(body);
    expect(validatedSources).toEqual([
      'https://cdn.example.net/public.js',
      'https://cdn.example.net/public.js',
    ]);
    expect(messages.at(-1)).toMatchObject({
      type: 'mirror_result',
      success: true,
    });
    await expect(readdir(bodyStagingParent)).resolves.toEqual([]);
    await service.dispose();
  });

  it('falls back to normal downloading if the Helper address policy changes before creation', async () => {
    const body = Buffer.from('public body with a changing address decision', 'utf8');
    const messages: NativeHostResponse[] = [];
    let validationCount = 0;
    let capturedBodyWasExposed = false;
    let mirrorWarnings: readonly string[] = [];
    const service = new NativeMirrorService({
      outputRoot,
      bodyStagingParent,
      validateCapturedBodySource: async () => {
        validationCount += 1;

        if (validationCount > 1) {
          throw new Error('The address policy changed.');
        }
      },
      createMirror: async (input, options) => {
        capturedBodyWasExposed = input.resources.some(
          (resource) => resource.capturedBody !== undefined,
        );
        mirrorWarnings = input.warnings ?? [];
        return createCompleteMirror(input, options);
      },
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43132,
        url: 'http://127.0.0.1:43132/',
        close: async () => undefined,
      }),
      runValidation: async (options) => successfulValidation(options.entryUrl),
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });
    const send = async (message: NativeHostResponse) => {
      messages.push(message);
    };
    await stageResponseBody(service, send, {
      jobId: 'address-policy-fallback-job',
      bodyId: 'address-policy-fallback-body',
      sourceUrl: 'https://cdn.example.net/public.js',
      sourceOrigin: 'https://example.com/',
      reuseScope: 'public_cross_origin',
      body,
    });
    const request = createRequest('address-policy-fallback-job');
    request.capture.resources = [
      {
        sourceUrl: 'https://cdn.example.net/public.js',
        method: 'GET',
        contentType: 'application/javascript',
        expectedSize: body.byteLength,
        bodyId: 'address-policy-fallback-body',
      },
    ];

    await service.handleRequest(request, send);

    expect(capturedBodyWasExposed).toBe(false);
    expect(mirrorWarnings.join(' ')).toContain('failed the Helper address policy');
    expect(messages.at(-1)).toMatchObject({
      type: 'mirror_result',
      success: true,
    });
    await expect(readdir(bodyStagingParent)).resolves.toEqual([]);
    await service.dispose();
  });

  it('rejects invalid public body scope relationships and address-policy failures before staging', async () => {
    const body = Buffer.from('rejected body', 'utf8');
    const messages: NativeHostResponse[] = [];
    const createMirror = vi.fn(createCompleteMirror);
    const service = new NativeMirrorService({
      outputRoot,
      bodyStagingParent,
      validateCapturedBodySource: async (sourceUrl) => {
        if (sourceUrl.includes('blocked.example.net')) {
          throw new Error('Rejected by the address policy.');
        }
      },
      createMirror,
    });
    const send = async (message: NativeHostResponse) => {
      messages.push(message);
    };
    const invalidStarts = [
      {
        bodyId: 'public-http',
        sourceUrl: 'http://cdn.example.net/public.js',
        sourceOrigin: 'https://example.com/',
        reuseScope: 'public_cross_origin' as const,
      },
      {
        bodyId: 'public-same-origin',
        sourceUrl: 'https://example.com/public.js',
        sourceOrigin: 'https://example.com/',
        reuseScope: 'public_cross_origin' as const,
      },
      {
        bodyId: 'same-origin-spoof',
        sourceUrl: 'https://cdn.example.net/public.js',
        sourceOrigin: 'https://example.com/',
        reuseScope: 'same_origin' as const,
      },
      {
        bodyId: 'blocked-public',
        sourceUrl: 'https://blocked.example.net/public.js',
        sourceOrigin: 'https://example.com/',
        reuseScope: 'public_cross_origin' as const,
      },
    ];

    for (const input of invalidStarts) {
      await service.handleRequest(
        {
          type: 'resource_body_start',
          requestId: `${input.bodyId}-start`,
          protocolVersion: nativeMessagingProtocolVersion,
          jobId: 'invalid-public-job',
          bodyId: input.bodyId,
          sourceUrl: input.sourceUrl,
          sourceOrigin: input.sourceOrigin,
          reuseScope: input.reuseScope,
          byteLength: body.byteLength,
          sha256: sha256(body),
        },
        send,
      );
    }

    expect(messages).toHaveLength(invalidStarts.length);
    expect(messages).toEqual(
      invalidStarts.map((input) =>
        expect.objectContaining({
          type: 'resource_body_result',
          bodyId: input.bodyId,
          accepted: false,
          error: expect.objectContaining({
            code: 'RESOURCE_BODY_INVALID',
          }),
        }),
      ),
    );
    expect(createMirror).not.toHaveBeenCalled();
    await expect(readdir(bodyStagingParent)).resolves.toEqual([]);
    await service.dispose();
  });

  it('rejects a public body when mirror creation binds its id to another source URL', async () => {
    const body = Buffer.from('bound public body', 'utf8');
    const messages: NativeHostResponse[] = [];
    const createMirror = vi.fn(createCompleteMirror);
    const service = new NativeMirrorService({
      outputRoot,
      bodyStagingParent,
      validateCapturedBodySource: async () => undefined,
      createMirror,
    });
    const send = async (message: NativeHostResponse) => {
      messages.push(message);
    };
    await stageResponseBody(service, send, {
      jobId: 'binding-job',
      bodyId: 'binding-body',
      sourceUrl: 'https://cdn.example.net/original.js',
      sourceOrigin: 'https://example.com/',
      reuseScope: 'public_cross_origin',
      body,
    });
    const request = createRequest('binding-job');
    request.capture.resources = [
      {
        sourceUrl: 'https://cdn.example.net/substituted.js',
        method: 'GET',
        contentType: 'application/javascript',
        expectedSize: body.byteLength,
        bodyId: 'binding-body',
      },
    ];

    await service.handleRequest(request, send);

    expect(createMirror).not.toHaveBeenCalled();
    expect(messages.at(-1)).toMatchObject({
      type: 'mirror_result',
      success: false,
      error: {
        code: 'MIRROR_FAILED',
        message: expect.stringContaining('does not match'),
      },
    });
    await expect(readdir(bodyStagingParent)).resolves.toEqual([]);
    await service.dispose();
  });

  it('removes stale response-body staging directories before creating a new one', async () => {
    const orphan = join(bodyStagingParent, 'webmirror-bodies-orphan');
    await mkdir(orphan);
    await writeFile(join(orphan, 'private.body'), 'stale private body');
    const oldTimestamp = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(orphan, oldTimestamp, oldTimestamp);
    const body = Buffer.from('new body', 'utf8');
    const service = new NativeMirrorService({
      outputRoot,
      bodyStagingParent,
      validateCapturedBodySource: async () => undefined,
    });

    await service.handleRequest(
      {
        type: 'resource_body_start',
        requestId: 'sweep-start',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'sweep-job',
        bodyId: 'sweep-body',
        sourceUrl: 'https://example.com/sweep.bin',
        sourceOrigin: 'https://example.com/',
        byteLength: body.byteLength,
        sha256: sha256(body),
      },
      async () => undefined,
    );

    expect(await readdir(bodyStagingParent)).not.toContain('webmirror-bodies-orphan');
    await service.dispose();
    await expect(readdir(bodyStagingParent)).resolves.toEqual([]);
  });

  it('rejects a bad offset or digest and removes the partial body', async () => {
    const body = Buffer.from('captured body', 'utf8');
    const service = new NativeMirrorService({
      outputRoot,
      bodyStagingParent,
      validateCapturedBodySource: async () => undefined,
    });
    const messages: NativeHostResponse[] = [];
    const send = async (message: NativeHostResponse) => {
      messages.push(message);
    };
    await service.handleRequest(
      {
        type: 'resource_body_start',
        requestId: 'offset-start',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'offset-job',
        bodyId: 'body-offset',
        sourceUrl: 'https://example.com/offset.bin',
        sourceOrigin: 'https://example.com/',
        byteLength: body.byteLength,
        sha256: sha256(body),
      },
      send,
    );
    await service.handleRequest(
      {
        type: 'resource_body_chunk',
        requestId: 'offset-chunk',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'offset-job',
        bodyId: 'body-offset',
        offset: 1,
        data: body.toString('base64'),
      },
      send,
    );
    expect(messages.at(-1)).toMatchObject({
      type: 'resource_body_result',
      accepted: false,
      error: {
        code: 'RESOURCE_BODY_INVALID',
      },
    });
    await expect(readdir(bodyStagingParent)).resolves.toEqual([]);

    const wrongDigest = '0'.repeat(64);
    await service.handleRequest(
      {
        type: 'resource_body_start',
        requestId: 'hash-start',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'hash-job',
        bodyId: 'body-hash',
        sourceUrl: 'https://example.com/hash.bin',
        sourceOrigin: 'https://example.com/',
        byteLength: body.byteLength,
        sha256: wrongDigest,
      },
      send,
    );
    await service.handleRequest(
      {
        type: 'resource_body_chunk',
        requestId: 'hash-chunk',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'hash-job',
        bodyId: 'body-hash',
        offset: 0,
        data: body.toString('base64'),
      },
      send,
    );
    await service.handleRequest(
      {
        type: 'resource_body_end',
        requestId: 'hash-end',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'hash-job',
        bodyId: 'body-hash',
        byteLength: body.byteLength,
        sha256: wrongDigest,
      },
      send,
    );
    expect(messages.at(-1)).toMatchObject({
      type: 'resource_body_result',
      accepted: false,
      error: {
        code: 'RESOURCE_BODY_HASH_MISMATCH',
      },
    });
    await expect(readdir(bodyStagingParent)).resolves.toEqual([]);
    await service.dispose();
  });

  it('cleans an uploaded partial body on cancellation and disconnect', async () => {
    const body = Buffer.from('partial body', 'utf8');
    const service = new NativeMirrorService({
      outputRoot,
      bodyStagingParent,
      validateCapturedBodySource: async () => undefined,
    });
    const messages: NativeHostResponse[] = [];
    const send = async (message: NativeHostResponse) => {
      messages.push(message);
    };
    await service.handleRequest(
      {
        type: 'resource_body_start',
        requestId: 'cancel-start',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'cancel-body-job',
        bodyId: 'body-cancel',
        sourceUrl: 'https://example.com/cancel.bin',
        sourceOrigin: 'https://example.com/',
        byteLength: body.byteLength,
        sha256: sha256(body),
      },
      send,
    );
    await service.handleRequest(
      {
        type: 'mirror_cancel',
        requestId: 'cancel-body',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'cancel-body-job',
      },
      send,
    );
    expect(messages.at(-1)).toMatchObject({
      type: 'mirror_cancel_result',
      accepted: true,
    });
    await expect(readdir(bodyStagingParent)).resolves.toEqual([]);
    await service.handleRequest(
      {
        type: 'resource_body_start',
        requestId: 'cancelled-restart',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'cancel-body-job',
        bodyId: 'body-after-cancel',
        sourceUrl: 'https://example.com/after-cancel.bin',
        sourceOrigin: 'https://example.com/',
        byteLength: body.byteLength,
        sha256: sha256(body),
      },
      send,
    );
    expect(messages.at(-1)).toMatchObject({
      type: 'resource_body_result',
      accepted: false,
      error: {
        code: 'RESOURCE_BODY_INVALID',
      },
    });

    await service.handleRequest(
      {
        type: 'resource_body_start',
        requestId: 'disconnect-start',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'disconnect-body-job',
        bodyId: 'body-disconnect',
        sourceUrl: 'https://example.com/disconnect.bin',
        sourceOrigin: 'https://example.com/',
        byteLength: body.byteLength,
        sha256: sha256(body),
      },
      send,
    );
    expect((await readdir(bodyStagingParent)).length).toBe(1);
    await service.dispose();
    await expect(readdir(bodyStagingParent)).resolves.toEqual([]);
  });

  it('creates a mirror, starts its preview, and returns a correlated result', async () => {
    const messages: NativeHostResponse[] = [];
    const opened: string[] = [];
    const previewOptions: PreviewServerOptions[] = [];
    const baseRequest = createRequest();
    const request: NativeMirrorCreateRequest = {
      ...baseRequest,
      capture: {
        ...baseRequest.capture,
        sourceUrl: 'https://example.com/editions/winter2026?locale=en-US#features',
        resources: [
          {
            sourceUrl: 'https://example.com/editions/winter2026?locale=en-US',
            method: 'GET',
            contentType: 'text/html',
          },
        ],
      },
    };
    const service = new NativeMirrorService({
      outputRoot,
      now: () => new Date('2026-01-02T03:04:05.000Z'),
      createMirror: async (input, options) => {
        await mkdir(join(options.outputDirectory, 'site'), { recursive: true });
        await writeFile(join(options.outputDirectory, 'site', 'index.html'), '<h1>Mirror</h1>');
        options.onProgress?.({
          phase: 'downloading',
          totalResources: 1,
          completedResources: 1,
          downloadedResources: 1,
          failedResources: 0,
          skippedResources: 0,
          cancelledResources: 0,
          downloadedBytes: 15,
          localizedResources: 0,
          totalTextResources: 0,
          currentUrl: input.sourceUrl,
        });
        const manifest = {
          schemaVersion: 1 as const,
          source: {
            url: input.sourceUrl,
            origin: 'https://example.com',
            capturedAt: input.capturedAt ?? '2026-01-01T00:00:00.000Z',
          },
          createdAt: '2026-01-02T03:04:05.000Z',
          status: 'complete' as const,
          summary: {
            totalResources: 1,
            downloadedResources: 1,
            failedResources: 0,
            skippedResources: 0,
            cancelledResources: 0,
            totalBytes: 15,
          },
          timings: { totalMs: 10, downloadMs: 8, localizationMs: 2 },
          resources: [
            {
              sourceUrl: input.sourceUrl,
              canonicalUrl: input.sourceUrl,
              status: 'downloaded' as const,
              localPath: 'site/index.html',
              contentType: 'text/html',
              size: 15,
            },
          ],
          onlineDependencies: [],
          warnings: [],
        };
        await writeFile(
          join(options.outputDirectory, 'mirror.json'),
          JSON.stringify(manifest),
          'utf8',
        );
        return manifest;
      },
      startPreviewServer: async (options) => {
        previewOptions.push(options);
        return {
          host: '127.0.0.1',
          port: 43123,
          url: 'http://127.0.0.1:43123/',
          close: async () => undefined,
        };
      },
      runValidation: async (options) => ({
        ...successfulValidation(options.entryUrl),
        ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
      }),
      openExternal: async (target) => {
        opened.push(target);
      },
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });
    const send = async (message: NativeHostResponse) => {
      messages.push(message);
    };

    await service.handleRequest(request, send);

    expect(messages.map((message) => message.type)).toEqual([
      'mirror_progress',
      'mirror_progress',
      'mirror_progress',
      'mirror_progress',
      'mirror_progress',
      'mirror_progress',
      'mirror_result',
    ]);
    expect(messages.at(-1)).toMatchObject({
      type: 'mirror_result',
      requestId: 'request-create',
      jobId: 'job-123',
      success: true,
      result: {
        status: 'complete',
        entryUrl: 'http://127.0.0.1:43123/editions/winter2026?locale=en-US',
        downloadedResources: 1,
        completenessScore: 100,
        reportUrl: 'http://127.0.0.1:43123/report.html',
      },
    });
    expect(previewOptions[0]).toMatchObject({
      fallbackPath: 'index.html',
      routeAliases: [
        {
          route: '/editions/winter2026?locale=en-US',
          localPath: 'index.html',
        },
      ],
    });

    await service.handleRequest(
      {
        type: 'job_action',
        requestId: 'request-open',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-123',
        action: 'open_preview',
      },
      send,
    );

    expect(opened).toEqual(['http://127.0.0.1:43123/editions/winter2026?locale=en-US']);
    const result = messages.find((message) => message.type === 'mirror_result' && message.success);

    if (result?.type !== 'mirror_result' || !result.success) {
      throw new Error('Expected a successful mirror result.');
    }

    const launchScript = await readFile(join(result.result.outputDirectory, 'launch.cmd'), 'utf8');
    expect(launchScript).toContain('webmirror-helper.exe" --serve "%~dp0" --open');

    await service.handleRequest(
      {
        type: 'job_action',
        requestId: 'request-open-output',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-123',
        action: 'open_output',
      },
      send,
    );
    expect(opened).toEqual([
      'http://127.0.0.1:43123/editions/winter2026?locale=en-US',
      result.result.outputDirectory,
    ]);
    expect(messages.at(-1)).toMatchObject({
      type: 'job_action_result',
      requestId: 'request-open-output',
      action: 'open_output',
      success: true,
      path: result.result.outputDirectory,
    });

    await rm(result.result.outputDirectory, { recursive: true, force: true });
    await service.handleRequest(
      {
        type: 'job_action',
        requestId: 'request-open-missing-output',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-123',
        action: 'open_output',
      },
      send,
    );
    expect(messages.at(-1)).toMatchObject({
      type: 'job_action_result',
      requestId: 'request-open-missing-output',
      action: 'open_output',
      success: false,
      error: {
        code: 'INVALID_ACTION',
        message: 'The mirror output directory no longer exists. Create the mirror again.',
      },
    });
    await service.dispose();
  });

  it('aborts the active job and acknowledges cancellation', async () => {
    const messages: NativeHostResponse[] = [];
    let observedAbort = false;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: async (_input, options) => {
        markStarted();
        await new Promise<void>((resolveAbort) => {
          if (options.signal?.aborted) {
            observedAbort = true;
            resolveAbort();
            return;
          }

          options.signal?.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              resolveAbort();
            },
            { once: true },
          );
        });
        const error = new Error('cancelled');
        error.name = 'AbortError';
        throw error;
      },
    });
    const send = async (message: NativeHostResponse) => {
      messages.push(message);
    };
    const createPromise = service.handleRequest(createRequest('job-cancel'), send);
    await started;

    await service.handleRequest(
      {
        type: 'mirror_cancel',
        requestId: 'request-cancel',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-cancel',
      },
      send,
    );
    await createPromise;

    expect(observedAbort).toBe(true);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'mirror_cancel_result',
          accepted: true,
        }),
        expect.objectContaining({
          type: 'mirror_result',
          success: true,
          result: expect.objectContaining({
            status: 'cancelled',
          }),
        }),
      ]),
    );
  });

  it('does not report a capped capture as complete', async () => {
    const messages: NativeHostResponse[] = [];
    const request = createRequest('job-capped-capture');
    request.capture.completionReason = 'maximum_duration';
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: createCompleteMirror,
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43126,
        url: 'http://127.0.0.1:43126/',
        close: async () => undefined,
      }),
      runValidation: async (options) => successfulValidation(options.entryUrl),
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });

    await service.handleRequest(request, async (message) => {
      messages.push(message);
    });

    expect(messages.at(-1)).toMatchObject({
      type: 'mirror_result',
      success: true,
      result: {
        status: 'partial',
      },
    });
    await service.dispose();
  });

  it('automatically retries transient failures with reduced concurrency', async () => {
    const messages: NativeHostResponse[] = [];
    const observedOptions: CreateMirrorOptions[] = [];
    let createCalls = 0;
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: async (input, options) => {
        createCalls += 1;
        observedOptions.push(options);
        return createRetryFixtureMirror(
          input,
          options,
          createCalls === 1 ? 'initial' : 'recovered',
        );
      },
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43128,
        url: 'http://127.0.0.1:43128/',
        close: async () => undefined,
      }),
      runValidation: async (options) => successfulValidation(options.entryUrl),
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });

    await service.handleRequest(createRetryRequest('automatic-retry-job'), async (message) => {
      messages.push(message);
    });

    expect(createCalls).toBe(2);
    expect(observedOptions[1]).toMatchObject({
      concurrency: 2,
      maxResourceBytes: 256 * 1024 * 1024,
      maxRetries: 3,
      retryDelayMs: 1_000,
    });
    expect(messages.at(-1)).toMatchObject({
      type: 'mirror_result',
      success: true,
      result: {
        status: 'complete',
        failedResources: 0,
      },
    });
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'mirror_progress',
        state: 'downloading',
        message: 'Retry pass processed 1 of 1 transient resource(s).',
      }),
    );

    const [outputName] = await readdir(outputRoot);

    if (!outputName) {
      throw new Error('Expected the mirror output directory.');
    }

    const manifest = JSON.parse(
      await readFile(join(outputRoot, outputName, 'mirror.json'), 'utf8'),
    ) as MirrorManifest;

    expect(manifest.warnings).toContain(
      'Automatically recovered 1 of 1 transient network failure(s) with reduced concurrency.',
    );
    await service.dispose();
  });

  it('preserves a runnable partial mirror when cancellation interrupts automatic retry', async () => {
    const messages: NativeHostResponse[] = [];
    let createCalls = 0;
    let markRetryStarted: () => void = () => undefined;
    const retryStarted = new Promise<void>((resolveStarted) => {
      markRetryStarted = resolveStarted;
    });
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: async (input, options) => {
        createCalls += 1;

        if (createCalls === 1) {
          return createRetryFixtureMirror(input, options, 'initial');
        }

        markRetryStarted();
        return rejectWhenAborted(options.signal, 'automatic retry cancelled');
      },
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });
    const send = async (message: NativeHostResponse) => {
      messages.push(message);
    };
    const createPromise = service.handleRequest(
      createRetryRequest('automatic-retry-cancel-job'),
      send,
    );
    await retryStarted;

    await service.handleRequest(
      {
        type: 'mirror_cancel',
        requestId: 'automatic-retry-cancel-request',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'automatic-retry-cancel-job',
      },
      send,
    );
    await createPromise;

    const [outputName] = await readdir(outputRoot);

    if (!outputName) {
      throw new Error('Expected the preserved mirror output directory.');
    }

    const manifest = JSON.parse(
      await readFile(join(outputRoot, outputName, 'mirror.json'), 'utf8'),
    ) as MirrorManifest;

    expect(createCalls).toBe(2);
    expect(manifest.status).toBe('partial');
    expect(manifest.summary.downloadedResources).toBe(1);
    expect(manifest.resources).toContainEqual(
      expect.objectContaining({
        canonicalUrl: 'https://example.com/',
        status: 'downloaded',
        localPath: 'site/index.html',
      }),
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'mirror_cancel_result',
          accepted: true,
        }),
        expect.objectContaining({
          type: 'mirror_result',
          success: true,
          result: expect.objectContaining({ status: 'partial' }),
        }),
      ]),
    );
    await service.dispose();
  });

  it('preserves a runnable partial mirror when disconnect interrupts automatic retry', async () => {
    let createCalls = 0;
    let markRetryStarted: () => void = () => undefined;
    const retryStarted = new Promise<void>((resolveStarted) => {
      markRetryStarted = resolveStarted;
    });
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: async (input, options) => {
        createCalls += 1;

        if (createCalls === 1) {
          return createRetryFixtureMirror(input, options, 'initial');
        }

        markRetryStarted();
        return rejectWhenAborted(options.signal, 'automatic retry disconnected');
      },
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });
    const createPromise = service.handleRequest(
      createRetryRequest('automatic-retry-disconnect-job'),
      async () => undefined,
    );
    await retryStarted;
    await service.dispose();
    await createPromise;

    const [outputName] = await readdir(outputRoot);

    if (!outputName) {
      throw new Error('Expected the preserved mirror output directory.');
    }

    const manifest = JSON.parse(
      await readFile(join(outputRoot, outputName, 'mirror.json'), 'utf8'),
    ) as MirrorManifest;

    expect(createCalls).toBe(2);
    expect(manifest.status).toBe('partial');
    expect(manifest.summary.downloadedResources).toBe(1);
    expect(manifest.resources).toContainEqual(
      expect.objectContaining({
        canonicalUrl: 'https://example.com/',
        status: 'downloaded',
        localPath: 'site/index.html',
      }),
    );
  });

  it('does not automatically retry a non-retryable failed resource', async () => {
    const messages: NativeHostResponse[] = [];
    let createCalls = 0;
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: async (input, options) => {
        createCalls += 1;
        const manifest = await createRetryFixtureMirror(input, options, 'initial');
        const failed = manifest.resources.find((resource) => resource.status === 'failed');

        if (!failed) {
          throw new Error('Expected a failed resource in the fixture manifest.');
        }

        failed.retryable = false;
        return manifest;
      },
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43129,
        url: 'http://127.0.0.1:43129/',
        close: async () => undefined,
      }),
      runValidation: async (options) => successfulValidation(options.entryUrl),
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });

    await service.handleRequest(createRetryRequest('non-retryable-job'), async (message) => {
      messages.push(message);
    });

    expect(createCalls).toBe(1);
    expect(messages.at(-1)).toMatchObject({
      type: 'mirror_result',
      success: true,
      result: {
        status: 'partial',
        failedResources: 1,
      },
    });
    await service.dispose();
  });

  it('keeps a downloaded entry runnable when optional static resources fail permanently', async () => {
    const messages: NativeHostResponse[] = [];
    const previewOptions: PreviewServerOptions[] = [];
    const validationOptions: RunValidationOptions[] = [];
    const request = createRequest('optional-static-failures-job');
    const entryUrl = 'https://example.com/storefront';
    const missingStyleUrl = 'https://example.com/assets/missing.css';
    const forbiddenScriptUrl = 'https://example.com/assets/forbidden.js';
    const unauthorizedConfigurationUrl =
      'https://api.example.test//configuration/v1/storefront.json';
    request.capture.sourceUrl = entryUrl;
    request.capture.resources = [
      { sourceUrl: entryUrl, method: 'GET', contentType: 'text/html' },
      { sourceUrl: missingStyleUrl, method: 'GET', contentType: 'text/css' },
      {
        sourceUrl: forbiddenScriptUrl,
        method: 'GET',
        contentType: 'application/javascript',
      },
      {
        sourceUrl: unauthorizedConfigurationUrl,
        method: 'GET',
        contentType: 'application/json',
      },
    ];
    let createCalls = 0;
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: async (input, options) => {
        createCalls += 1;
        const entryBody = Buffer.from('<!doctype html><h1>Storefront</h1>', 'utf8');
        await mkdir(join(options.outputDirectory, 'site'), { recursive: true });
        await writeFile(join(options.outputDirectory, 'site', 'index.html'), entryBody);
        const manifest: MirrorManifest = {
          schemaVersion: 1,
          source: {
            url: input.sourceUrl,
            origin: new URL(input.sourceUrl).origin,
            capturedAt: input.capturedAt ?? '2026-01-01T00:00:00.000Z',
          },
          createdAt: '2026-01-02T03:04:05.000Z',
          status: 'partial',
          summary: {
            totalResources: 4,
            downloadedResources: 1,
            failedResources: 3,
            skippedResources: 0,
            cancelledResources: 0,
            totalBytes: entryBody.byteLength,
          },
          timings: { totalMs: 10, downloadMs: 8, localizationMs: 2 },
          resources: [
            {
              sourceUrl: entryUrl,
              canonicalUrl: entryUrl,
              status: 'downloaded',
              localPath: 'site/index.html',
              contentType: 'text/html',
              size: entryBody.byteLength,
              sha256: sha256(entryBody),
            },
            {
              sourceUrl: missingStyleUrl,
              canonicalUrl: missingStyleUrl,
              status: 'failed',
              localPath: 'site/assets/missing.css',
              contentType: 'text/css',
              retryable: false,
              error: 'Download failed with HTTP 404',
            },
            {
              sourceUrl: forbiddenScriptUrl,
              canonicalUrl: forbiddenScriptUrl,
              status: 'failed',
              localPath: 'site/assets/forbidden.js',
              contentType: 'application/javascript',
              retryable: false,
              error: 'Download failed with HTTP 403',
            },
            {
              sourceUrl: unauthorizedConfigurationUrl,
              canonicalUrl: unauthorizedConfigurationUrl,
              status: 'failed',
              localPath: 'site/_external/https/api.example.test/configuration/v1/storefront.json',
              contentType: 'application/json',
              retryable: false,
              error: 'Download failed with HTTP 401',
            },
          ],
          onlineDependencies: [],
          warnings: [],
        };
        await writeFile(
          join(options.outputDirectory, 'mirror.json'),
          JSON.stringify(manifest),
          'utf8',
        );
        return manifest;
      },
      startPreviewServer: async (options) => {
        previewOptions.push(options);
        const port = previewOptions.length === 1 ? 43131 : 43132;
        return {
          host: '127.0.0.1',
          port,
          url: `http://127.0.0.1:${port}/`,
          close: async () => undefined,
        };
      },
      runValidation: async (options) => {
        validationOptions.push(options);
        return successfulValidation(options.entryUrl);
      },
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });

    await service.handleRequest(request, async (message) => {
      messages.push(message);
    });

    expect(createCalls).toBe(1);
    expect(messages.at(-1)).toMatchObject({
      type: 'mirror_result',
      success: true,
      result: {
        status: 'partial',
        entryUrl: 'http://127.0.0.1:43131/storefront',
        failedResources: 3,
        reportUrl: 'http://127.0.0.1:43132/report.html',
      },
    });
    const result = messages.at(-1);

    if (result?.type !== 'mirror_result' || !result.success) {
      throw new Error('Expected a successful partial mirror result.');
    }

    expect(previewOptions).toHaveLength(2);
    expect(previewOptions[0]).toMatchObject({
      rootDirectory: join(result.result.outputDirectory, 'site'),
      fallbackPath: 'index.html',
      unavailableRoutes: expect.arrayContaining([
        '/assets/missing.css',
        '/assets/forbidden.js',
        '/configuration/v1/storefront.json',
      ]),
    });
    expect(previewOptions[0]?.unavailableRoutes).not.toContain(
      '//configuration/v1/storefront.json',
    );
    expect(previewOptions[1]).toMatchObject({
      rootDirectory: result.result.outputDirectory,
    });
    expect(validationOptions).toHaveLength(1);
    expect(validationOptions[0]?.entryUrl).toBe(result.result.entryUrl);

    const [manifest, validation, report, launchScript] = await Promise.all([
      readFile(join(result.result.outputDirectory, 'mirror.json'), 'utf8').then(
        (contents) => JSON.parse(contents) as MirrorManifest,
      ),
      readFile(join(result.result.outputDirectory, 'validation.json'), 'utf8').then(
        (contents) => JSON.parse(contents) as ValidationResult,
      ),
      readFile(join(result.result.outputDirectory, 'report.html'), 'utf8'),
      readFile(join(result.result.outputDirectory, 'launch.cmd'), 'utf8'),
    ]);

    expect(manifest.status).toBe('partial');
    expect(manifest.resources.filter((resource) => resource.status === 'failed')).toHaveLength(3);
    expect(validation.status).toBe('partial');
    expect(report).toContain('partial');
    expect(launchScript).toContain('webmirror-helper.exe" --serve "%~dp0" --open');
    await service.dispose();
  });

  it('does not force a retry when the mirror byte budget is exhausted', async () => {
    const messages: NativeHostResponse[] = [];
    let createCalls = 0;
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: async (input, options) => {
        createCalls += 1;
        return createRetryFixtureMirror(input, options, 'initial', 512 * 1024 * 1024);
      },
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43130,
        url: 'http://127.0.0.1:43130/',
        close: async () => undefined,
      }),
      runValidation: async (options) => successfulValidation(options.entryUrl),
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });

    await service.handleRequest(
      createRetryRequest('retry-budget-exhausted-job'),
      async (message) => {
        messages.push(message);
      },
    );

    expect(createCalls).toBe(1);
    expect(messages.at(-1)).toMatchObject({
      type: 'mirror_result',
      success: true,
      result: {
        status: 'partial',
        failedResources: 1,
      },
    });

    const [outputName] = await readdir(outputRoot);

    if (!outputName) {
      throw new Error('Expected the mirror output directory.');
    }

    const manifest = JSON.parse(
      await readFile(join(outputRoot, outputName, 'mirror.json'), 'utf8'),
    ) as MirrorManifest;

    expect(manifest.warnings.join(' ')).toContain(
      'No remaining mirror byte budget is available for retrying failed resources.',
    );
    await service.dispose();
  });

  it('filters malformed online dependencies before sending a successful Native Messaging result', async () => {
    const messages: NativeHostResponse[] = [];
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: async (input, options) => {
        const manifest = await createCompleteMirror(input, options);
        manifest.onlineDependencies = ['https://'];
        return manifest;
      },
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43134,
        url: 'http://127.0.0.1:43134/',
        close: async () => undefined,
      }),
      runValidation: async (options) => successfulValidation(options.entryUrl),
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });

    await service.handleRequest(
      createRequest('malformed-online-dependency-job'),
      async (message) => {
        messages.push(message);
      },
    );

    const terminal = messages.at(-1);

    expect(terminal).toMatchObject({
      type: 'mirror_result',
      success: true,
      result: {
        status: 'complete',
        onlineDependencies: [],
      },
    });
    expect(isNativeHostResponse(terminal)).toBe(true);

    const [outputName] = await readdir(outputRoot);

    if (!outputName) {
      throw new Error('Expected the mirror output directory.');
    }

    const manifest = JSON.parse(
      await readFile(join(outputRoot, outputName, 'mirror.json'), 'utf8'),
    ) as MirrorManifest;

    expect(manifest.onlineDependencies).toEqual([]);
    expect(manifest.warnings).toContain(
      'Ignored 1 malformed online dependency value before sending the Native Messaging result.',
    );
    await service.dispose();
  });

  it('keeps validation diagnostic URLs out of the mirror dependency manifest', async () => {
    const messages: NativeHostResponse[] = [];
    const diagnosticUrl =
      'https://origin-0123456789abcdef0123456789abcdef.invalid/path-0123456789abcdef0123456789abcdef';
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: createCompleteMirror,
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43135,
        url: 'http://127.0.0.1:43135/',
        close: async () => undefined,
      }),
      runValidation: async (options) => {
        const validation = successfulValidation(options.entryUrl);
        validation.status = 'partial';
        validation.score = 95;
        validation.checks.remoteDependencies = {
          passed: false,
          dependencies: [
            {
              url: diagnosticUrl,
              origin: 'https://origin-0123456789abcdef0123456789abcdef.invalid',
              reason: 'unexpected-remote',
              resourceType: 'image',
              method: 'GET',
              allowed: false,
              blocked: true,
            },
          ],
        };
        validation.warnings = ['A validation-only remote request was blocked.'];
        return validation;
      },
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });

    await service.handleRequest(createRequest('validation-diagnostic-url-job'), async (message) => {
      messages.push(message);
    });

    expect(messages.at(-1)).toMatchObject({
      type: 'mirror_result',
      success: true,
      result: {
        status: 'partial',
        onlineDependencies: [],
      },
    });

    const [outputName] = await readdir(outputRoot);

    if (!outputName) {
      throw new Error('Expected the mirror output directory.');
    }

    const [manifest, validation] = await Promise.all([
      readFile(join(outputRoot, outputName, 'mirror.json'), 'utf8').then(
        (contents) => JSON.parse(contents) as MirrorManifest,
      ),
      readFile(join(outputRoot, outputName, 'validation.json'), 'utf8').then(
        (contents) => JSON.parse(contents) as ValidationResult,
      ),
    ]);

    expect(manifest.onlineDependencies).toEqual([]);
    expect(validation.checks.remoteDependencies.dependencies).toMatchObject([
      { url: diagnosticUrl, blocked: true },
    ]);
    await service.dispose();
  });

  it('gives complex pages a bounded 60-second validation budget', async () => {
    const messages: NativeHostResponse[] = [];
    let observedOptions: RunValidationOptions | undefined;
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: createCompleteMirror,
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43133,
        url: 'http://127.0.0.1:43133/',
        close: async () => undefined,
      }),
      runValidation: async (options) => {
        observedOptions = options;
        return successfulValidation(options.entryUrl);
      },
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });
    const request = createRequest('validation-budget-job');
    request.capture.browser = {
      name: 'Google Chrome',
      version: '150.0.0.0',
    };
    request.capture.runtimeCapabilities = {
      webgl: { compressedTextureFamilies: ['s3tc'] },
      webgl2: { compressedTextureFamilies: ['etc'] },
    };

    await service.handleRequest(request, async (message) => {
      messages.push(message);
    });

    expect(observedOptions).toMatchObject({
      timeoutMs: 60_000,
      settleTimeMs: 2_000,
      canvasSettleTimeoutMs: 10_000,
      browser: request.capture.browser,
      runtimeCapabilities: request.capture.runtimeCapabilities,
    });
    expect(messages.at(-1)).toMatchObject({
      type: 'mirror_result',
      success: true,
    });
    await service.dispose();
  });

  it('preserves mirror capability boundaries in the final status and report', async () => {
    const messages: NativeHostResponse[] = [];
    const capabilityBoundary =
      'Capability boundary: the resource limit of 1000 was reached while preserving the current document runtime dependency closure.';
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: async (input, options) => {
        const manifest = await createCompleteMirror(input, options);
        manifest.status = 'partial';
        manifest.warnings.push(capabilityBoundary);
        await writeFile(
          join(options.outputDirectory, 'mirror.json'),
          JSON.stringify(manifest),
          'utf8',
        );
        return manifest;
      },
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43135,
        url: 'http://127.0.0.1:43135/',
        close: async () => undefined,
      }),
      runValidation: async (options) => {
        const validation = successfulValidation(options.entryUrl);
        await writeFile(
          join(options.outputDirectory, validation.artifacts.validationJson),
          JSON.stringify(validation),
          'utf8',
        );
        await writeFile(
          join(options.outputDirectory, validation.artifacts.reportHtml),
          '<p>validation complete</p>',
          'utf8',
        );
        return validation;
      },
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });

    await service.handleRequest(createRequest('capability-boundary-job'), async (message) => {
      messages.push(message);
    });

    expect(messages.at(-1)).toMatchObject({
      type: 'mirror_result',
      success: true,
      result: {
        status: 'partial',
        completenessScore: 99,
      },
    });
    const [outputName] = await readdir(outputRoot);

    if (!outputName) {
      throw new Error('Expected the mirror output directory.');
    }

    const outputDirectory = join(outputRoot, outputName);
    const manifest = JSON.parse(
      await readFile(join(outputDirectory, 'mirror.json'), 'utf8'),
    ) as MirrorManifest;
    const validation = JSON.parse(
      await readFile(join(outputDirectory, 'validation.json'), 'utf8'),
    ) as ValidationResult;
    const report = await readFile(join(outputDirectory, 'report.html'), 'utf8');

    expect(manifest.status).toBe('partial');
    expect(validation.status).toBe('partial');
    expect(validation.warnings).toContain(capabilityBoundary);
    expect(report).toContain('partial');
    expect(report).toContain('Capability boundary');
    await service.dispose();
  });

  it('refuses ZIP export when a resource was quarantined for sensitive content', async () => {
    const messages: NativeHostResponse[] = [];
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: async (input, options) => {
        const manifest = await createCompleteMirror(input, options);
        manifest.status = 'partial';
        manifest.resources.push({
          sourceUrl: 'https://example.com/private.json',
          canonicalUrl: 'https://example.com/private.json',
          status: 'failed',
          localPath: 'site/private.json',
          securityIssue: 'sensitive_content',
          error: 'High-confidence sensitive content was detected.',
        });
        manifest.summary = {
          totalResources: 2,
          downloadedResources: 1,
          failedResources: 1,
          skippedResources: 0,
          cancelledResources: 0,
          totalBytes: 15,
        };
        await writeFile(
          join(options.outputDirectory, 'mirror.json'),
          JSON.stringify(manifest),
          'utf8',
        );
        return manifest;
      },
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43132,
        url: 'http://127.0.0.1:43132/',
        close: async () => undefined,
      }),
      runValidation: async (options) => successfulValidation(options.entryUrl),
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });
    const send = async (message: NativeHostResponse) => {
      messages.push(message);
    };
    await service.handleRequest(createRequest('sensitive-job'), send);
    await service.handleRequest(
      {
        type: 'job_action',
        requestId: 'sensitive-export',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'sensitive-job',
        action: 'export_zip',
      },
      send,
    );

    expect(messages.at(-1)).toMatchObject({
      type: 'job_action_result',
      action: 'export_zip',
      success: false,
      error: {
        code: 'INVALID_ACTION',
        message: expect.stringContaining('sensitive content'),
      },
    });
    await service.dispose();
  });

  it('marks mirror.json failed when fast validation crashes', async () => {
    const messages: NativeHostResponse[] = [];
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: createCompleteMirror,
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43124,
        url: 'http://127.0.0.1:43124/',
        close: async () => undefined,
      }),
      runValidation: async () => {
        throw new Error('validation boom');
      },
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });

    await service.handleRequest(createRequest('job-validation-failure'), async (message) => {
      messages.push(message);
    });
    const [outputName] = await readdir(outputRoot);

    if (!outputName) {
      throw new Error('Expected the failed mirror output directory.');
    }

    const manifest = JSON.parse(
      await readFile(join(outputRoot, outputName, 'mirror.json'), 'utf8'),
    ) as MirrorManifest;

    expect(manifest.status).toBe('failed');
    expect(manifest.warnings).toContain('validation boom');
    expect(messages.at(-1)).toMatchObject({
      type: 'mirror_result',
      success: false,
      error: {
        code: 'MIRROR_FAILED',
      },
    });
    await service.dispose();
  });

  it('preserves mirror.json as partial when validation is aborted after artifact commit', async () => {
    const messages: NativeHostResponse[] = [];
    let markValidationStarted: () => void = () => undefined;
    const validationStarted = new Promise<void>((resolveStarted) => {
      markValidationStarted = resolveStarted;
    });
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: createCompleteMirror,
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43125,
        url: 'http://127.0.0.1:43125/',
        close: async () => undefined,
      }),
      runValidation: async (options) => {
        markValidationStarted();
        return await new Promise<never>((_resolve, reject) => {
          const rejectAbort = () => {
            const error = new Error('validation cancelled');
            error.name = 'AbortError';
            reject(error);
          };

          if (options.signal?.aborted) {
            rejectAbort();
          } else {
            options.signal?.addEventListener('abort', rejectAbort, { once: true });
          }
        });
      },
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });
    const createPromise = service.handleRequest(
      createRequest('job-validation-cancel'),
      async (message) => {
        messages.push(message);
      },
    );
    await validationStarted;
    await service.handleRequest(
      {
        type: 'mirror_cancel',
        requestId: 'request-validation-cancel',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-validation-cancel',
      },
      async (message) => {
        messages.push(message);
      },
    );
    await createPromise;
    const [outputName] = await readdir(outputRoot);

    if (!outputName) {
      throw new Error('Expected the cancelled mirror output directory.');
    }

    const manifest = JSON.parse(
      await readFile(join(outputRoot, outputName, 'mirror.json'), 'utf8'),
    ) as MirrorManifest;

    expect(manifest.status).toBe('partial');
    expect(manifest.warnings).toContain(
      'The mirror artifact was preserved, but validation was interrupted before it completed.',
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'mirror_cancel_result',
          accepted: true,
        }),
        expect.objectContaining({
          type: 'mirror_result',
          success: true,
          result: expect.objectContaining({
            status: 'partial',
          }),
        }),
      ]),
    );
    await service.dispose();
  });

  it('preserves the committed mirror when the Native Messaging service disconnects during validation', async () => {
    let markValidationStarted: () => void = () => undefined;
    const validationStarted = new Promise<void>((resolveStarted) => {
      markValidationStarted = resolveStarted;
    });
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: createCompleteMirror,
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43138,
        url: 'http://127.0.0.1:43138/',
        close: async () => undefined,
      }),
      runValidation: async (options) => {
        markValidationStarted();
        return await new Promise<never>((_resolve, reject) => {
          const rejectAbort = () => {
            const error = new Error('validation disconnected');
            error.name = 'AbortError';
            reject(error);
          };

          if (options.signal?.aborted) {
            rejectAbort();
          } else {
            options.signal?.addEventListener('abort', rejectAbort, { once: true });
          }
        });
      },
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });
    const createPromise = service.handleRequest(
      createRequest('job-validation-disconnect'),
      async () => undefined,
    );
    await validationStarted;
    await service.dispose();
    await createPromise;
    const [outputName] = await readdir(outputRoot);

    if (!outputName) {
      throw new Error('Expected the preserved mirror output directory.');
    }

    const manifest = JSON.parse(
      await readFile(join(outputRoot, outputName, 'mirror.json'), 'utf8'),
    ) as MirrorManifest;

    expect(manifest.status).toBe('partial');
    expect(manifest.summary.downloadedResources).toBe(1);
    expect(manifest.warnings).toContain(
      'The mirror artifact was preserved, but validation was interrupted before it completed.',
    );
  });

  it('rejects an incomplete validation result but preserves the committed mirror', async () => {
    const messages: NativeHostResponse[] = [];
    let markValidationStarted: () => void = () => undefined;
    const validationStarted = new Promise<void>((resolveStarted) => {
      markValidationStarted = resolveStarted;
    });
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: createCompleteMirror,
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43126,
        url: 'http://127.0.0.1:43126/',
        close: async () => undefined,
      }),
      runValidation: async (options) => {
        await writeFile(join(options.outputDirectory, 'validation.json'), '{"status":"complete"}');
        await writeFile(join(options.outputDirectory, 'report.html'), '<p>complete</p>');
        markValidationStarted();
        await new Promise<void>((resolveAbort) => {
          if (options.signal?.aborted) {
            resolveAbort();
          } else {
            options.signal?.addEventListener('abort', () => resolveAbort(), { once: true });
          }
        });
        return successfulValidation(options.entryUrl);
      },
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });
    const createPromise = service.handleRequest(
      createRequest('job-validation-late-cancel'),
      async (message) => {
        messages.push(message);
      },
    );
    await validationStarted;
    await service.handleRequest(
      {
        type: 'mirror_cancel',
        requestId: 'request-validation-late-cancel',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-validation-late-cancel',
      },
      async (message) => {
        messages.push(message);
      },
    );
    await createPromise;
    const [outputName] = await readdir(outputRoot);

    if (!outputName) {
      throw new Error('Expected the cancelled mirror output directory.');
    }

    const outputDirectory = join(outputRoot, outputName);
    const manifest = JSON.parse(
      await readFile(join(outputDirectory, 'mirror.json'), 'utf8'),
    ) as MirrorManifest;

    expect(manifest.status).toBe('partial');
    await expect(readFile(join(outputDirectory, 'validation.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(outputDirectory, 'report.html'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'mirror_result',
          success: true,
          result: expect.objectContaining({
            status: 'complete',
          }),
        }),
      ]),
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'mirror_result',
          success: true,
          result: expect.objectContaining({
            status: 'partial',
          }),
        }),
      ]),
    );
    await service.dispose();
  });

  it('keeps a completed result while the ready progress event is still being delivered', async () => {
    const messages: NativeHostResponse[] = [];
    let markReadyProgressStarted: () => void = () => undefined;
    let releaseReadyProgress: () => void = () => undefined;
    const readyProgressStarted = new Promise<void>((resolveStarted) => {
      markReadyProgressStarted = resolveStarted;
    });
    const readyProgressRelease = new Promise<void>((resolveRelease) => {
      releaseReadyProgress = resolveRelease;
    });
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: createCompleteMirror,
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43127,
        url: 'http://127.0.0.1:43127/',
        close: async () => undefined,
      }),
      runValidation: async (options) => {
        await writeFile(join(options.outputDirectory, 'validation.json'), '{"status":"complete"}');
        await writeFile(join(options.outputDirectory, 'report.html'), '<p>complete</p>');
        return successfulValidation(options.entryUrl);
      },
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });
    const createPromise = service.handleRequest(
      createRequest('job-ready-progress-cancel'),
      async (message) => {
        messages.push(message);

        if (message.type === 'mirror_progress' && message.state === 'ready') {
          markReadyProgressStarted();
          await readyProgressRelease;
        }
      },
    );
    await readyProgressStarted;
    await service.handleRequest(
      {
        type: 'mirror_cancel',
        requestId: 'request-ready-progress-cancel',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-ready-progress-cancel',
      },
      async (message) => {
        messages.push(message);
      },
    );
    releaseReadyProgress();
    await createPromise;
    const [outputName] = await readdir(outputRoot);

    if (!outputName) {
      throw new Error('Expected the cancelled mirror output directory.');
    }

    const outputDirectory = join(outputRoot, outputName);
    const manifest = JSON.parse(
      await readFile(join(outputDirectory, 'mirror.json'), 'utf8'),
    ) as MirrorManifest;

    expect(manifest.status).toBe('complete');
    await expect(readFile(join(outputDirectory, 'validation.json'), 'utf8')).resolves.toContain(
      'complete',
    );
    await expect(readFile(join(outputDirectory, 'report.html'), 'utf8')).resolves.toContain(
      'complete',
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'mirror_cancel_result',
          accepted: true,
        }),
        expect.objectContaining({
          type: 'mirror_result',
          success: true,
          result: expect.objectContaining({
            status: 'complete',
          }),
        }),
      ]),
    );
    await service.dispose();
  });

  it('keeps completed artifacts when the ready progress sender throws', async () => {
    const messages: NativeHostResponse[] = [];
    let readySendAttempts = 0;
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: createCompleteMirror,
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43139,
        url: 'http://127.0.0.1:43139/',
        close: async () => undefined,
      }),
      runValidation: async (options) => successfulValidation(options.entryUrl),
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });

    await expect(
      service.handleRequest(createRequest('job-ready-sender-failure'), async (message) => {
        if (message.type === 'mirror_progress' && message.state === 'ready') {
          readySendAttempts += 1;
          throw new Error('ready progress delivery failed');
        }

        messages.push(message);
      }),
    ).resolves.toBeUndefined();

    const [outputName] = await readdir(outputRoot);

    if (!outputName) {
      throw new Error('Expected the completed mirror output directory.');
    }

    const outputDirectory = join(outputRoot, outputName);
    const manifest = JSON.parse(
      await readFile(join(outputDirectory, 'mirror.json'), 'utf8'),
    ) as MirrorManifest;
    const validation = JSON.parse(
      await readFile(join(outputDirectory, 'validation.json'), 'utf8'),
    ) as ValidationResult;
    const report = await readFile(join(outputDirectory, 'report.html'), 'utf8');

    expect(readySendAttempts).toBe(1);
    expect(manifest.status).toBe('complete');
    expect(manifest.warnings).not.toContain('ready progress delivery failed');
    expect(validation.status).toBe('complete');
    expect(report).not.toContain('ready progress delivery failed');
    expect(messages.at(-1)).toMatchObject({
      type: 'mirror_result',
      success: true,
      result: { status: 'complete' },
    });
    await service.dispose();
  });

  it('keeps completed artifacts when the final mirror result sender throws', async () => {
    const messages: NativeHostResponse[] = [];
    let resultSendAttempts = 0;
    const service = new NativeMirrorService({
      outputRoot,
      createMirror: createCompleteMirror,
      startPreviewServer: async () => ({
        host: '127.0.0.1',
        port: 43140,
        url: 'http://127.0.0.1:43140/',
        close: async () => undefined,
      }),
      runValidation: async (options) => successfulValidation(options.entryUrl),
      launchExecutable: 'C:\\WebMirror\\webmirror-helper.exe',
    });

    await expect(
      service.handleRequest(createRequest('job-result-sender-failure'), async (message) => {
        if (message.type === 'mirror_result') {
          resultSendAttempts += 1;
          throw new Error('final mirror result delivery failed');
        }

        messages.push(message);
      }),
    ).resolves.toBeUndefined();

    const [outputName] = await readdir(outputRoot);

    if (!outputName) {
      throw new Error('Expected the completed mirror output directory.');
    }

    const outputDirectory = join(outputRoot, outputName);
    const manifest = JSON.parse(
      await readFile(join(outputDirectory, 'mirror.json'), 'utf8'),
    ) as MirrorManifest;
    const validation = JSON.parse(
      await readFile(join(outputDirectory, 'validation.json'), 'utf8'),
    ) as ValidationResult;
    const report = await readFile(join(outputDirectory, 'report.html'), 'utf8');

    expect(resultSendAttempts).toBe(1);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'mirror_progress',
        state: 'ready',
      }),
    );
    expect(manifest.status).toBe('complete');
    expect(manifest.warnings).not.toContain('final mirror result delivery failed');
    expect(validation.status).toBe('complete');
    expect(report).not.toContain('final mirror result delivery failed');
    await service.dispose();
  });

  it('builds deterministic safe output names', () => {
    expect(
      outputNameForTesting(
        outputRoot,
        createRequest('job:unsafe/id'),
        new Date('2026-01-02T03:04:05.000Z'),
      ),
    ).toBe('example.com-20260102T030405Z-job-unsafe-i');
  });
});
