import { describe, expect, it } from 'vitest';

import { sanitizeHeaders } from './headers.js';
import { CaptureRecorder } from './recorder.js';

describe('sanitizeHeaders', () => {
  it('removes credentials and normalizes safe header names', () => {
    expect(
      sanitizeHeaders({
        Authorization: 'Bearer secret',
        Cookie: 'session=secret',
        Accept: 'text/html',
        'X-CSRF-Token': 'csrf-secret',
        'X-Amz-Security-Token': 'aws-secret',
        'X-Request-Id': 42,
      }),
    ).toEqual({
      accept: 'text/html',
    });
  });
});

describe('CaptureRecorder', () => {
  it('records a completed response without sensitive headers', () => {
    const recorder = new CaptureRecorder();

    recorder.requestWillBeSent(undefined, {
      requestId: '1',
      type: 'Document',
      request: {
        url: 'https://example.test/',
        method: 'GET',
        headers: {
          Cookie: 'session=secret',
          Accept: 'text/html',
        },
      },
      initiator: {
        type: 'other',
      },
    });
    recorder.responseReceived(undefined, {
      requestId: '1',
      response: {
        url: 'https://example.test/',
        status: 200,
        statusText: 'OK',
        mimeType: 'text/html',
        protocol: 'h2',
        headers: {
          'Content-Type': 'text/html',
          'Set-Cookie': 'session=secret',
        },
      },
    });
    recorder.loadingFinished(undefined, {
      requestId: '1',
      encodedDataLength: 120,
    });

    expect(recorder.snapshot()).toEqual([
      expect.objectContaining({
        id: 'root:1:0',
        state: 'complete',
        encodedDataLength: 120,
        request: expect.objectContaining({
          headers: {
            accept: 'text/html',
          },
          resourceType: 'Document',
          initiatorType: 'other',
        }),
        response: expect.objectContaining({
          status: 200,
          hasSetCookie: true,
          headers: {
            'content-type': 'text/html',
          },
        }),
      }),
    ]);
  });

  it('preserves redirect hops as separate resources', () => {
    const recorder = new CaptureRecorder();

    recorder.requestWillBeSent('child', {
      requestId: 'redirected',
      request: {
        url: 'https://example.test/old',
        method: 'GET',
      },
    });
    recorder.requestWillBeSent('child', {
      requestId: 'redirected',
      request: {
        url: 'https://example.test/new',
        method: 'GET',
      },
      redirectResponse: {
        url: 'https://example.test/old',
        status: 302,
        statusText: 'Found',
        headers: {
          Location: '/new',
        },
      },
    });
    recorder.responseReceived('child', {
      requestId: 'redirected',
      response: {
        url: 'https://example.test/new',
        status: 200,
        statusText: 'OK',
        mimeType: 'text/html',
      },
    });
    recorder.loadingFinished('child', {
      requestId: 'redirected',
      encodedDataLength: 10,
    });

    const resources = recorder.snapshot();

    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({
      id: 'child:redirected:0',
      state: 'complete',
      response: {
        status: 302,
      },
    });
    expect(resources[1]).toMatchObject({
      id: 'child:redirected:1',
      state: 'complete',
      response: {
        status: 200,
      },
    });
  });

  it('records blocked and canceled failures', () => {
    const recorder = new CaptureRecorder();

    recorder.requestWillBeSent(undefined, {
      requestId: 'failed',
      request: {
        url: 'https://example.test/failure',
        method: 'GET',
      },
    });
    recorder.loadingFailed(undefined, {
      requestId: 'failed',
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
      blockedReason: 'inspector',
      canceled: true,
    });

    expect(recorder.snapshot()[0]).toMatchObject({
      state: 'failed',
      failureReason: 'net::ERR_BLOCKED_BY_CLIENT',
      blockedReason: 'inspector',
      canceled: true,
    });
  });

  it('records only boolean privacy evidence from CDP extra-info events', () => {
    const recorder = new CaptureRecorder();

    recorder.requestWillBeSent(undefined, {
      requestId: 'public-cdn',
      type: 'Script',
      request: {
        url: 'https://cdn.example.net/app.js',
        method: 'GET',
      },
    });
    recorder.requestWillBeSentExtraInfo(undefined, {
      requestId: 'public-cdn',
      headers: {
        Referer: 'https://example.test/',
      },
      associatedCookies: [],
    });
    recorder.responseReceived(undefined, {
      requestId: 'public-cdn',
      type: 'Script',
      response: {
        url: 'https://cdn.example.net/app.js',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/javascript',
      },
    });
    recorder.responseReceivedExtraInfo(undefined, {
      requestId: 'public-cdn',
      statusCode: 200,
      headers: {
        'Cache-Control': 'public, max-age=3600',
        Vary: 'Accept-Encoding',
      },
    });

    expect(recorder.snapshot()[0]).toMatchObject({
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
    });
    expect(JSON.stringify(recorder.snapshot())).not.toContain('example.test/');
  });

  it('fails closed on repeated private headers and response cookie-policy evidence', () => {
    const recorder = new CaptureRecorder();

    recorder.requestWillBeSent(undefined, {
      requestId: 'unsafe-cdn',
      type: 'Script',
      request: {
        url: 'https://cdn.example.net/private.js',
        method: 'GET',
      },
    });
    recorder.responseReceived(undefined, {
      requestId: 'unsafe-cdn',
      type: 'Script',
      response: {
        url: 'https://cdn.example.net/private.js',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/javascript',
      },
    });
    recorder.responseReceivedExtraInfo(undefined, {
      requestId: 'unsafe-cdn',
      statusCode: 304,
      headers: {
        'Cache-Control': 'public\nprivate="Set-Cookie"',
        Vary: 'Accept-Encoding\nCookie',
      },
      blockedCookies: [{}],
    });

    expect(recorder.snapshot()[0]?.privacy).toMatchObject({
      responseExtraInfoReceived: true,
      responsePrivateOrNoStore: true,
      responseVariesByCredential: true,
      responseCookiePolicyAffected: true,
      responseStatusCode: 304,
    });
  });
});
