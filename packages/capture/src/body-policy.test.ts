import { describe, expect, it } from 'vitest';

import {
  capturedResponseBodyIntegrityError,
  capturedResponseBodyReuseScope,
  historicalStaticResourceType,
  isHistoricalStaticGetCandidate,
  isIncompleteStaticGetCandidate,
} from './body-policy.js';
import type { CapturedResource } from './types.js';

function publicFetchResource(
  sourceUrl: string,
  overrides: Partial<CapturedResource> = {},
): CapturedResource {
  return {
    id: 'root:fetch:0',
    requestId: 'fetch',
    redirectIndex: 0,
    state: 'complete',
    request: {
      url: sourceUrl,
      method: 'GET',
      headers: {},
      resourceType: 'Fetch',
    },
    response: {
      url: sourceUrl,
      status: 200,
      statusText: 'OK',
      mimeType: 'model/gltf-binary',
      protocol: 'h2',
      headers: {
        'cache-control': 'public, max-age=86400',
        'content-type': 'model/gltf-binary',
      },
      hasSetCookie: false,
      fromDiskCache: false,
      fromPrefetchCache: false,
      fromServiceWorker: false,
    },
    privacy: {
      requestExtraInfoReceived: true,
      responseExtraInfoReceived: true,
      requestHasCookie: false,
      requestHasAuthorization: false,
      responseHasSetCookie: false,
      responsePrivateOrNoStore: false,
      responseVariesByCredential: false,
      responseCookiePolicyAffected: false,
      responseStatusCode: 200,
      ambiguousRedirect: false,
    },
    ...overrides,
  };
}

function incompleteResource(
  sourceUrl: string,
  resourceType = 'XHR',
  overrides: Partial<CapturedResource> = {},
): CapturedResource {
  return {
    id: 'root:pending:0',
    requestId: 'pending',
    redirectIndex: 0,
    state: 'discovered',
    request: {
      url: sourceUrl,
      method: 'GET',
      headers: {},
      resourceType,
    },
    privacy: {
      requestExtraInfoReceived: true,
      responseExtraInfoReceived: false,
      requestHasCookie: true,
      requestHasAuthorization: false,
      responseHasSetCookie: false,
      responsePrivateOrNoStore: false,
      responseVariesByCredential: false,
      responseCookiePolicyAffected: false,
      ambiguousRedirect: false,
    },
    ...overrides,
  };
}

function historicalResource(
  sourceUrl: string,
  resourceType: string,
  overrides: Partial<CapturedResource> = {},
): CapturedResource {
  return {
    id: 'root:performance:0',
    requestId: 'performance',
    redirectIndex: 0,
    state: 'discovered',
    request: {
      url: sourceUrl,
      method: 'GET',
      headers: {},
      resourceType,
      initiatorType: 'performance',
    },
    ...overrides,
  };
}

