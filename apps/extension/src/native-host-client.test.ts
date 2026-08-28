import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  nativeMessagingCapabilities,
  nativeMessagingMaxMessageBytes,
  nativeMessagingProtocolVersion,
  nativeResourceBodyChunkBytes,
  type NativeHandshakeRequest,
} from '@webmirror/shared';

import type { CapturedResponseBody } from './capture-controller.js';
import { NativeHostClient } from './native-host-client.js';

type Listener<TArguments extends unknown[]> = (...arguments_: TArguments) => void;

class FakeChromeEvent<TArguments extends unknown[]> {
  readonly listeners = new Set<Listener<TArguments>>();

  addListener(listener: Listener<TArguments>): void {
    this.listeners.add(listener);
  }

  emit(...arguments_: TArguments): void {
    for (const listener of this.listeners) {
      listener(...arguments_);
    }
  }
}

class FakeNativePort {
  readonly onMessage = new FakeChromeEvent<[unknown]>();
  readonly onDisconnect = new FakeChromeEvent<[]>();
  readonly postedMessages: unknown[] = [];
  readonly disconnect = vi.fn();
  responder?: (message: Record<string, unknown>, port: FakeNativePort) => void;

  postMessage(message: unknown): void {
    this.postedMessages.push(message);

    if (this.responder && typeof message === 'object' && message !== null) {
      queueMicrotask(() => this.responder?.(message as Record<string, unknown>, this));
    }
  }
}

