import { describe, expect, it } from 'vitest';

import type { CaptureManifest, CapturedResource } from '@webmirror/capture';

import { toNativeCapture } from './capture-to-native.js';

function privacy(
  overrides: Partial<NonNullable<CapturedResource['privacy']>> = {},
): NonNullable<CapturedResource['privacy']> {
  return {
    requestExtraInfoReceived: true,
    responseExtraInfoReceived: false,
    requestHasCookie: true,
    requestHasAuthorization: false,
    responseHasSetCookie: false,
    responsePrivateOrNoStore: false,
    responseVariesByCredential: false,
    responseCookiePolicyAffected: false,
    ambiguousRedirect: false,
    ...overrides,
  };
}

function resource(
  id: string,
  url: string,
  options: {
    state?: CapturedResource['state'];
    resourceType?: string;
    initiatorType?: string;
    workerContext?: boolean;
    responseStatus?: number;
    mimeType?: string;
    responseHeaders?: Record<string, string>;
    privacy?: CapturedResource['privacy'];
    encodedDataLength?: number;
    body?: CapturedResource['body'];
  } = {},
): CapturedResource {
  const state = options.state ?? 'discovered';
  return {
    id,
    requestId: id,
    redirectIndex: 0,
    state,
    request: {
      url,
      method: 'GET',
      headers: {},
      ...(options.resourceType ? { resourceType: options.resourceType } : {}),
      ...(options.initiatorType ? { initiatorType: options.initiatorType } : {}),
      ...(options.workerContext ? { workerContext: true } : {}),
    },
    ...(options.responseStatus !== undefined
      ? {
          response: {
            url,
            status: options.responseStatus,
            statusText: '',
            mimeType: options.mimeType ?? 'application/octet-stream',
            protocol: 'h2',
            headers: options.responseHeaders ?? {},
            hasSetCookie: false,
            fromDiskCache: false,
            fromPrefetchCache: false,
            fromServiceWorker: false,
          },
        }
      : {}),
    ...(options.privacy ? { privacy: options.privacy } : {}),
    ...(options.encodedDataLength !== undefined
      ? { encodedDataLength: options.encodedDataLength }
      : {}),
    ...(options.body ? { body: options.body } : {}),
  };
}

function manifest(
  resources: CapturedResource[],
  completionReason: CaptureManifest['completionReason'] = 'maximum_duration',
): CaptureManifest {
  return {
    schemaVersion: 1,
    jobId: 'job-1',
    tabId: 1,
    sourceUrl: 'https://example.test/',
    title: 'Fixture',
    startedAt: '2026-07-22T00:00:00.000Z',
    completedAt: '2026-07-22T00:00:30.000Z',
    completionReason,
    preflight: {
      origin: 'https://example.test',
      canvasElements: 0,
      iframeElements: 0,
      mediaElements: 0,
      serviceWorkerControlled: false,
      observedResourceCount: resources.length,
      observedTransferBytes: 0,
      workerResourceHints: 0,
      webglResourceHints: 0,
      wasmResourceHints: 0,
    },
    resources,
    warnings: [],
  };
}