describe('capturedResponseBodyReuseScope', () => {
  it('accepts credential-free public static Fetch assets', () => {
    expect(
      capturedResponseBodyReuseScope(
        publicFetchResource('https://cdn.example.net/models/helmet.glb'),
        'https://example.test',
      ),
    ).toBe('public_cross_origin');
  });

  it('accepts an explicit credential-free public CORS response when CDP omits extra info', () => {
    const sourceOrigin = 'https://example.test';
    const resource = publicFetchResource('https://cdn.example.net/models/helmet.glb', {
      response: {
        ...publicFetchResource('https://cdn.example.net/models/helmet.glb').response!,
        headers: {
          'access-control-allow-origin': sourceOrigin,
          'cache-control': 'public, max-age=86400',
          'content-type': 'model/gltf-binary',
        },
      },
      privacy: {
        requestExtraInfoReceived: false,
        responseExtraInfoReceived: false,
        requestHasCookie: false,
        requestHasAuthorization: false,
        responseHasSetCookie: false,
        responsePrivateOrNoStore: false,
        responseVariesByCredential: false,
        responseCookiePolicyAffected: false,
        ambiguousRedirect: false,
      },
    });

    expect(capturedResponseBodyReuseScope(resource, sourceOrigin)).toBe('public_cross_origin');
  });

  it('rejects an explicit public CORS response that permits credentials', () => {
    const sourceOrigin = 'https://example.test';
    const resource = publicFetchResource('https://cdn.example.net/models/helmet.glb', {
      response: {
        ...publicFetchResource('https://cdn.example.net/models/helmet.glb').response!,
        headers: {
          'access-control-allow-credentials': 'true',
          'access-control-allow-origin': sourceOrigin,
          'cache-control': 'public, max-age=86400',
          'content-type': 'model/gltf-binary',
        },
      },
      privacy: {
        requestExtraInfoReceived: false,
        responseExtraInfoReceived: false,
        requestHasCookie: false,
        requestHasAuthorization: false,
        responseHasSetCookie: false,
        responsePrivateOrNoStore: false,
        responseVariesByCredential: false,
        responseCookiePolicyAffected: false,
        ambiguousRedirect: false,
      },
    });

    expect(capturedResponseBodyReuseScope(resource, sourceOrigin)).toBeUndefined();
  });

  it('rejects API paths, non-public caching, and sensitive query parameters', () => {
    expect(
      capturedResponseBodyReuseScope(
        publicFetchResource('https://cdn.example.net/api/model.json'),
        'https://example.test',
      ),
    ).toBeUndefined();
    expect(
      capturedResponseBodyReuseScope(
        publicFetchResource('https://cdn.example.net/models/helmet.glb', {
          response: {
            ...publicFetchResource('https://cdn.example.net/models/helmet.glb').response!,
            headers: {
              'cache-control': 'no-cache',
              'content-type': 'model/gltf-binary',
            },
          },
        }),
        'https://example.test',
      ),
    ).toBeUndefined();
    expect(
      capturedResponseBodyReuseScope(
        publicFetchResource('https://cdn.example.net/models/helmet.glb?X-Amz-Signature=secret'),
        'https://example.test',
      ),
    ).toBeUndefined();
  });

  it('continues to reject cross-origin XHR data even when headers look public', () => {
    const resource = publicFetchResource('https://cdn.example.net/data.json', {
      request: {
        url: 'https://cdn.example.net/data.json',
        method: 'GET',
        headers: {},
        resourceType: 'XHR',
      },
      response: {
        ...publicFetchResource('https://cdn.example.net/data.json').response!,
        mimeType: 'application/json',
        headers: {
          'cache-control': 'public, max-age=86400',
          'content-type': 'application/json',
        },
      },
    });

    expect(capturedResponseBodyReuseScope(resource, 'https://example.test')).toBeUndefined();
  });

  it('does not reuse known nonessential social embed response bodies', () => {
    const resource = publicFetchResource('https://platform.twitter.com/widgets.js', {
      request: {
        url: 'https://platform.twitter.com/widgets.js',
        method: 'GET',
        headers: {},
        resourceType: 'Script',
      },
      response: {
        ...publicFetchResource('https://platform.twitter.com/widgets.js').response!,
        mimeType: 'application/javascript',
        headers: {
          'cache-control': 'public, max-age=86400',
          'content-type': 'application/javascript',
        },
      },
    });

    expect(capturedResponseBodyReuseScope(resource, 'https://example.test')).toBeUndefined();
  });
});

describe('capturedResponseBodyIntegrityError', () => {
  it('rejects an empty body when response metadata proves the resource is non-empty', () => {
    const resource = publicFetchResource('https://cdn.example.net/models/helmet.glb', {
      encodedDataLength: 4_096,
      response: {
        ...publicFetchResource('https://cdn.example.net/models/helmet.glb').response!,
        headers: {
          'content-length': '4096',
          'content-type': 'model/gltf-binary',
        },
      },
    });

    expect(capturedResponseBodyIntegrityError(resource, 0)).toBe(
      'Captured response body is empty despite Content-Length 4096.',
    );
    expect(capturedResponseBodyIntegrityError(resource, 16)).toBeUndefined();
  });

  it('uses encoded byte evidence when Content-Length is unavailable', () => {
    const resource = publicFetchResource('https://cdn.example.net/models/helmet.glb', {
      encodedDataLength: 4_096,
      response: {
        ...publicFetchResource('https://cdn.example.net/models/helmet.glb').response!,
        headers: {
          'content-type': 'model/gltf-binary',
        },
      },
    });

    expect(capturedResponseBodyIntegrityError(resource, 0)).toBe(
      'Captured response body is empty after 4096 encoded response bytes were observed.',
    );
  });

  it('allows an explicitly empty no-content response', () => {
    const resource = publicFetchResource('https://cdn.example.net/models/helmet.glb', {
      encodedDataLength: 128,
      response: {
        ...publicFetchResource('https://cdn.example.net/models/helmet.glb').response!,
        status: 204,
        headers: {
          'content-length': '0',
          'content-type': 'application/octet-stream',
        },
      },
    });

    expect(capturedResponseBodyIntegrityError(resource, 0)).toBeUndefined();
  });
});

