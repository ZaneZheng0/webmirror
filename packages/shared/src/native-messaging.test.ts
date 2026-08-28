import { describe, expect, it } from 'vitest';

import {
  isNativeHostResponse,
  isNativeMirrorCreateRequest,
  isNativePostHandshakeRequest,
  isNativeResourceBodyChunkRequest,
  isNativeResourceBodyEndRequest,
  isNativeResourceBodyStartRequest,
  nativeMessagingCapabilities,
  nativeMessagingProtocolVersion,
  nativeResourceBodyMaxBytes,
  nativeResourceBodyReuseScopes,
  type NativeMirrorCreateRequest,
} from './native-messaging.js';

function validCreateRequest(): NativeMirrorCreateRequest {
  return {
    type: 'mirror_create',
    requestId: 'request-1',
    protocolVersion: nativeMessagingProtocolVersion,
    jobId: 'job-1',
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
          expectedSize: 128,
          bodyId: 'body-1',
          resourceType: 'Document',
          initiatorType: 'parser',
        },
      ],
      warnings: [],
    },
  };
}

describe('Native Messaging command validation', () => {
  it('accepts a bounded mirror creation request', () => {
    const request = validCreateRequest();

    expect(isNativeMirrorCreateRequest(request)).toBe(true);
    expect(isNativePostHandshakeRequest(request)).toBe(true);
  });

  it('keeps runtime evidence optional and rejects malformed classifications', () => {
    const legacyRequest = validCreateRequest();
    const legacyResource = legacyRequest.capture.resources[0]!;
    delete legacyResource.resourceType;
    delete legacyResource.initiatorType;
    expect(isNativeMirrorCreateRequest(legacyRequest)).toBe(true);

    const emptyResourceType = validCreateRequest() as unknown as Record<string, unknown>;
    const emptyResourceTypeCapture = emptyResourceType.capture as {
      resources: Array<Record<string, unknown>>;
    };
    emptyResourceTypeCapture.resources[0]!.resourceType = '';
    expect(isNativeMirrorCreateRequest(emptyResourceType)).toBe(false);

    const oversizedInitiatorType = validCreateRequest() as unknown as Record<string, unknown>;
    const oversizedInitiatorTypeCapture = oversizedInitiatorType.capture as {
      resources: Array<Record<string, unknown>>;
    };
    oversizedInitiatorTypeCapture.resources[0]!.initiatorType = 'x'.repeat(129);
    expect(isNativeMirrorCreateRequest(oversizedInitiatorType)).toBe(false);

    const workerContext = validCreateRequest();
    workerContext.capture.resources[0]!.workerContext = true;
    expect(isNativeMirrorCreateRequest(workerContext)).toBe(true);

    const malformedWorkerContext = validCreateRequest() as unknown as Record<string, unknown>;
    const malformedWorkerContextCapture = malformedWorkerContext.capture as {
      resources: Array<Record<string, unknown>>;
    };
    malformedWorkerContextCapture.resources[0]!.workerContext = 'yes';
    expect(isNativeMirrorCreateRequest(malformedWorkerContext)).toBe(false);
  });

  it('accepts only bounded rendering capability profiles', () => {
    const request = validCreateRequest();
    request.capture.runtimeCapabilities = {
      webgl: { compressedTextureFamilies: ['s3tc', 's3tc-srgb'] },
      webgl2: { compressedTextureFamilies: ['etc'] },
    };
    expect(isNativeMirrorCreateRequest(request)).toBe(true);

    const malformed = request as unknown as {
      capture: {
        runtimeCapabilities: {
          webgl: { compressedTextureFamilies: string[] };
          webgl2: { compressedTextureFamilies: string[] };
        };
      };
    };
    malformed.capture.runtimeCapabilities.webgl.compressedTextureFamilies.push('unknown');
    expect(isNativeMirrorCreateRequest(malformed)).toBe(false);
  });

  it('rejects unknown credential-bearing fields at every capture level', () => {
    const captureField = validCreateRequest() as unknown as Record<string, unknown>;
    (captureField.capture as Record<string, unknown>).headers = { cookie: 'secret' };
    expect(isNativeMirrorCreateRequest(captureField)).toBe(false);

    const resourceField = validCreateRequest() as unknown as Record<string, unknown>;
    const capture = resourceField.capture as { resources: Array<Record<string, unknown>> };
    capture.resources[0]!.authorization = 'Bearer secret';
    expect(isNativeMirrorCreateRequest(resourceField)).toBe(false);
  });

  it('rejects oversized collections and protocol mismatches by shape', () => {
    const mismatch = validCreateRequest() as unknown as Record<string, unknown>;
    mismatch.protocolVersion = nativeMessagingProtocolVersion + 1;
    expect(isNativeMirrorCreateRequest(mismatch)).toBe(false);

    const oversized = validCreateRequest() as unknown as Record<string, unknown>;
    const oversizedCapture = oversized.capture as Record<string, unknown>;
    oversizedCapture.resources = Array.from({ length: 5_001 }, () => ({
      sourceUrl: 'https://example.com/a.js',
      method: 'GET',
    }));

    expect(isNativeMirrorCreateRequest(oversized)).toBe(false);

    const duplicateBodyIds = validCreateRequest() as unknown as Record<string, unknown>;
    const duplicateCapture = duplicateBodyIds.capture as {
      resources: Array<Record<string, unknown>>;
    };
    duplicateCapture.resources.push({
      sourceUrl: 'https://example.com/other.bin',
      method: 'GET',
      bodyId: 'body-1',
    });
    expect(isNativeMirrorCreateRequest(duplicateBodyIds)).toBe(false);
  });

  it('rejects an invalid job action', () => {
    expect(
      isNativePostHandshakeRequest({
        type: 'job_action',
        requestId: 'request-1',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-1',
        action: 'delete_arbitrary_path',
      }),
    ).toBe(false);
  });

  it('rejects malformed progress and result payloads from the helper', () => {
    expect(
      isNativeHostResponse({
        type: 'mirror_progress',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-1',
        state: 'not-a-job-state',
        discoveredResources: 1,
        completedResources: 0,
        downloadedBytes: 0,
        warningCount: 0,
        elapsedMs: 1,
        message: 'invalid',
      }),
    ).toBe(false);

    expect(
      isNativeHostResponse({
        type: 'mirror_result',
        requestId: 'request-1',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-1',
        success: true,
        result: {},
        error: null,
      }),
    ).toBe(false);
  });

  it('accepts bounded resource body start, chunk, and end messages', () => {
    const sha256 = 'a'.repeat(64);

    expect(
      isNativeResourceBodyStartRequest({
        type: 'resource_body_start',
        requestId: 'body-start',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-1',
        bodyId: 'body-1',
        sourceUrl: 'https://example.com/asset.bin',
        sourceOrigin: 'https://example.com/',
        byteLength: 3,
        sha256,
      }),
    ).toBe(true);
    expect(
      isNativeResourceBodyStartRequest({
        type: 'resource_body_start',
        requestId: 'public-body-start',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-1',
        bodyId: 'public-body-1',
        sourceUrl: 'https://cdn.example.net/asset.bin',
        sourceOrigin: 'https://example.com/',
        reuseScope: 'public_cross_origin',
        byteLength: 3,
        sha256,
      }),
    ).toBe(true);
    expect(
      isNativeResourceBodyChunkRequest({
        type: 'resource_body_chunk',
        requestId: 'body-chunk',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-1',
        bodyId: 'body-1',
        offset: 0,
        data: 'YWJj',
      }),
    ).toBe(true);
    expect(
      isNativeResourceBodyEndRequest({
        type: 'resource_body_end',
        requestId: 'body-end',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-1',
        bodyId: 'body-1',
        byteLength: 3,
        sha256,
      }),
    ).toBe(true);
    expect(nativeResourceBodyReuseScopes).toEqual(['same_origin', 'public_cross_origin']);
    expect(nativeMessagingCapabilities).toContain('public-cross-origin-body-v1');
    expect(nativeMessagingCapabilities).toContain('runtime-capability-profile-v1');
  });

  it('rejects malformed resource body data, offsets, sizes, hashes, and unknown fields', () => {
    const validChunk = {
      type: 'resource_body_chunk',
      requestId: 'body-chunk',
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: 'job-1',
      bodyId: 'body-1',
      offset: 0,
      data: 'YWJj',
    };
    expect(isNativeResourceBodyChunkRequest({ ...validChunk, data: 'not-base64!' })).toBe(false);
    expect(isNativeResourceBodyChunkRequest({ ...validChunk, offset: -1 })).toBe(false);
    expect(isNativeResourceBodyChunkRequest({ ...validChunk, offset: 1.5 })).toBe(false);
    expect(isNativeResourceBodyChunkRequest({ ...validChunk, cookie: 'secret' })).toBe(false);

    const validStart = {
      type: 'resource_body_start',
      requestId: 'body-start',
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: 'job-1',
      bodyId: 'body-1',
      sourceUrl: 'https://example.com/asset.bin',
      sourceOrigin: 'https://example.com/',
      byteLength: 3,
      sha256: 'a'.repeat(64),
    };
    expect(
      isNativeResourceBodyStartRequest({
        ...validStart,
        sourceOrigin: 'https://other.example/',
      }),
    ).toBe(false);
    expect(
      isNativeResourceBodyStartRequest({
        ...validStart,
        reuseScope: 'unknown',
      }),
    ).toBe(false);
    expect(
      isNativeResourceBodyStartRequest({
        ...validStart,
        reuseScope: 'public_cross_origin',
      }),
    ).toBe(false);
    expect(
      isNativeResourceBodyStartRequest({
        ...validStart,
        sourceUrl: 'http://cdn.example.net/asset.bin',
        reuseScope: 'public_cross_origin',
      }),
    ).toBe(false);
    expect(
      isNativeResourceBodyStartRequest({
        ...validStart,
        sourceUrl: 'https://user:password@cdn.example.net/asset.bin',
        reuseScope: 'public_cross_origin',
      }),
    ).toBe(false);
    expect(
      isNativeResourceBodyStartRequest({
        ...validStart,
        byteLength: nativeResourceBodyMaxBytes + 1,
      }),
    ).toBe(false);
    expect(
      isNativeResourceBodyStartRequest({
        ...validStart,
        sha256: 'A'.repeat(64),
      }),
    ).toBe(false);
    expect(
      isNativeResourceBodyEndRequest({
        ...validStart,
        type: 'resource_body_end',
        sha256: 'short',
      }),
    ).toBe(false);
  });

  it('validates correlated resource body acknowledgements', () => {
    expect(
      isNativeHostResponse({
        type: 'resource_body_result',
        requestId: 'body-end',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-1',
        bodyId: 'body-1',
        stage: 'end',
        accepted: true,
        nextOffset: 3,
        complete: true,
        error: null,
      }),
    ).toBe(true);
    expect(
      isNativeHostResponse({
        type: 'resource_body_result',
        requestId: 'body-end',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: 'job-1',
        bodyId: 'body-1',
        stage: 'end',
        accepted: false,
        nextOffset: 3,
        complete: true,
        error: {
          code: 'RESOURCE_BODY_HASH_MISMATCH',
          message: 'invalid',
        },
      }),
    ).toBe(false);
  });

  it('accepts a bounded mirror result only when preview URLs stay on loopback', () => {
    const result = {
      type: 'mirror_result',
      requestId: 'request-1',
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: 'job-1',
      success: true,
      result: {
        status: 'complete',
        outputDirectory: 'C:\\WebMirror\\job-1',
        previewUrl: 'http://127.0.0.1:41000/',
        entryUrl: 'http://127.0.0.1:41000/index.html',
        manifestPath: 'C:\\WebMirror\\job-1\\mirror.json',
        validationPath: 'C:\\WebMirror\\job-1\\validation.json',
        reportUrl: 'http://127.0.0.1:41001/report.html',
        totalResources: 4,
        downloadedResources: 4,
        failedResources: 0,
        downloadedBytes: 1024,
        warningCount: 0,
        elapsedMs: 100,
        completenessScore: 100,
        onlineDependencies: [],
      },
      error: null,
    };

    expect(isNativeHostResponse(result)).toBe(true);
    result.result.entryUrl = 'https://attacker.example/';
    expect(isNativeHostResponse(result)).toBe(false);

    expect(
      isNativeHostResponse({
        ...result,
        result: {
          ...result.result,
          entryUrl: 'http://127.0.0.1:41000/index.html',
          onlineDependencies: ['https://'],
        },
      }),
    ).toBe(false);
  });
});