function handshakeRequest(port: FakeNativePort): NativeHandshakeRequest {
  const message = port.postedMessages[0];

  if (
    typeof message !== 'object' ||
    message === null ||
    !('type' in message) ||
    message.type !== 'handshake'
  ) {
    throw new Error('Expected a Native Messaging handshake request.');
  }

  return message as NativeHandshakeRequest;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('NativeHostClient', () => {
  it('reconnects once when an extension update is still attached to the previous helper', async () => {
    const stalePort = new FakeNativePort();
    const currentPort = new FakeNativePort();
    const ports = [stalePort, currentPort];

    for (const [port, helperVersion] of [
      [stalePort, '0.0.11'],
      [currentPort, '0.0.12'],
    ] as const) {
      port.responder = (message, respondingPort) => {
        if (message.type !== 'handshake') {
          return;
        }

        respondingPort.onMessage.emit({
          type: 'handshake_result',
          requestId: message.requestId,
          accepted: true,
          protocolVersion: nativeMessagingProtocolVersion,
          helperVersion,
          capabilities: nativeMessagingCapabilities,
          error: null,
        });
      };
    }

    vi.stubGlobal('chrome', {
      runtime: {
        id: 'webmirror-test-extension',
        lastError: undefined,
        getManifest: () => ({ version: '0.0.12' }),
        connectNative: vi.fn(() => ports.shift() as unknown as chrome.runtime.Port),
      },
    });
    const client = new NativeHostClient();

    await expect(client.connectCurrentVersion()).resolves.toMatchObject({
      helperVersion: '0.0.12',
    });
    expect(stalePort.disconnect).toHaveBeenCalledOnce();
    expect(handshakeRequest(stalePort).extensionVersion).toBe('0.0.12');
    expect(handshakeRequest(currentPort).extensionVersion).toBe('0.0.12');
  });

  it('reports an actionable error when reconnecting still reaches an outdated helper', async () => {
    const firstPort = new FakeNativePort();
    const secondPort = new FakeNativePort();
    const ports = [firstPort, secondPort];

    for (const port of ports) {
      port.responder = (message, respondingPort) => {
        if (message.type !== 'handshake') {
          return;
        }

        respondingPort.onMessage.emit({
          type: 'handshake_result',
          requestId: message.requestId,
          accepted: true,
          protocolVersion: nativeMessagingProtocolVersion,
          helperVersion: '0.0.11',
          capabilities: nativeMessagingCapabilities,
          error: null,
        });
      };
    }

    vi.stubGlobal('chrome', {
      runtime: {
        id: 'webmirror-test-extension',
        lastError: undefined,
        getManifest: () => ({ version: '0.0.12' }),
        connectNative: vi.fn(() => ports.shift() as unknown as chrome.runtime.Port),
      },
    });
    const client = new NativeHostClient();

    await expect(client.connectCurrentVersion()).rejects.toThrow(
      'requires Helper v0.0.12, but Helper v0.0.11 is installed',
    );
    expect(firstPort.disconnect).toHaveBeenCalledOnce();
    expect(secondPort.disconnect).toHaveBeenCalledOnce();
  });

  it('keeps a long mirror request alive while the matching job reports progress', async () => {
    vi.useFakeTimers();
    const port = new FakeNativePort();
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'webmirror-test-extension',
        lastError: undefined,
        getManifest: () => ({ version: '0.0.27' }),
        connectNative: vi.fn(() => port as unknown as chrome.runtime.Port),
      },
    });
    const client = new NativeHostClient();
    const create = client.createMirror('long-job', {
      sourceUrl: 'https://example.com/',
      capturedAt: '2026-01-01T00:00:00.000Z',
      resources: [{ sourceUrl: 'https://example.com/', method: 'GET' }],
      warnings: [],
    });
    const handshake = handshakeRequest(port);
    port.onMessage.emit({
      type: 'handshake_result',
      requestId: handshake.requestId,
      accepted: true,
      protocolVersion: nativeMessagingProtocolVersion,
      helperVersion: '0.0.27',
      capabilities: nativeMessagingCapabilities,
      error: null,
    });

    for (
      let attempt = 0;
      attempt < 100 &&
      !(port.postedMessages as Array<Record<string, unknown>>).some(
        (message) => message.type === 'mirror_create',
      );
      attempt += 1
    ) {
      await Promise.resolve();
    }

    const mirrorRequest = (port.postedMessages as Array<Record<string, unknown>>).find(
      (message) => message.type === 'mirror_create',
    );

    if (!mirrorRequest) {
      throw new Error('Expected a mirror_create request.');
    }

    let settled = false;
    void create.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    port.onMessage.emit({
      type: 'mirror_progress',
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: 'long-job',
      state: 'downloading',
      discoveredResources: 1_500,
      completedResources: 1_491,
      downloadedBytes: 496_625_823,
      warningCount: 8,
      elapsedMs: 9 * 60_000,
      message: 'Downloaded 1491 of 1500 resources.',
    });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(settled).toBe(false);

    port.onMessage.emit({
      type: 'mirror_result',
      requestId: mirrorRequest.requestId,
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: 'long-job',
      success: true,
      result: {
        status: 'partial',
        outputDirectory: 'C:\\WebMirror\\long-job',
        entryUrl: 'http://127.0.0.1:41000/',
        manifestPath: 'C:\\WebMirror\\long-job\\mirror.json',
        totalResources: 1_500,
        downloadedResources: 1_491,
        failedResources: 9,
        downloadedBytes: 496_625_823,
        warningCount: 8,
        elapsedMs: 11 * 60_000,
        onlineDependencies: [],
      },
      error: null,
    });

    await expect(create).resolves.toMatchObject({
      status: 'partial',
      downloadedResources: 1_491,
    });
  });

  it('does not refresh a mirror timeout from another job progress event', async () => {
    vi.useFakeTimers();
    const port = new FakeNativePort();
    port.responder = (message, respondingPort) => {
      if (message.type !== 'mirror_cancel') {
        return;
      }

      respondingPort.onMessage.emit({
        type: 'mirror_cancel_result',
        requestId: message.requestId,
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: message.jobId,
        accepted: true,
        error: null,
      });
    };
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'webmirror-test-extension',
        lastError: undefined,
        getManifest: () => ({ version: '0.0.27' }),
        connectNative: vi.fn(() => port as unknown as chrome.runtime.Port),
      },
    });
    const client = new NativeHostClient();
    const create = client.createMirror('stalled-job', {
      sourceUrl: 'https://example.com/',
      capturedAt: '2026-01-01T00:00:00.000Z',
      resources: [{ sourceUrl: 'https://example.com/', method: 'GET' }],
      warnings: [],
    });
    const handshake = handshakeRequest(port);
    port.onMessage.emit({
      type: 'handshake_result',
      requestId: handshake.requestId,
      accepted: true,
      protocolVersion: nativeMessagingProtocolVersion,
      helperVersion: '0.0.27',
      capabilities: nativeMessagingCapabilities,
      error: null,
    });

    for (
      let attempt = 0;
      attempt < 100 &&
      !(port.postedMessages as Array<Record<string, unknown>>).some(
        (message) => message.type === 'mirror_create',
      );
      attempt += 1
    ) {
      await Promise.resolve();
    }

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    port.onMessage.emit({
      type: 'mirror_progress',
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: 'another-job',
      state: 'downloading',
      discoveredResources: 1,
      completedResources: 1,
      downloadedBytes: 1,
      warningCount: 0,
      elapsedMs: 9 * 60_000,
      message: 'Unrelated progress.',
    });
    const expectation = expect(create).rejects.toThrow(
      'reported no progress for 600 seconds while handling mirror_create.',
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await expectation;
    expect(
      (port.postedMessages as Array<Record<string, unknown>>).filter(
        (message) => message.type === 'mirror_cancel' && message.jobId === 'stalled-job',
      ),
    ).toHaveLength(1);
  });

  it('ignores matching progress emitted by a stale Native Messaging port', async () => {
    vi.useFakeTimers();
    const stalePort = new FakeNativePort();
    const currentPort = new FakeNativePort();
    const ports = [stalePort, currentPort];
    currentPort.responder = (message, respondingPort) => {
      if (message.type !== 'mirror_cancel') {
        return;
      }

      respondingPort.onMessage.emit({
        type: 'mirror_cancel_result',
        requestId: message.requestId,
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: message.jobId,
        accepted: true,
        error: null,
      });
    };
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'webmirror-test-extension',
        lastError: undefined,
        getManifest: () => ({ version: '0.0.27' }),
        connectNative: vi.fn(() => ports.shift() as unknown as chrome.runtime.Port),
      },
    });
    const client = new NativeHostClient();
    const staleConnection = client.connect();
    const staleHandshake = handshakeRequest(stalePort);
    stalePort.onMessage.emit({
      type: 'handshake_result',
      requestId: staleHandshake.requestId,
      accepted: false,
      protocolVersion: nativeMessagingProtocolVersion,
      helperVersion: '0.0.27',
      capabilities: [],
      error: {
        code: 'UNSUPPORTED_PROTOCOL_VERSION',
        message: 'Stale port rejected.',
      },
    });
    await expect(staleConnection).rejects.toThrow('Stale port rejected.');

    const create = client.createMirror('reused-job', {
      sourceUrl: 'https://example.com/',
      capturedAt: '2026-01-01T00:00:00.000Z',
      resources: [{ sourceUrl: 'https://example.com/', method: 'GET' }],
      warnings: [],
    });
    const currentHandshake = handshakeRequest(currentPort);
    currentPort.onMessage.emit({
      type: 'handshake_result',
      requestId: currentHandshake.requestId,
      accepted: true,
      protocolVersion: nativeMessagingProtocolVersion,
      helperVersion: '0.0.27',
      capabilities: nativeMessagingCapabilities,
      error: null,
    });

    for (
      let attempt = 0;
      attempt < 100 &&
      !(currentPort.postedMessages as Array<Record<string, unknown>>).some(
        (message) => message.type === 'mirror_create',
      );
      attempt += 1
    ) {
      await Promise.resolve();
    }

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    stalePort.onMessage.emit({
      type: 'mirror_progress',
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: 'reused-job',
      state: 'downloading',
      discoveredResources: 1,
      completedResources: 1,
      downloadedBytes: 1,
      warningCount: 0,
      elapsedMs: 9 * 60_000,
      message: 'Late stale progress.',
    });
    const expectation = expect(create).rejects.toThrow(
      'reported no progress for 600 seconds while handling mirror_create.',
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await expectation;
  });

  it('ignores a delayed disconnect from a stale failed port', async () => {
    const firstPort = new FakeNativePort();
    const secondPort = new FakeNativePort();
    const ports = [firstPort, secondPort];
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'webmirror-test-extension',
        lastError: undefined,
        getManifest: () => ({ version: '0.0.1' }),
        connectNative: vi.fn(() => ports.shift() as unknown as chrome.runtime.Port),
      },
    });
    const client = new NativeHostClient();
    const firstConnection = client.connect();
    const firstHandshake = handshakeRequest(firstPort);
    firstPort.onMessage.emit({
      type: 'handshake_result',
      requestId: firstHandshake.requestId,
      accepted: false,
      protocolVersion: nativeMessagingProtocolVersion,
      helperVersion: '0.0.1',
      capabilities: [],
      error: {
        code: 'UNSUPPORTED_PROTOCOL_VERSION',
        message: 'Unsupported test protocol.',
      },
    });

    await expect(firstConnection).rejects.toThrow('Unsupported test protocol.');
    expect(firstPort.disconnect).toHaveBeenCalledOnce();

    const secondConnection = client.connect();
    const secondHandshake = handshakeRequest(secondPort);
    secondPort.onMessage.emit({
      type: 'handshake_result',
      requestId: secondHandshake.requestId,
      accepted: true,
      protocolVersion: nativeMessagingProtocolVersion,
      helperVersion: '0.0.2',
      capabilities: nativeMessagingCapabilities,
      error: null,
    });

    await expect(secondConnection).resolves.toMatchObject({
      helperVersion: '0.0.2',
    });
    firstPort.onDisconnect.emit();
    expect(client.info).toMatchObject({
      helperVersion: '0.0.2',
    });
  });

  it('uploads referenced response bodies in bounded sequential chunks before mirror creation', async () => {
    const port = new FakeNativePort();
    port.responder = (message, respondingPort) => {
      const requestId = message.requestId as string;

      switch (message.type) {
        case 'handshake':
          respondingPort.onMessage.emit({
            type: 'handshake_result',
            requestId,
            accepted: true,
            protocolVersion: nativeMessagingProtocolVersion,
            helperVersion: '0.0.2',
            capabilities: nativeMessagingCapabilities,
            error: null,
          });
          break;
        case 'resource_body_start':
          respondingPort.onMessage.emit({
            type: 'resource_body_result',
            requestId,
            protocolVersion: nativeMessagingProtocolVersion,
            jobId: message.jobId,
            bodyId: message.bodyId,
            stage: 'start',
            accepted: true,
            nextOffset: 0,
            complete: false,
            error: null,
          });
          break;
        case 'resource_body_chunk':
          respondingPort.onMessage.emit({
            type: 'resource_body_result',
            requestId,
            protocolVersion: nativeMessagingProtocolVersion,
            jobId: message.jobId,
            bodyId: message.bodyId,
            stage: 'chunk',
            accepted: true,
            nextOffset: Number(message.offset) + atob(String(message.data)).length,
            complete: false,
            error: null,
          });
          break;
        case 'resource_body_end':
          respondingPort.onMessage.emit({
            type: 'resource_body_result',
            requestId,
            protocolVersion: nativeMessagingProtocolVersion,
            jobId: message.jobId,
            bodyId: message.bodyId,
            stage: 'end',
            accepted: true,
            nextOffset: message.byteLength,
            complete: true,
            error: null,
          });
          break;
        case 'mirror_create':
          respondingPort.onMessage.emit({
            type: 'mirror_result',
            requestId,
            protocolVersion: nativeMessagingProtocolVersion,
            jobId: message.jobId,
            success: true,
            result: {
              status: 'complete',
              outputDirectory: 'C:\\WebMirror\\job-1',
              entryUrl: 'http://127.0.0.1:41000/index.html',
              manifestPath: 'C:\\WebMirror\\job-1\\mirror.json',
              totalResources: 1,
              downloadedResources: 1,
              failedResources: 0,
              downloadedBytes: 1,
              warningCount: 0,
              elapsedMs: 1,
              onlineDependencies: [],
            },
            error: null,
          });
          break;
      }
    };
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'webmirror-test-extension',
        lastError: undefined,
        getManifest: () => ({ version: '0.0.2' }),
        connectNative: vi.fn(() => port as unknown as chrome.runtime.Port),
      },
    });
    const bodyBytes = new Uint8Array(nativeResourceBodyChunkBytes * 2 + 17);
    bodyBytes.fill(0x5a);
    const body: CapturedResponseBody = {
      descriptor: {
        id: 'body-1',
        byteLength: bodyBytes.byteLength,
        sha256: 'a'.repeat(64),
        source: 'network',
        reuseScope: 'same_origin',
        contentType: 'application/octet-stream',
        httpStatus: 200,
      } as CapturedResponseBody['descriptor'],
      bytes: bodyBytes,
    };
    const client = new NativeHostClient();

    await expect(
      client.createMirror(
        'job-1',
        {
          sourceUrl: 'https://example.com/',
          capturedAt: '2026-01-01T00:00:00.000Z',
          resources: [
            {
              sourceUrl: 'https://example.com/asset.bin',
              method: 'GET',
              bodyId: 'body-1',
              expectedSize: bodyBytes.byteLength,
            },
          ],
          warnings: [],
        },
        [body],
      ),
    ).resolves.toMatchObject({
      status: 'complete',
    });

    const messages = port.postedMessages as Array<Record<string, unknown>>;
    expect(messages.map((message) => message.type)).toEqual([
      'handshake',
      'resource_body_start',
      'resource_body_chunk',
      'resource_body_chunk',
      'resource_body_chunk',
      'resource_body_end',
      'mirror_create',
    ]);
    const chunks = messages.filter((message) => message.type === 'resource_body_chunk');
    expect(messages.find((message) => message.type === 'resource_body_start')).toMatchObject({
      sourceUrl: 'https://example.com/asset.bin',
      sourceOrigin: 'https://example.com/',
    });
    expect(messages.find((message) => message.type === 'resource_body_start')).not.toHaveProperty(
      'reuseScope',
    );
    expect(messages.find((message) => message.type === 'resource_body_start')).not.toHaveProperty(
      'headers',
    );
    expect(chunks.map((chunk) => chunk.offset)).toEqual([
      0,
      nativeResourceBodyChunkBytes,
      nativeResourceBodyChunkBytes * 2,
    ]);

    for (const chunk of chunks) {
      expect(atob(String(chunk.data)).length).toBeLessThanOrEqual(nativeResourceBodyChunkBytes);
      expect(new TextEncoder().encode(JSON.stringify(chunk)).byteLength).toBeLessThan(
        nativeMessagingMaxMessageBytes,
      );
    }
  });

  it('uploads a public HTTPS cross-origin body only when the helper advertises support', async () => {
    const port = new FakeNativePort();
    port.responder = (message, respondingPort) => {
      const requestId = message.requestId as string;

      if (message.type === 'handshake') {
        respondingPort.onMessage.emit({
          type: 'handshake_result',
          requestId,
          accepted: true,
          protocolVersion: nativeMessagingProtocolVersion,
          helperVersion: '0.0.2',
          capabilities: nativeMessagingCapabilities,
          error: null,
        });
      } else if (message.type === 'resource_body_start') {
        respondingPort.onMessage.emit({
          type: 'resource_body_result',
          requestId,
          protocolVersion: nativeMessagingProtocolVersion,
          jobId: message.jobId,
          bodyId: message.bodyId,
          stage: 'start',
          accepted: true,
          nextOffset: 0,
          complete: false,
          error: null,
        });
      } else if (message.type === 'resource_body_chunk') {
        respondingPort.onMessage.emit({
          type: 'resource_body_result',
          requestId,
          protocolVersion: nativeMessagingProtocolVersion,
          jobId: message.jobId,
          bodyId: message.bodyId,
          stage: 'chunk',
          accepted: true,
          nextOffset: Number(message.offset) + atob(String(message.data)).length,
          complete: false,
          error: null,
        });
      } else if (message.type === 'resource_body_end') {
        respondingPort.onMessage.emit({
          type: 'resource_body_result',
          requestId,
          protocolVersion: nativeMessagingProtocolVersion,
          jobId: message.jobId,
          bodyId: message.bodyId,
          stage: 'end',
          accepted: true,
          nextOffset: message.byteLength,
          complete: true,
          error: null,
        });
      } else if (message.type === 'mirror_create') {
        respondingPort.onMessage.emit({
          type: 'mirror_result',
          requestId,
          protocolVersion: nativeMessagingProtocolVersion,
          jobId: message.jobId,
          success: true,
          result: {
            status: 'complete',
            outputDirectory: 'C:\\WebMirror\\public-job',
            manifestPath: 'C:\\WebMirror\\public-job\\mirror.json',
            totalResources: 1,
            downloadedResources: 1,
            failedResources: 0,
            downloadedBytes: 3,
            warningCount: 0,
            elapsedMs: 1,
            onlineDependencies: [],
          },
          error: null,
        });
      }
    };
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'webmirror-test-extension',
        lastError: undefined,
        getManifest: () => ({ version: '0.0.2' }),
        connectNative: vi.fn(() => port as unknown as chrome.runtime.Port),
      },
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const client = new NativeHostClient();

    await expect(
      client.createMirror(
        'public-job',
        {
          sourceUrl: 'https://example.com/',
          capturedAt: '2026-01-01T00:00:00.000Z',
          resources: [
            {
              sourceUrl: 'https://cdn.example.net/asset.bin',
              method: 'GET',
              bodyId: 'public-body',
              expectedSize: bytes.byteLength,
            },
          ],
          warnings: [],
        },
        [
          {
            descriptor: {
              id: 'public-body',
              byteLength: bytes.byteLength,
              sha256: 'c'.repeat(64),
              source: 'network',
              reuseScope: 'public_cross_origin',
              contentType: 'application/octet-stream',
              httpStatus: 200,
            } as CapturedResponseBody['descriptor'],
            bytes,
          },
        ],
      ),
    ).resolves.toMatchObject({ status: 'complete' });

    expect(
      (port.postedMessages as Array<Record<string, unknown>>).find(
        (message) => message.type === 'resource_body_start',
      ),
    ).toMatchObject({
      sourceUrl: 'https://cdn.example.net/asset.bin',
      sourceOrigin: 'https://example.com/',
      reuseScope: 'public_cross_origin',
    });
  });

  it('requires a helper upgrade before uploading public cross-origin bodies', async () => {
    const port = new FakeNativePort();
    port.responder = (message, respondingPort) => {
      if (message.type !== 'handshake') {
        return;
      }

      respondingPort.onMessage.emit({
        type: 'handshake_result',
        requestId: message.requestId,
        accepted: true,
        protocolVersion: nativeMessagingProtocolVersion,
        helperVersion: '0.0.1',
        capabilities: nativeMessagingCapabilities.filter(
          (capability) => capability !== 'public-cross-origin-body-v1',
        ),
        error: null,
      });
    };
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'webmirror-test-extension',
        lastError: undefined,
        getManifest: () => ({ version: '0.0.1' }),
        connectNative: vi.fn(() => port as unknown as chrome.runtime.Port),
      },
    });
    const bytes = new Uint8Array([1]);
    const client = new NativeHostClient();

    await expect(
      client.createMirror(
        'upgrade-job',
        {
          sourceUrl: 'https://example.com/',
          capturedAt: '2026-01-01T00:00:00.000Z',
          resources: [
            {
              sourceUrl: 'https://cdn.example.net/asset.bin',
              method: 'GET',
              bodyId: 'public-body',
            },
          ],
          warnings: [],
        },
        [
          {
            descriptor: {
              id: 'public-body',
              byteLength: bytes.byteLength,
              sha256: 'd'.repeat(64),
              source: 'network',
              reuseScope: 'public_cross_origin',
              contentType: 'application/octet-stream',
              httpStatus: 200,
            } as CapturedResponseBody['descriptor'],
            bytes,
          },
        ],
      ),
    ).rejects.toThrow('Upgrade the WebMirror helper');
    expect(
      (port.postedMessages as Array<Record<string, unknown>>).map((message) => message.type),
    ).toEqual(['handshake']);
  });

  it('requires a helper upgrade before sending a rendering capability profile', async () => {
    const port = new FakeNativePort();
    port.responder = (message, respondingPort) => {
      if (message.type !== 'handshake') {
        return;
      }

      respondingPort.onMessage.emit({
        type: 'handshake_result',
        requestId: message.requestId,
        accepted: true,
        protocolVersion: nativeMessagingProtocolVersion,
        helperVersion: '0.0.1',
        capabilities: nativeMessagingCapabilities.filter(
          (capability) => capability !== 'runtime-capability-profile-v1',
        ),
        error: null,
      });
    };
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'webmirror-test-extension',
        lastError: undefined,
        getManifest: () => ({ version: '0.0.1' }),
        connectNative: vi.fn(() => port as unknown as chrome.runtime.Port),
      },
    });
    const client = new NativeHostClient();

    await expect(
      client.createMirror('capability-profile-job', {
        sourceUrl: 'https://example.com/',
        capturedAt: '2026-01-01T00:00:00.000Z',
        runtimeCapabilities: {
          webgl: { compressedTextureFamilies: ['s3tc'] },
          webgl2: { compressedTextureFamilies: [] },
        },
        resources: [
          {
            sourceUrl: 'https://example.com/',
            method: 'GET',
          },
        ],
        warnings: [],
      }),
    ).rejects.toThrow('Upgrade the WebMirror helper');
    expect(
      (port.postedMessages as Array<Record<string, unknown>>).map((message) => message.type),
    ).toEqual(['handshake']);
  });

  it('stops body upload and never creates a mirror after cancellation', async () => {
    const port = new FakeNativePort();
    let pendingChunk: Record<string, unknown> | undefined;
    port.responder = (message, respondingPort) => {
      const requestId = message.requestId as string;

      if (message.type === 'handshake') {
        respondingPort.onMessage.emit({
          type: 'handshake_result',
          requestId,
          accepted: true,
          protocolVersion: nativeMessagingProtocolVersion,
          helperVersion: '0.0.2',
          capabilities: nativeMessagingCapabilities,
          error: null,
        });
      } else if (message.type === 'resource_body_start') {
        respondingPort.onMessage.emit({
          type: 'resource_body_result',
          requestId,
          protocolVersion: nativeMessagingProtocolVersion,
          jobId: message.jobId,
          bodyId: message.bodyId,
          stage: 'start',
          accepted: true,
          nextOffset: 0,
          complete: false,
          error: null,
        });
      } else if (message.type === 'resource_body_chunk') {
        pendingChunk = message;
      } else if (message.type === 'mirror_cancel') {
        respondingPort.onMessage.emit({
          type: 'mirror_cancel_result',
          requestId,
          protocolVersion: nativeMessagingProtocolVersion,
          jobId: message.jobId,
          accepted: true,
          error: null,
        });
      }
    };
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'webmirror-test-extension',
        lastError: undefined,
        getManifest: () => ({ version: '0.0.2' }),
        connectNative: vi.fn(() => port as unknown as chrome.runtime.Port),
      },
    });
    const bytes = new Uint8Array(nativeResourceBodyChunkBytes + 1);
    bytes.fill(0x41);
    const client = new NativeHostClient();
    const create = client.createMirror(
      'cancel-job',
      {
        sourceUrl: 'https://example.com/',
        capturedAt: '2026-01-01T00:00:00.000Z',
        resources: [
          {
            sourceUrl: 'https://example.com/private.bin',
            method: 'GET',
            bodyId: 'cancel-body',
            expectedSize: bytes.byteLength,
          },
        ],
        warnings: [],
      },
      [
        {
          descriptor: {
            id: 'cancel-body',
            byteLength: bytes.byteLength,
            sha256: 'b'.repeat(64),
            source: 'network',
            reuseScope: 'same_origin',
            contentType: 'application/octet-stream',
            httpStatus: 200,
          } as CapturedResponseBody['descriptor'],
          bytes,
        },
      ],
    );

    for (let attempt = 0; attempt < 100 && !pendingChunk; attempt += 1) {
      await Promise.resolve();
    }

    if (!pendingChunk) {
      throw new Error('Expected the first response-body chunk.');
    }

    await expect(client.cancel('cancel-job')).resolves.toBe(true);
    port.onMessage.emit({
      type: 'resource_body_result',
      requestId: pendingChunk.requestId,
      protocolVersion: nativeMessagingProtocolVersion,
      jobId: pendingChunk.jobId,
      bodyId: pendingChunk.bodyId,
      stage: 'chunk',
      accepted: true,
      nextOffset: Number(pendingChunk.offset) + atob(String(pendingChunk.data)).length,
      complete: false,
      error: null,
    });

    await expect(create).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(
      (port.postedMessages as Array<Record<string, unknown>>).some(
        (message) => message.type === 'mirror_create',
      ),
    ).toBe(false);
  });
});