describe('isIncompleteStaticGetCandidate', () => {
  it.each([
    'https://example.test/assets/texture.jpg.dds',
    'https://example.test/assets/model.glb',
    'https://example.test/assets/audio.mp3',
    'https://example.test/assets/subtitles.srt',
    'https://example.test/assets/config.json?v=7',
    'https://example.test/assets/api-client.js?rev=hash',
  ])('accepts an observed same-origin static request: %s', (url) => {
    expect(isIncompleteStaticGetCandidate(incompleteResource(url), 'https://example.test')).toBe(
      true,
    );
  });

  it.each([
    'https://cdn.example.test/assets/model.glb',
    'https://example.test/api/config.json',
    'https://example.test/%61pi/config.json',
    'https://example.test/assets/config.json?token=secret',
    'https://example.test/assets/config.json?X-Amz-Signature=secret',
  ])('rejects an incomplete request outside the anonymous static boundary: %s', (url) => {
    expect(isIncompleteStaticGetCandidate(incompleteResource(url), 'https://example.test')).toBe(
      false,
    );
  });

  it('requires complete request privacy evidence and a direct 2xx request', () => {
    const base = incompleteResource('https://example.test/assets/model.glb');

    expect(
      isIncompleteStaticGetCandidate(
        {
          ...base,
          privacy: {
            ...base.privacy!,
            requestExtraInfoReceived: false,
          },
        },
        'https://example.test',
      ),
    ).toBe(false);
    expect(
      isIncompleteStaticGetCandidate(
        {
          ...base,
          privacy: {
            ...base.privacy!,
            requestHasAuthorization: true,
          },
        },
        'https://example.test',
      ),
    ).toBe(false);
    expect(
      isIncompleteStaticGetCandidate(
        {
          ...base,
          privacy: {
            ...base.privacy!,
            responseExtraInfoReceived: true,
            responseStatusCode: 302,
          },
        },
        'https://example.test',
      ),
    ).toBe(false);
    expect(
      isIncompleteStaticGetCandidate(
        {
          ...base,
          redirectIndex: 1,
        },
        'https://example.test',
      ),
    ).toBe(false);
  });

  it('requires both a static subresource type and a known static extension', () => {
    expect(
      isIncompleteStaticGetCandidate(
        incompleteResource('https://example.test/assets/state.json', 'Document'),
        'https://example.test',
      ),
    ).toBe(false);
    expect(
      isIncompleteStaticGetCandidate(
        incompleteResource('https://example.test/runtime/module', 'Script'),
        'https://example.test',
      ),
    ).toBe(false);
    expect(
      isIncompleteStaticGetCandidate(
        incompleteResource('https://example.test/live/stream', 'Media'),
        'https://example.test',
      ),
    ).toBe(false);
    expect(
      isIncompleteStaticGetCandidate(
        incompleteResource('https://example.test/audio/intro.mp3', 'Media'),
        'https://example.test',
      ),
    ).toBe(true);
  });
});

describe('historical static Performance resource policy', () => {
  it.each([
    ['https://cdn.example.test/runtime/app.mjs?v=7', 'Script'],
    ['https://cdn.example.test/styles/site.css', 'Stylesheet'],
    ['https://cdn.example.test/fonts/display.woff2', 'Font'],
    ['https://cdn.example.test/images/hero.avif', 'Image'],
    ['https://cdn.example.test/audio/intro.mp3', 'Media'],
    ['https://cdn.example.test/captions/intro.vtt', 'TextTrack'],
    ['https://cdn.example.test/site.webmanifest', 'Manifest'],
    ['https://cdn.example.test/models/scene.gltf', 'Fetch'],
    ['https://cdn.example.test/environments/studio.hdr', 'Fetch'],
    ['https://cdn.example.test/animations/intro.json', 'Fetch'],
    ['https://cdn.example.test/decoder.wasm', 'Fetch'],
  ])('classifies an anonymous static URL %s as %s', (url, resourceType) => {
    expect(historicalStaticResourceType(url)).toBe(resourceType);
    expect(isHistoricalStaticGetCandidate(historicalResource(url, resourceType))).toBe(true);
  });

  it.each([
    'blob:https://example.test/runtime-id',
    'data:application/json,%7B%7D',
    'https://user:password@cdn.example.test/model.glb',
    'https://cdn.example.test/runtime/config',
    'https://cdn.example.test/api/config.json',
    'https://cdn.example.test/%61pi/config.json',
    'https://cdn.example.test/auth/session.js',
    'https://cdn.example.test/assets/config.json?access_token=secret',
    'https://cdn.example.test/assets/model.glb?X-Amz-Credential=secret',
    'https://www.google-analytics.com/analytics.js',
  ])('rejects a historical URL outside the anonymous static boundary: %s', (url) => {
    expect(historicalStaticResourceType(url)).toBeUndefined();
  });

  it('requires an untouched direct GET Performance hint with a matching inferred type', () => {
    const url = 'https://cdn.example.test/models/scene.glb';
    const base = historicalResource(url, 'Fetch');

    expect(
      isHistoricalStaticGetCandidate({
        ...base,
        state: 'complete',
      }),
    ).toBe(false);
    expect(
      isHistoricalStaticGetCandidate({
        ...base,
        request: {
          ...base.request,
          method: 'POST',
        },
      }),
    ).toBe(false);
    expect(
      isHistoricalStaticGetCandidate({
        ...base,
        request: {
          ...base.request,
          headers: { cookie: 'not-retained' },
        },
      }),
    ).toBe(false);
    expect(
      isHistoricalStaticGetCandidate({
        ...base,
        request: {
          ...base.request,
          initiatorType: 'script',
        },
      }),
    ).toBe(false);
    expect(
      isHistoricalStaticGetCandidate({
        ...base,
        request: {
          ...base.request,
          resourceType: 'Script',
        },
      }),
    ).toBe(false);
    expect(
      isHistoricalStaticGetCandidate({
        ...base,
        redirectIndex: 1,
      }),
    ).toBe(false);
  });
});