describe('toNativeCapture', () => {
  it('retains pending same-origin static runtime resources at the capture deadline', () => {
    const result = toNativeCapture(
      manifest([
        resource('audio', 'https://example.test/assets/audio/intro.mp3', {
          resourceType: 'XHR',
          privacy: privacy(),
        }),
        resource('subtitle', 'https://example.test/assets/audio/intro.srt', {
          resourceType: 'XHR',
          privacy: privacy(),
        }),
        resource('model', 'https://example.test/assets/models/scene.glb', {
          resourceType: 'XHR',
          privacy: privacy({ responseExtraInfoReceived: true, responseStatusCode: 200 }),
        }),
      ]),
    );

    expect(result.resources.map((candidate) => candidate.sourceUrl)).toEqual([
      'https://example.test/',
      'https://example.test/assets/audio/intro.mp3',
      'https://example.test/assets/audio/intro.srt',
      'https://example.test/assets/models/scene.glb',
    ]);
    expect(result.warnings).toContain(
      'Retained 3 same-origin static GET request(s) that were still pending at the capture cutoff for anonymous Helper retrieval.',
    );
  });

  it('rejects pending requests without sufficient static and privacy evidence', () => {
    const result = toNativeCapture(
      manifest([
        resource('cross-origin', 'https://cdn.example.test/assets/scene.glb', {
          resourceType: 'XHR',
          privacy: privacy(),
        }),
        resource('api', 'https://example.test/api/config.json', {
          resourceType: 'XHR',
          privacy: privacy(),
        }),
        resource('token', 'https://example.test/assets/config.json?token=secret', {
          resourceType: 'XHR',
          privacy: privacy(),
        }),
        resource('authorization', 'https://example.test/assets/private.glb', {
          resourceType: 'XHR',
          privacy: privacy({ requestHasAuthorization: true }),
        }),
        resource('private', 'https://example.test/assets/private.json', {
          resourceType: 'XHR',
          privacy: privacy({ responsePrivateOrNoStore: true }),
        }),
        resource('extensionless-xhr', 'https://example.test/runtime/config', {
          resourceType: 'XHR',
          privacy: privacy(),
        }),
        resource('extensionless-script', 'https://example.test/runtime/module', {
          resourceType: 'Script',
          privacy: privacy(),
        }),
        resource('missing-extra-info', 'https://example.test/assets/model.glb', {
          resourceType: 'XHR',
          privacy: privacy({ requestExtraInfoReceived: false }),
        }),
        resource('encoded-api', 'https://example.test/%61pi/config.json', {
          resourceType: 'XHR',
          privacy: privacy(),
        }),
        {
          ...resource('redirect', 'https://example.test/assets/redirect.glb', {
            resourceType: 'XHR',
            privacy: privacy(),
          }),
          redirectIndex: 1,
        },
        resource('redirect-status', 'https://example.test/assets/redirected.glb', {
          resourceType: 'XHR',
          privacy: privacy({ responseExtraInfoReceived: true, responseStatusCode: 302 }),
        }),
        resource('document-json', 'https://example.test/assets/state.json', {
          resourceType: 'Document',
          privacy: privacy(),
        }),
      ]),
    );

    expect(result.resources).toEqual([
      {
        sourceUrl: 'https://example.test/',
        method: 'GET',
        contentType: 'text/html',
      },
    ]);
    expect(result.warnings.some((warning) => warning.startsWith('Retained '))).toBe(false);
  });

  it('does not retain incomplete requests after a network-idle capture', () => {
    const result = toNativeCapture(
      manifest(
        [
          resource('model', 'https://example.test/assets/models/scene.glb', {
            resourceType: 'XHR',
            privacy: privacy(),
          }),
        ],
        'network_idle',
      ),
    );

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]?.sourceUrl).toBe('https://example.test/');
  });

  it('retains safe static Performance URLs observed before attachment after network idle', () => {
    const result = toNativeCapture(
      manifest(
        [
          resource('hdr', 'https://cdn.example.test/environments/studio.hdr', {
            resourceType: 'Fetch',
            initiatorType: 'performance',
          }),
          resource('model', 'https://cdn.example.test/models/scene.gltf', {
            resourceType: 'Fetch',
            initiatorType: 'performance',
          }),
          resource('lottie', 'https://cdn.example.test/animations/intro.json?v=2', {
            resourceType: 'Fetch',
            initiatorType: 'performance',
          }),
          resource('runtime', 'https://cdn.example.test/features/runtime.js', {
            resourceType: 'Script',
            initiatorType: 'performance',
          }),
        ],
        'network_idle',
      ),
    );

    expect(result.resources.map((candidate) => candidate.sourceUrl)).toEqual([
      'https://example.test/',
      'https://cdn.example.test/environments/studio.hdr',
      'https://cdn.example.test/models/scene.gltf',
      'https://cdn.example.test/animations/intro.json?v=2',
      'https://cdn.example.test/features/runtime.js',
    ]);
    expect(result.resources.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceType: 'Fetch', initiatorType: 'performance' }),
        expect.objectContaining({ resourceType: 'Script', initiatorType: 'performance' }),
      ]),
    );
    expect(result.warnings).toContain(
      'Retained 4 previously observed static resource URL(s) for anonymous Helper retrieval.',
    );
  });

  it('rejects sensitive, API, telemetry, modified, and mistyped Performance hints', () => {
    const result = toNativeCapture(
      manifest(
        [
          resource('api', 'https://cdn.example.test/api/config.json', {
            resourceType: 'Fetch',
            initiatorType: 'performance',
          }),
          resource('token', 'https://cdn.example.test/assets/config.json?token=secret', {
            resourceType: 'Fetch',
            initiatorType: 'performance',
          }),
          resource('telemetry', 'https://www.google-analytics.com/analytics.js', {
            resourceType: 'Script',
            initiatorType: 'performance',
          }),
          resource('wrong-initiator', 'https://cdn.example.test/models/scene.glb', {
            resourceType: 'Fetch',
            initiatorType: 'script',
          }),
          resource('wrong-type', 'https://cdn.example.test/runtime/app.js', {
            resourceType: 'Fetch',
            initiatorType: 'performance',
          }),
        ],
        'network_idle',
      ),
    );

    expect(result.resources).toEqual([
      {
        sourceUrl: 'https://example.test/',
        method: 'GET',
        contentType: 'text/html',
      },
    ]);
    expect(result.warnings.some((warning) => warning.includes('previously observed'))).toBe(false);
  });

  it('prefers completed response evidence over an earlier pending duplicate', () => {
    const url = 'https://example.test/assets/models/scene.glb';
    const result = toNativeCapture(
      manifest([
        resource('pending', url, {
          resourceType: 'XHR',
          privacy: privacy(),
        }),
        resource('complete', url, {
          state: 'complete',
          resourceType: 'XHR',
          workerContext: true,
          responseStatus: 200,
          mimeType: 'model/gltf-binary',
          encodedDataLength: 1024,
          privacy: privacy({
            responseExtraInfoReceived: true,
            responseStatusCode: 200,
          }),
        }),
      ]),
    );

    expect(result.resources[1]).toMatchObject({
      sourceUrl: url,
      contentType: 'model/gltf-binary',
      expectedSize: 1024,
      workerContext: true,
    });
    expect(result.warnings.some((warning) => warning.startsWith('Retained '))).toBe(false);
  });

  it('prefers completed response evidence over an earlier historical Performance hint', () => {
    const url = 'https://cdn.example.test/models/scene.glb';
    const result = toNativeCapture(
      manifest(
        [
          resource('historical', url, {
            resourceType: 'Fetch',
            initiatorType: 'performance',
          }),
          resource('complete', url, {
            state: 'complete',
            resourceType: 'Fetch',
            workerContext: true,
            responseStatus: 200,
            mimeType: 'model/gltf-binary',
            encodedDataLength: 4096,
            privacy: privacy({
              requestHasCookie: false,
              responseExtraInfoReceived: true,
              responseStatusCode: 200,
            }),
          }),
        ],
        'network_idle',
      ),
    );

    expect(result.resources[1]).toMatchObject({
      sourceUrl: url,
      contentType: 'model/gltf-binary',
      expectedSize: 4096,
      workerContext: true,
    });
    expect(result.warnings.some((warning) => warning.includes('previously observed'))).toBe(false);
  });

  it('does not forward a captured body that is empty despite non-empty response evidence', () => {
    const url = 'https://example.test/assets/texture.png';
    const result = toNativeCapture(
      manifest(
        [
          resource('texture', url, {
            state: 'complete',
            resourceType: 'Image',
            responseStatus: 200,
            mimeType: 'image/png',
            responseHeaders: {
              'content-length': '4096',
              'content-type': 'image/png',
            },
            encodedDataLength: 4200,
            body: {
              id: 'empty-texture-body',
              byteLength: 0,
              sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              source: 'network',
              reuseScope: 'same_origin',
              contentType: 'image/png',
              httpStatus: 200,
            },
          }),
        ],
        'network_idle',
      ),
    );

    expect(result.resources[1]).toEqual({
      sourceUrl: url,
      method: 'GET',
      contentType: 'image/png',
      resourceType: 'Image',
      expectedSize: 4200,
    });
    expect(result.warnings).toContain(
      '1 captured response body or bodies were not reused because the resource was not proven safe for local reuse.',
    );
  });
});
