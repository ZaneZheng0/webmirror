import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nativeResourceBodyMaxBytes } from '@webmirror/shared';

import { CaptureController } from './capture-controller.js';

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

type CommandHandler = (
  target: chrome.debugger.DebuggerSession,
  method: string,
  commandParameters: Record<string, unknown>,
) => Promise<Record<string, unknown> | undefined>;

function createChrome(
  storageSet: (items: Record<string, unknown>) => Promise<void>,
  commandHandler?: CommandHandler,
) {
  const onEvent = new FakeChromeEvent<
    [chrome.debugger.DebuggerSession, string, object | undefined]
  >();
  const onDetach = new FakeChromeEvent<[chrome.debugger.DebuggerSession, string]>();
  const sendCommand = vi.fn(
    async (
      target: chrome.debugger.DebuggerSession,
      method: string,
      commandParameters: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> => {
      const override = await commandHandler?.(target, method, commandParameters);

      if (override !== undefined) {
        return override;
      }

      if (method === 'Runtime.evaluate') {
        return {
          result: {
            value: {
              title: 'Capture fixture',
              url: 'https://example.test/',
              userAgent: 'Chrome/150.0.0.0',
              viewport: {
                width: 1280,
                height: 720,
                deviceScaleFactor: 1,
              },
              preflight: {
                origin: 'https://example.test',
                canvasElements: 0,
                iframeElements: 1,
                mediaElements: 0,
                serviceWorkerControlled: false,
                observedResourceCount: 0,
                observedTransferBytes: 0,
                workerResourceHints: 0,
                webglResourceHints: 0,
                wasmResourceHints: 0,
              },
            },
          },
        };
      }

      return {};
    },
  );
  const detach = vi.fn(async () => undefined);
  const chromeValue = {
    debugger: {
      onEvent,
      onDetach,
      attach: vi.fn(async () => undefined),
      detach,
      sendCommand,
    },
    tabs: {
      get: vi.fn(async () => ({
        id: 7,
        url: 'https://example.test/',
        title: 'Capture fixture',
      })),
    },
    storage: {
      local: {
        set: vi.fn(storageSet),
      },
    },
  };
  vi.stubGlobal('chrome', chromeValue);
  return {
    chromeValue,
    onEvent,
    detach,
    sendCommand,
    storageSet: chromeValue.storage.local.set,
  };
}

async function waitForCommand(
  sendCommand: ReturnType<typeof vi.fn>,
  method: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (sendCommand.mock.calls.some((call) => call[1] === method)) {
      return;
    }

    await Promise.resolve();
  }

  throw new Error(`Timed out waiting for CDP command ${method}.`);
}

async function waitForCommandCompletion(
  sendCommand: ReturnType<typeof vi.fn>,
  method: string,
): Promise<void> {
  await waitForCommand(sendCommand, method);
  const index = sendCommand.mock.calls.findIndex((call) => call[1] === method);
  const result = index >= 0 ? sendCommand.mock.results[index] : undefined;

  if (result?.type === 'return') {
    await result.value;
  }

  await flushMicrotasks();
}

async function flushMicrotasks(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function stubDeterministicCrypto(): void {
  let nextId = 0;
  vi.stubGlobal('crypto', {
    randomUUID: () => `test-id-${nextId++}`,
    subtle: {
      digest: async () => new Uint8Array(32).buffer,
    },
  });
}

function observeReloadedRootDocument(
  onEvent: FakeChromeEvent<[chrome.debugger.DebuggerSession, string, object | undefined]>,
): void {
  onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
    requestId: 'root-document-marker',
    type: 'Document',
    request: {
      url: 'https://example.test/',
      method: 'GET',
    },
  });
  onEvent.emit({ tabId: 7 }, 'Network.loadingFailed', {
    requestId: 'root-document-marker',
    errorText: 'Synthetic unit-test document marker',
    canceled: true,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CaptureController', () => {
  it('captures a bounded WebGL rendering capability profile', async () => {
    let returnedIdentity = false;
    const { onEvent, sendCommand } = createChrome(
      async () => undefined,
      async (_target, method) => {
        if (method !== 'Runtime.evaluate' || returnedIdentity) {
          return undefined;
        }

        returnedIdentity = true;
        return {
          result: {
            value: {
              title: 'Capability fixture',
              url: 'https://example.test/',
              userAgent: 'Chrome/150.0.0.0',
              viewport: {
                width: 1280,
                height: 720,
                deviceScaleFactor: 1,
              },
              runtimeCapabilities: {
                webgl: {
                  extensions: [
                    'WEBGL_compressed_texture_astc',
                    'WEBGL_compressed_texture_s3tc',
                    'WEBGL_compressed_texture_s3tc',
                    'untrusted_extension',
                  ],
                },
                webgl2: {
                  extensions: ['WEBGL_compressed_texture_etc'],
                },
              },
              preflight: {
                origin: 'https://example.test',
                canvasElements: 0,
                iframeElements: 0,
                mediaElements: 0,
                serviceWorkerControlled: false,
                observedResourceCount: 0,
                observedTransferBytes: 0,
                workerResourceHints: 0,
                webglResourceHints: 0,
                wasmResourceHints: 0,
              },
            },
          },
        };
      },
    );
    const controller = new CaptureController();
    const capture = controller.start(7);
    await waitForCommand(sendCommand, 'Page.reload');
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;

    expect(result.manifest.runtimeCapabilities).toEqual({
      webgl: {
        compressedTextureFamilies: ['astc', 's3tc'],
      },
      webgl2: {
        compressedTextureFamilies: ['etc'],
      },
    });
  });

  it('seeds safe static resources that completed before debugger attachment', async () => {
    let returnedIdentity = false;
    const { onEvent, sendCommand } = createChrome(
      async () => undefined,
      async (_target, method, commandParameters) => {
        if (
          method !== 'Runtime.evaluate' ||
          returnedIdentity ||
          !String(commandParameters.expression).includes('performance.getEntriesByType')
        ) {
          return undefined;
        }

        returnedIdentity = true;
        return {
          result: {
            value: {
              title: 'Historical resource fixture',
              url: 'https://example.test/',
              userAgent: 'Chrome/150.0.0.0',
              viewport: {
                width: 1280,
                height: 720,
                deviceScaleFactor: 1,
              },
              preflight: {
                origin: 'https://example.test',
                canvasElements: 0,
                iframeElements: 0,
                mediaElements: 0,
                serviceWorkerControlled: false,
                observedResourceCount: 11,
                observedTransferBytes: 8192,
                workerResourceHints: 0,
                webglResourceHints: 0,
                wasmResourceHints: 0,
                observedResources: [
                  {
                    url: 'https://cdn.example.test/environments/studio.hdr',
                    initiatorType: 'fetch',
                  },
                  {
                    url: 'https://cdn.example.test/models/scene.gltf#ignored-fragment',
                    initiatorType: 'xmlhttprequest',
                  },
                  {
                    url: 'https://cdn.example.test/animations/intro.json?v=2',
                    initiatorType: 'fetch',
                  },
                  {
                    url: 'https://cdn.example.test/features/runtime.js',
                    initiatorType: 'script',
                  },
                  {
                    url: 'https://cdn.example.test/features/runtime.js',
                    initiatorType: 'script',
                  },
                  {
                    url: 'https://cdn.example.test/api/config.json',
                    initiatorType: 'fetch',
                  },
                  {
                    url: 'https://cdn.example.test/%61uth/session.js',
                    initiatorType: 'script',
                  },
                  {
                    url: 'https://cdn.example.test/assets/config.json?access_token=secret',
                    initiatorType: 'fetch',
                  },
                  {
                    url: 'https://www.google-analytics.com/analytics.js',
                    initiatorType: 'script',
                  },
                  {
                    url: 'blob:https://example.test/not-downloadable',
                    initiatorType: 'fetch',
                  },
                  {
                    url: 'https://example.test/favicon.ico',
                    initiatorType: 'other',
                  },
                ],
              },
            },
          },
        };
      },
    );
    const controller = new CaptureController();
    const capture = controller.start(7);
    await waitForCommand(sendCommand, 'Page.reload');
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;
    const historicalResources = result.manifest.resources.filter(
      (resource) => resource.request.initiatorType === 'performance',
    );

    expect(historicalResources).toEqual([
      expect.objectContaining({
        state: 'discovered',
        request: expect.objectContaining({
          url: 'https://cdn.example.test/environments/studio.hdr',
          method: 'GET',
          headers: {},
          resourceType: 'Fetch',
          initiatorType: 'performance',
        }),
      }),
      expect.objectContaining({
        request: expect.objectContaining({
          url: 'https://cdn.example.test/models/scene.gltf',
          resourceType: 'Fetch',
        }),
      }),
      expect.objectContaining({
        request: expect.objectContaining({
          url: 'https://cdn.example.test/animations/intro.json?v=2',
          resourceType: 'Fetch',
        }),
      }),
      expect.objectContaining({
        request: expect.objectContaining({
          url: 'https://cdn.example.test/features/runtime.js',
          resourceType: 'Script',
        }),
      }),
    ]);
    expect(result.manifest.preflight.observedResourceCount).toBe(11);
  });

  it('filters only the implicit default favicon request', async () => {
    const { onEvent, sendCommand } = createChrome(async () => undefined);
    const controller = new CaptureController();
    const capture = controller.start(7);
    await waitForCommand(sendCommand, 'Page.reload');

    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'implicit-favicon',
      type: 'Other',
      initiator: { type: 'other' },
      request: {
        url: 'https://example.test/favicon.ico',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.loadingFailed', {
      requestId: 'implicit-favicon',
      errorText: 'net::ERR_FAILED',
    });
    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'linked-favicon',
      type: 'Other',
      initiator: { type: 'parser' },
      request: {
        url: 'https://example.test/favicon.ico?theme=dark',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.loadingFailed', {
      requestId: 'linked-favicon',
      errorText: 'Synthetic linked favicon failure',
    });
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;
    const capturedUrls = result.manifest.resources.map((resource) => resource.request.url);

    expect(capturedUrls).not.toContain('https://example.test/favicon.ico');
    expect(capturedUrls).toContain('https://example.test/favicon.ico?theme=dark');
  });

  it('does not let confirmed telemetry requests hold the capture open', async () => {
    const { onEvent, sendCommand } = createChrome(async () => undefined);
    const controller = new CaptureController();
    let settled = false;
    const capture = controller.start(7).finally(() => {
      settled = true;
    });
    await waitForCommand(sendCommand, 'Page.reload');
    observeReloadedRootDocument(onEvent);

    for (const [requestId, type, url, method] of [
      [
        'google-collect',
        'Fetch',
        'https://www.google.com/g/collect?v=2&tid=G-TEST&en=page_view',
        'POST',
      ],
      ['snap-pixel', 'Document', 'https://tr.snapchat.com/cm/i?pid=public-test-id', 'GET'],
    ] as const) {
      onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
        requestId,
        type,
        request: {
          url,
          method,
        },
      });
    }

    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'application-request',
      type: 'Fetch',
      request: {
        url: 'https://api.example.test/bootstrap',
        method: 'GET',
      },
    });
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(settled).toBe(false);

    onEvent.emit({ tabId: 7 }, 'Network.loadingFailed', {
      requestId: 'application-request',
      errorText: 'Synthetic unit-test completion',
      canceled: true,
    });
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;
    const capturedUrls = result.manifest.resources.map((resource) => resource.request.url);

    expect(result.manifest.completionReason).toBe('network_idle');
    expect(capturedUrls).toContain('https://api.example.test/bootstrap');
    expect(capturedUrls).not.toContain(
      'https://www.google.com/g/collect?v=2&tid=G-TEST&en=page_view',
    );
    expect(capturedUrls).not.toContain('https://tr.snapchat.com/cm/i?pid=public-test-id');
  });

  it('does not let unfinished Worker-session requests hold the root capture open', async () => {
    const { onEvent, sendCommand } = createChrome(async () => undefined);
    const controller = new CaptureController();
    const capture = controller.start(7);
    await waitForCommand(sendCommand, 'Page.reload');
    onEvent.emit({ tabId: 7 }, 'Target.attachedToTarget', {
      sessionId: 'runtime-worker',
      targetInfo: {
        type: 'worker',
        url: 'https://example.test/runtime-worker.js',
      },
      waitingForDebugger: true,
    });
    await waitForCommandCompletion(sendCommand, 'Runtime.runIfWaitingForDebugger');
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7, sessionId: 'runtime-worker' }, 'Network.requestWillBeSent', {
      requestId: 'deferred-worker-request',
      type: 'Script',
      request: {
        url: 'https://example.test/nested-worker.js',
        method: 'GET',
      },
    });
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;

    expect(result.manifest.completionReason).toBe('network_idle');
    expect(result.manifest.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'discovered',
          request: expect.objectContaining({
            url: 'https://example.test/nested-worker.js',
            workerContext: true,
          }),
        }),
      ]),
    );
  });

  it('keeps capture open while bounded scrolling discovers deferred runtime resources', async () => {
    let resolveExploration: (value: Record<string, unknown>) => void = () => undefined;
    const exploration = new Promise<Record<string, unknown>>((resolve) => {
      resolveExploration = resolve;
    });
    let runtimeEvaluationCount = 0;
    const { onEvent, sendCommand } = createChrome(
      async () => undefined,
      async (_target, method, commandParameters) => {
        if (method !== 'Runtime.evaluate') {
          return undefined;
        }

        runtimeEvaluationCount += 1;

        if (runtimeEvaluationCount === 1) {
          return undefined;
        }

        expect(String(commandParameters.expression)).toContain(
          '__webmirrorDeferredResourceExploration',
        );
        expect(commandParameters).toMatchObject({
          awaitPromise: true,
          returnByValue: true,
        });
        return exploration;
      },
    );
    const controller = new CaptureController();
    let settled = false;
    const capture = controller.start(7).finally(() => {
      settled = true;
    });
    await waitForCommand(sendCommand, 'Page.reload');
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(settled).toBe(false);

    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'deferred-font',
      type: 'Fetch',
      request: {
        url: 'https://cdn.example.net/runtime/deferred-font.bin',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'deferred-font',
      type: 'Fetch',
      response: {
        url: 'https://cdn.example.net/runtime/deferred-font.bin',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/octet-stream',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.loadingFinished', {
      requestId: 'deferred-font',
      encodedDataLength: 128,
    });
    resolveExploration({
      result: {
        value: {
          checkpointCount: 8,
          maximumGapViewports: 1,
          heightExpanded: false,
          restored: true,
        },
      },
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;

    expect(result.manifest.completionReason).toBe('network_idle');
    expect(result.manifest.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          request: expect.objectContaining({
            url: 'https://cdn.example.net/runtime/deferred-font.bin',
          }),
        }),
      ]),
    );
  });

  it('reports bounded exploration gaps and growing infinite-scroll documents', async () => {
    let runtimeEvaluationCount = 0;
    const { onEvent, sendCommand } = createChrome(
      async () => undefined,
      async (_target, method) => {
        if (method !== 'Runtime.evaluate') {
          return undefined;
        }

        runtimeEvaluationCount += 1;

        return runtimeEvaluationCount === 1
          ? undefined
          : {
              result: {
                value: {
                  checkpointCount: 16,
                  maximumGapViewports: 3.25,
                  heightExpanded: true,
                  restored: true,
                },
              },
            };
      },
    );
    const controller = new CaptureController();
    const capture = controller.start(7);
    await waitForCommand(sendCommand, 'Page.reload');
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;

    expect(result.manifest.warnings.join(' ')).toContain('sampled gaps reached 3.3 viewport');
    expect(result.manifest.warnings.join(' ')).toContain('infinite-scroll content');
  });

  it('can complete from DOMContentLoaded when media prevents the load event', async () => {
    const { onEvent, sendCommand } = createChrome(async () => undefined);
    const controller = new CaptureController();
    const capture = controller.start(7);
    await waitForCommand(sendCommand, 'Page.reload');
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.domContentEventFired', {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);

    await expect(capture).resolves.toMatchObject({
      manifest: {
        completionReason: 'network_idle',
      },
    });
  });

  it('waits for the root page load instead of completing on a child frame load', async () => {
    const { onEvent, sendCommand } = createChrome(async () => undefined);
    const controller = new CaptureController();
    let settled = false;
    const capture = controller.start(7).finally(() => {
      settled = true;
    });
    await waitForCommand(sendCommand, 'Page.reload');
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Page.reload',
      expect.objectContaining({ ignoreCache: true }),
    );
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'Network.setCacheDisabled', {
      cacheDisabled: true,
    });

    onEvent.emit({ tabId: 7, sessionId: 'child-frame' }, 'Page.loadEventFired', {});
    await vi.advanceTimersByTimeAsync(2_100);
    expect(settled).toBe(false);

    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await vi.advanceTimersByTimeAsync(2_100);
    await expect(capture).resolves.toMatchObject({
      manifest: {
        completionReason: 'network_idle',
      },
    });
  });

  it('ignores a stale root load event until the reloaded document is observed', async () => {
    const { onEvent, sendCommand } = createChrome(async () => undefined);
    const controller = new CaptureController();
    let settled = false;
    const capture = controller.start(7).finally(() => {
      settled = true;
    });
    await waitForCommand(sendCommand, 'Page.reload');

    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await vi.advanceTimersByTimeAsync(2_100);
    expect(settled).toBe(false);

    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await vi.advanceTimersByTimeAsync(2_100);
    await expect(capture).resolves.toMatchObject({
      manifest: {
        sourceUrl: 'https://example.test/',
        completionReason: 'network_idle',
      },
    });
  });

  it('keeps Canvas and WebGL captures open through the extended warmup window', async () => {
    const { onEvent, sendCommand } = createChrome(
      async () => undefined,
      async (_target, method) => {
        if (method !== 'Runtime.evaluate') {
          return undefined;
        }

        return {
          result: {
            value: {
              title: 'WebGL fixture',
              url: 'https://example.test/',
              userAgent: 'Chrome/150.0.0.0',
              viewport: {
                width: 1280,
                height: 720,
                deviceScaleFactor: 1,
              },
              preflight: {
                origin: 'https://example.test',
                canvasElements: 1,
                webglResourceHints: 1,
              },
            },
          },
        };
      },
    );
    const controller = new CaptureController();
    let settled = false;
    const capture = controller.start(7).finally(() => {
      settled = true;
    });
    await waitForCommand(sendCommand, 'Page.reload');
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});

    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(capture).resolves.toMatchObject({
      manifest: {
        completionReason: 'network_idle',
      },
    });
  });

  it('retains interactive resources that start after the first ten seconds of quiet', async () => {
    const { onEvent, sendCommand } = createChrome(
      async () => undefined,
      async (_target, method) => {
        if (method !== 'Runtime.evaluate') {
          return undefined;
        }

        return {
          result: {
            value: {
              title: 'Delayed interactive fixture',
              url: 'https://example.test/',
              userAgent: 'Chrome/150.0.0.0',
              viewport: {
                width: 1280,
                height: 720,
                deviceScaleFactor: 1,
              },
              preflight: {
                origin: 'https://example.test',
                canvasElements: 1,
                webglResourceHints: 1,
              },
            },
          },
        };
      },
    );
    const controller = new CaptureController();
    let settled = false;
    const capture = controller.start(7).finally(() => {
      settled = true;
    });
    await waitForCommand(sendCommand, 'Page.reload');
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});

    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toBe(false);

    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'late-scene',
      type: 'XHR',
      request: {
        url: 'https://example.test/assets/scene.glb',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'late-scene',
      type: 'XHR',
      response: {
        url: 'https://example.test/assets/scene.glb',
        status: 200,
        statusText: 'OK',
        mimeType: 'model/gltf-binary',
        headers: {
          'content-type': 'model/gltf-binary',
        },
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.loadingFinished', {
      requestId: 'late-scene',
      encodedDataLength: 2048,
    });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_001);
    const result = await capture;

    expect(result.manifest.completionReason).toBe('network_idle');
    expect(result.manifest.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'complete',
          request: expect.objectContaining({
            url: 'https://example.test/assets/scene.glb',
          }),
        }),
      ]),
    );
  });

  it('does not let a blob URL without a terminal event block capture completion', async () => {
    const { onEvent, sendCommand } = createChrome(async () => undefined);
    const controller = new CaptureController();
    const capture = controller.start(7);
    await waitForCommand(sendCommand, 'Page.reload');
    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'blob-script',
      type: 'Script',
      request: {
        url: 'blob:https://example.test/runtime-script',
        method: 'GET',
      },
    });
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await vi.advanceTimersByTimeAsync(2_100);

    await expect(capture).resolves.toMatchObject({
      manifest: {
        completionReason: 'network_idle',
      },
    });
  });

  it('records streaming media without waiting for the full response body', async () => {
    const { onEvent, sendCommand } = createChrome(async () => undefined);
    const controller = new CaptureController();
    const capture = controller.start(7);
    await waitForCommand(sendCommand, 'Page.reload');
    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'streaming-video',
      type: 'Media',
      request: {
        url: 'https://example.test/media/loop.mp4',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'streaming-video',
      type: 'Media',
      response: {
        url: 'https://example.test/media/loop.mp4',
        status: 206,
        statusText: 'Partial Content',
        mimeType: 'video/mp4',
      },
    });
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;
    const nonDocumentResources = result.manifest.resources.filter(
      (resource) => resource.request.resourceType !== 'Document',
    );

    expect(result.manifest.completionReason).toBe('network_idle');
    expect(nonDocumentResources).toEqual([
      expect.objectContaining({
        state: 'response',
        request: expect.objectContaining({
          resourceType: 'Media',
          url: 'https://example.test/media/loop.mp4',
        }),
      }),
    ]);
    expect(sendCommand.mock.calls.some((call) => call[1] === 'Network.getResponseBody')).toBe(
      false,
    );
  });

  it('does not let known nonessential social embeds block capture completion', async () => {
    const { onEvent, sendCommand } = createChrome(async () => undefined);
    const controller = new CaptureController();
    const capture = controller.start(7);
    await waitForCommand(sendCommand, 'Page.reload');

    for (const [requestId, url] of [
      ['facebook-sdk', 'https://connect.facebook.net/en_US/sdk.js'],
      ['twitter-widget', 'https://platform.twitter.com/widgets.js'],
      ['google-plus', 'https://apis.google.com/js/platform.js'],
    ] as const) {
      onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
        requestId,
        type: 'Script',
        request: {
          url,
          method: 'GET',
        },
      });
    }

    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await vi.advanceTimersByTimeAsync(2_100);

    const result = await capture;
    expect(result.manifest.completionReason).toBe('network_idle');
    expect(
      result.manifest.resources.filter((resource) => resource.request.resourceType !== 'Document'),
    ).toEqual([]);
  });

  it('times out a stale child target instead of blocking capture completion', async () => {
    const never = new Promise<Record<string, unknown>>(() => undefined);
    const { onEvent, sendCommand } = createChrome(
      async () => undefined,
      async (target, method) =>
        target.sessionId === 'stale-worker' && method === 'Runtime.enable' ? never : undefined,
    );
    const controller = new CaptureController();
    const capture = controller.start(7);
    let settled = false;
    void capture.finally(() => {
      settled = true;
    });
    await waitForCommand(sendCommand, 'Page.reload');
    onEvent.emit({ tabId: 7 }, 'Target.attachedToTarget', {
      sessionId: 'stale-worker',
      targetInfo: {
        type: 'worker',
        url: 'blob:https://example.test/stale-worker',
      },
      waitingForDebugger: false,
    });
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});

    await vi.advanceTimersByTimeAsync(2_999);
    await flushMicrotasks();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;

    expect(result.manifest.completionReason).toBe('network_idle');
    expect(result.manifest.warnings.join(' ')).toContain(
      'Unable to initialize worker target blob:https://example.test/stale-worker',
    );
  });

  it('filters browser translation resources without filtering ordinary Google runtime assets', async () => {
    const { onEvent, sendCommand } = createChrome(async () => undefined);
    const controller = new CaptureController();
    const capture = controller.start(7);
    await waitForCommand(sendCommand, 'Page.reload');

    for (const [requestId, url] of [
      [
        'translate-runtime',
        'https://translate.googleapis.com/_/translate_http/_/js/k=translate_http.tr.en_US.js',
      ],
      [
        'translate-style',
        'https://www.gstatic.com/_/translate_http/_/ss/k=translate_http.tr.Y.css',
      ],
      ['translate-log', 'https://www.google.com/gen204?client=te_lib&logld=vTE_20260318'],
    ] as const) {
      onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
        requestId,
        type: 'Script',
        request: {
          url,
          method: 'GET',
        },
      });
    }

    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'draco-runtime',
      type: 'Script',
      request: {
        url: 'https://www.gstatic.com/draco/v1/decoders/draco_decoder.js',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'draco-runtime',
      type: 'Script',
      response: {
        url: 'https://www.gstatic.com/draco/v1/decoders/draco_decoder.js',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/javascript',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.loadingFinished', {
      requestId: 'draco-runtime',
      encodedDataLength: 64,
    });
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;
    const nonDocumentResources = result.manifest.resources.filter(
      (resource) => resource.request.resourceType !== 'Document',
    );

    expect(nonDocumentResources).toHaveLength(1);
    expect(nonDocumentResources[0]?.request.url).toBe(
      'https://www.gstatic.com/draco/v1/decoders/draco_decoder.js',
    );
    expect(JSON.stringify(result.manifest)).not.toContain('translate_http');
    expect(JSON.stringify(result.manifest)).not.toContain('client=te_lib');
  });

  it('detaches and rejects cleanly when capture persistence fails', async () => {
    const { onEvent, detach, sendCommand } = createChrome(async () => {
      throw new Error('storage quota exceeded');
    });
    const controller = new CaptureController();
    const capture = controller.start(7);
    const rejectedCapture = expect(capture).rejects.toThrow(
      'Could not persist the capture manifest',
    );
    await waitForCommand(sendCommand, 'Page.reload');
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await vi.advanceTimersByTimeAsync(2_100);

    await rejectedCapture;
    expect(detach).toHaveBeenCalledWith({ tabId: 7 });
  });

  it('waits for a response body before completion and persists no body bytes', async () => {
    stubDeterministicCrypto();
    let resolveBody: (value: Record<string, unknown>) => void = () => undefined;
    const bodyResponse = new Promise<Record<string, unknown>>((resolve) => {
      resolveBody = resolve;
    });
    const { onEvent, sendCommand, storageSet } = createChrome(
      async () => undefined,
      async (_target, method) => {
        if (method === 'Network.getResponseBody') {
          return bodyResponse;
        }

        return undefined;
      },
    );
    const controller = new CaptureController();
    let settled = false;
    const capture = controller.start(7).finally(() => {
      settled = true;
    });
    await waitForCommand(sendCommand, 'Page.reload');
    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'root-request',
      type: 'Script',
      request: {
        url: 'https://example.test/private.js',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'root-request',
      type: 'Script',
      response: {
        url: 'https://example.test/private.js',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/javascript',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.loadingFinished', {
      requestId: 'root-request',
      encodedDataLength: 21,
    });
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(settled).toBe(false);
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'Network.getResponseBody', {
      requestId: 'root-request',
    });

    const privateBody = 'window.privateReady=1;';
    resolveBody({
      body: btoa(privateBody),
      base64Encoded: true,
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;

    expect(new TextDecoder().decode(result.bodies[0]?.bytes)).toBe(privateBody);
    expect(result.manifest.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({
            source: 'network',
            byteLength: new TextEncoder().encode(privateBody).byteLength,
          }),
        }),
      ]),
    );
    expect(JSON.stringify(storageSet.mock.calls)).not.toContain(privateBody);
    expect(JSON.stringify(storageSet.mock.calls)).not.toContain(btoa(privateBody));
  });

  it('rejects an empty CDP body when the response declares non-empty content', async () => {
    stubDeterministicCrypto();
    const { onEvent, sendCommand } = createChrome(
      async () => undefined,
      async (_target, method) =>
        method === 'Network.getResponseBody'
          ? {
              body: '',
              base64Encoded: true,
            }
          : undefined,
    );
    const controller = new CaptureController();
    const capture = controller.start(7, { jobId: 'empty-cdp-body-job' });
    await waitForCommand(sendCommand, 'Page.reload');
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'texture',
      type: 'Image',
      request: {
        url: 'https://example.test/texture.png',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'texture',
      type: 'Image',
      response: {
        url: 'https://example.test/texture.png',
        status: 200,
        statusText: 'OK',
        mimeType: 'image/png',
        headers: {
          'Content-Length': '4096',
          'Content-Type': 'image/png',
        },
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.loadingFinished', {
      requestId: 'texture',
      encodedDataLength: 4200,
    });
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;
    const texture = result.manifest.resources.find(
      (resource) => resource.request.url === 'https://example.test/texture.png',
    );

    expect(result.bodies).toEqual([]);
    expect(texture).toMatchObject({
      state: 'complete',
      encodedDataLength: 4200,
    });
    expect(texture?.body).toBeUndefined();
    expect(result.manifest.warnings).toContain(
      'Browser response-body read failed for https://example.test/texture.png: Captured response body is empty despite Content-Length 4096.',
    );
  });

  it('rejects an empty CDP body when encoded response bytes prove it was non-empty', async () => {
    stubDeterministicCrypto();
    const { onEvent, sendCommand } = createChrome(
      async () => undefined,
      async (_target, method) =>
        method === 'Network.getResponseBody'
          ? {
              body: '',
              base64Encoded: false,
            }
          : undefined,
    );
    const controller = new CaptureController();
    const capture = controller.start(7, { jobId: 'empty-streamed-cdp-body-job' });
    await waitForCommand(sendCommand, 'Page.reload');
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'runtime-script',
      type: 'Script',
      request: {
        url: 'https://example.test/runtime.js',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'runtime-script',
      type: 'Script',
      response: {
        url: 'https://example.test/runtime.js',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/javascript',
        headers: {
          'Content-Type': 'application/javascript',
          'Transfer-Encoding': 'chunked',
        },
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.loadingFinished', {
      requestId: 'runtime-script',
      encodedDataLength: 8192,
    });
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;
    const runtime = result.manifest.resources.find(
      (resource) => resource.request.url === 'https://example.test/runtime.js',
    );

    expect(result.bodies).toEqual([]);
    expect(runtime?.body).toBeUndefined();
    expect(result.manifest.warnings).toContain(
      'Browser response-body read failed for https://example.test/runtime.js: Captured response body is empty after 8192 encoded response bytes were observed.',
    );
  });

  it('keeps waiting beyond the ordinary command bound for the root document body', async () => {
    stubDeterministicCrypto();
    let resolveBody: (value: Record<string, unknown>) => void = () => undefined;
    const bodyResponse = new Promise<Record<string, unknown>>((resolve) => {
      resolveBody = resolve;
    });
    const { onEvent, sendCommand } = createChrome(
      async () => undefined,
      async (_target, method) => (method === 'Network.getResponseBody' ? bodyResponse : undefined),
    );
    const controller = new CaptureController();
    let settled = false;
    const capture = controller.start(7).finally(() => {
      settled = true;
    });
    await waitForCommand(sendCommand, 'Page.reload');
    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'root-document',
      type: 'Document',
      request: {
        url: 'https://example.test/',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'root-document',
      type: 'Document',
      response: {
        url: 'https://example.test/',
        status: 200,
        statusText: 'OK',
        mimeType: 'text/html',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.loadingFinished', {
      requestId: 'root-document',
      encodedDataLength: 64,
    });
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});

    await vi.advanceTimersByTimeAsync(3_100);
    await flushMicrotasks();
    expect(settled).toBe(false);

    const html = '<!doctype html><html><body>ready</body></html>';
    resolveBody({ body: btoa(html), base64Encoded: true });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;

    expect(new TextDecoder().decode(result.bodies[0]?.bytes)).toBe(html);
    expect(result.manifest.warnings.join(' ')).not.toContain('response-body read failed');
  });

  it('reads a child response body through the matching CDP session', async () => {
    stubDeterministicCrypto();
    const childBody = 'self.childReady=true;';
    const { onEvent, sendCommand } = createChrome(
      async () => undefined,
      async (_target, method) =>
        method === 'Network.getResponseBody'
          ? {
              body: btoa(childBody),
              base64Encoded: true,
            }
          : undefined,
    );
    const controller = new CaptureController();
    const capture = controller.start(7, { jobId: 'child-job' });
    await waitForCommand(sendCommand, 'Page.reload');
    onEvent.emit({ tabId: 7 }, 'Target.attachedToTarget', {
      sessionId: 'child-worker',
      targetInfo: {
        type: 'worker',
        url: 'https://example.test/worker.js',
      },
      waitingForDebugger: true,
    });
    await waitForCommandCompletion(sendCommand, 'Runtime.runIfWaitingForDebugger');
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7, sessionId: 'child-worker' },
      'Network.setCacheDisabled',
      { cacheDisabled: true },
    );
    onEvent.emit({ tabId: 7, sessionId: 'child-worker' }, 'Network.requestWillBeSent', {
      requestId: 'child-request',
      type: 'Script',
      request: {
        url: 'https://example.test/worker.js',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7, sessionId: 'child-worker' }, 'Network.responseReceived', {
      requestId: 'child-request',
      type: 'Script',
      response: {
        url: 'https://example.test/worker.js',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/javascript',
      },
    });
    onEvent.emit({ tabId: 7, sessionId: 'child-worker' }, 'Network.loadingFinished', {
      requestId: 'child-request',
      encodedDataLength: childBody.length,
    });
    await waitForCommand(sendCommand, 'Network.getResponseBody');
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7, sessionId: 'child-worker' },
      'Network.getResponseBody',
      { requestId: 'child-request' },
    );
    await flushMicrotasks();
    await controller.cancel('child-job');
    const result = await capture;

    expect(new TextDecoder().decode(result.bodies[0]?.bytes)).toBe(childBody);
    expect(result.manifest.resources[0]).toMatchObject({
      sessionId: 'child-worker',
      request: {
        workerContext: true,
      },
      body: {
        source: 'network',
      },
    });
  });

  it('does not reuse a body across CDP sessions when the URL is identical', async () => {
    stubDeterministicCrypto();
    const { onEvent, sendCommand } = createChrome(
      async () => undefined,
      async (target, method) =>
        method === 'Network.getResponseBody'
          ? {
              body: btoa(target.sessionId ? 'child-version' : 'root-version'),
              base64Encoded: true,
            }
          : undefined,
    );
    const controller = new CaptureController();
    const capture = controller.start(7, { jobId: 'same-url-job' });
    await waitForCommand(sendCommand, 'Page.reload');

    for (const [sessionId, requestId] of [
      [undefined, 'root-shared'],
      ['child-session', 'child-shared'],
    ] as const) {
      onEvent.emit(
        sessionId === undefined ? { tabId: 7 } : { tabId: 7, sessionId },
        'Network.requestWillBeSent',
        {
          requestId,
          type: 'Script',
          request: {
            url: 'https://example.test/shared.js',
            method: 'GET',
          },
        },
      );
      onEvent.emit(
        sessionId === undefined ? { tabId: 7 } : { tabId: 7, sessionId },
        'Network.responseReceived',
        {
          requestId,
          type: 'Script',
          response: {
            url: 'https://example.test/shared.js',
            status: 200,
            statusText: 'OK',
            mimeType: 'application/javascript',
          },
        },
      );
      onEvent.emit(
        sessionId === undefined ? { tabId: 7 } : { tabId: 7, sessionId },
        'Network.loadingFinished',
        {
          requestId,
          encodedDataLength: 32,
        },
      );
    }

    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;

    expect(result.bodies).toHaveLength(2);
    expect(result.bodies.map((body) => new TextDecoder().decode(body.bytes)).sort()).toEqual([
      'child-version',
      'root-version',
    ]);
  });

  it('captures a public cross-origin static body only after privacy evidence arrives', async () => {
    stubDeterministicCrypto();
    const publicBody = 'window.publicAssetReady=true;';
    const { onEvent, sendCommand } = createChrome(
      async () => undefined,
      async (_target, method) =>
        method === 'Network.getResponseBody'
          ? {
              body: btoa(publicBody),
              base64Encoded: true,
            }
          : undefined,
    );
    const controller = new CaptureController();
    const capture = controller.start(7, { jobId: 'public-cross-origin-job' });
    await waitForCommand(sendCommand, 'Page.reload');

    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'public-cdn',
      type: 'Script',
      request: {
        url: 'https://cdn.example.net/app.js',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSentExtraInfo', {
      requestId: 'public-cdn',
      headers: {
        Referer: 'https://example.test/',
      },
      associatedCookies: [],
    });
    onEvent.emit({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'public-cdn',
      type: 'Script',
      response: {
        url: 'https://cdn.example.net/app.js',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/javascript',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.responseReceivedExtraInfo', {
      requestId: 'public-cdn',
      statusCode: 200,
      headers: {
        'Cache-Control': 'public, max-age=3600',
        Vary: 'Accept-Encoding',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.loadingFinished', {
      requestId: 'public-cdn',
      encodedDataLength: publicBody.length,
    });
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;

    expect(new TextDecoder().decode(result.bodies[0]?.bytes)).toBe(publicBody);
    expect(result.manifest.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          request: expect.objectContaining({
            url: 'https://cdn.example.net/app.js',
          }),
          body: expect.objectContaining({
            reuseScope: 'public_cross_origin',
          }),
        }),
      ]),
    );
  });

  it('captures an explicit public CORS body when CDP does not emit extra-info events', async () => {
    stubDeterministicCrypto();
    const publicBody = 'window.publicCorsAssetReady=true;';
    const { onEvent, sendCommand } = createChrome(
      async () => undefined,
      async (_target, method) =>
        method === 'Network.getResponseBody'
          ? {
              body: btoa(publicBody),
              base64Encoded: true,
            }
          : undefined,
    );
    const controller = new CaptureController();
    const capture = controller.start(7, { jobId: 'public-cors-without-extra-info-job' });
    await waitForCommand(sendCommand, 'Page.reload');

    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'public-cors-cdn',
      type: 'Fetch',
      request: {
        url: 'https://cdn.example.net/models/helmet.glb',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'public-cors-cdn',
      type: 'Fetch',
      response: {
        url: 'https://cdn.example.net/models/helmet.glb',
        status: 200,
        statusText: 'OK',
        mimeType: 'model/gltf-binary',
        headers: {
          'Access-Control-Allow-Origin': 'https://example.test',
          'Cache-Control': 'public, max-age=86400',
          'Content-Type': 'model/gltf-binary',
        },
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.loadingFinished', {
      requestId: 'public-cors-cdn',
      encodedDataLength: publicBody.length,
    });
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;

    expect(new TextDecoder().decode(result.bodies[0]?.bytes)).toBe(publicBody);
    expect(result.manifest.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          request: expect.objectContaining({
            url: 'https://cdn.example.net/models/helmet.glb',
          }),
          body: expect.objectContaining({
            reuseScope: 'public_cross_origin',
          }),
        }),
      ]),
    );
  });

  it('fails closed for credentialed, private, request-data, and insecure cross-origin bodies', async () => {
    const { onEvent, sendCommand, storageSet } = createChrome(async () => undefined);
    const controller = new CaptureController();
    const capture = controller.start(7, { jobId: 'unsafe-cross-origin-job' });
    await waitForCommand(sendCommand, 'Page.reload');
    const cases = [
      {
        requestId: 'missing-extra-info',
        url: 'https://cdn.example.net/missing.js',
        type: 'Script',
      },
      {
        requestId: 'cookie',
        url: 'https://cdn.example.net/cookie.js',
        type: 'Script',
        requestHeaders: { Cookie: 'session=cross-origin-secret' },
        responseHeaders: {},
      },
      {
        requestId: 'authorization',
        url: 'https://cdn.example.net/authorization.js',
        type: 'Script',
        requestHeaders: { Authorization: 'Bearer cross-origin-secret' },
        responseHeaders: {},
      },
      {
        requestId: 'set-cookie',
        url: 'https://cdn.example.net/set-cookie.js',
        type: 'Script',
        requestHeaders: {},
        responseHeaders: { 'Set-Cookie': 'session=cross-origin-secret' },
      },
      {
        requestId: 'private-cache',
        url: 'https://cdn.example.net/private.js',
        type: 'Script',
        requestHeaders: {},
        responseHeaders: { 'Cache-Control': 'private' },
      },
      {
        requestId: 'vary-cookie',
        url: 'https://cdn.example.net/vary.js',
        type: 'Script',
        requestHeaders: {},
        responseHeaders: { Vary: 'Cookie' },
      },
      {
        requestId: 'xhr',
        url: 'https://cdn.example.net/private.json',
        type: 'XHR',
        requestHeaders: {},
        responseHeaders: {},
      },
      {
        requestId: 'insecure-http',
        url: 'http://cdn.example.net/app.js',
        type: 'Script',
        requestHeaders: {},
        responseHeaders: {},
      },
      {
        requestId: 'signed-query',
        url: 'https://cdn.example.net/app.js?X-Amz-Signature=cross-origin-secret',
        type: 'Script',
        requestHeaders: {},
        responseHeaders: {},
      },
      {
        requestId: 'disk-cache',
        url: 'https://cdn.example.net/cached.js',
        type: 'Script',
        requestHeaders: {},
        responseHeaders: {},
        fromDiskCache: true,
      },
      {
        requestId: 'cached-304',
        url: 'https://cdn.example.net/revalidated.js',
        type: 'Script',
        requestHeaders: {},
        responseHeaders: {},
        extraStatusCode: 304,
      },
      {
        requestId: 'blocked-cookie',
        url: 'https://cdn.example.net/blocked-cookie.js',
        type: 'Script',
        requestHeaders: {},
        responseHeaders: {},
        blockedCookies: [{}],
      },
    ] as const;

    for (const item of cases) {
      onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
        requestId: item.requestId,
        type: item.type,
        request: {
          url: item.url,
          method: 'GET',
        },
      });

      if ('requestHeaders' in item) {
        onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSentExtraInfo', {
          requestId: item.requestId,
          headers: item.requestHeaders,
          associatedCookies: [],
        });
      }

      onEvent.emit({ tabId: 7 }, 'Network.responseReceived', {
        requestId: item.requestId,
        type: item.type,
        response: {
          url: item.url,
          status: 200,
          statusText: 'OK',
          mimeType: item.type === 'XHR' ? 'application/json' : 'application/javascript',
          ...('fromDiskCache' in item ? { fromDiskCache: item.fromDiskCache } : {}),
        },
      });

      if ('responseHeaders' in item) {
        onEvent.emit({ tabId: 7 }, 'Network.responseReceivedExtraInfo', {
          requestId: item.requestId,
          statusCode: 'extraStatusCode' in item ? item.extraStatusCode : 200,
          headers: item.responseHeaders,
          ...('blockedCookies' in item ? { blockedCookies: item.blockedCookies } : {}),
        });
      }

      onEvent.emit({ tabId: 7 }, 'Network.loadingFinished', {
        requestId: item.requestId,
        encodedDataLength: 32,
      });
    }

    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;

    expect(result.bodies).toEqual([]);
    expect(sendCommand.mock.calls.some((call) => call[1] === 'Network.getResponseBody')).toBe(
      false,
    );
    expect(JSON.stringify(storageSet.mock.calls)).not.toContain('cross-origin-secret');
  });

  it('cancels a capture while a response-body command is hanging', async () => {
    stubDeterministicCrypto();
    let resolveBody: (() => void) | undefined;
    const hangingBody = new Promise<Record<string, unknown>>((resolve) => {
      resolveBody = () => resolve({ body: btoa('late'), base64Encoded: true });
    });
    const { onEvent, sendCommand } = createChrome(
      async () => undefined,
      async (_target, method) => (method === 'Network.getResponseBody' ? hangingBody : undefined),
    );
    const controller = new CaptureController();
    const capture = controller.start(7, { jobId: 'hanging-body-job' });
    await waitForCommand(sendCommand, 'Page.reload');
    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'hanging',
      type: 'Script',
      request: {
        url: 'https://example.test/hanging.js',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'hanging',
      type: 'Script',
      response: {
        url: 'https://example.test/hanging.js',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/javascript',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.loadingFinished', {
      requestId: 'hanging',
      encodedDataLength: 5,
    });
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);

    expect(await controller.cancel('hanging-body-job')).toBe(true);
    await expect(capture).resolves.toMatchObject({
      manifest: {
        completionReason: 'cancelled',
      },
    });
    expect(resolveBody).toBeDefined();
  });

  it('finishes queued response-body reads after the discovery duration expires', async () => {
    stubDeterministicCrypto();
    let resolveBody: (value: Record<string, unknown>) => void = () => undefined;
    const bodyResponse = new Promise<Record<string, unknown>>((resolve) => {
      resolveBody = resolve;
    });
    const { onEvent, sendCommand } = createChrome(
      async () => undefined,
      async (_target, method) => (method === 'Network.getResponseBody' ? bodyResponse : undefined),
    );
    const controller = new CaptureController();
    let settled = false;
    const capture = controller.start(7, { jobId: 'maximum-duration-body-job' }).finally(() => {
      settled = true;
    });
    await waitForCommand(sendCommand, 'Page.reload');
    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'late-static-script',
      type: 'Script',
      request: {
        url: 'https://example.test/late-static-script.js',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'late-static-script',
      type: 'Script',
      response: {
        url: 'https://example.test/late-static-script.js',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/javascript',
      },
    });

    await vi.advanceTimersByTimeAsync(29_999);
    onEvent.emit({ tabId: 7 }, 'Network.loadingFinished', {
      requestId: 'late-static-script',
      encodedDataLength: 24,
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);

    const body = 'window.lateStaticScript=true;';
    resolveBody({
      body: btoa(body),
      base64Encoded: true,
    });
    await flushMicrotasks();
    const result = await capture;

    expect(result.manifest.completionReason).toBe('maximum_duration');
    expect(new TextDecoder().decode(result.bodies[0]?.bytes)).toBe(body);
  });

  it('does not capture private or request-data response bodies', async () => {
    const { onEvent, sendCommand } = createChrome(async () => undefined);
    const controller = new CaptureController();
    const capture = controller.start(7);
    await waitForCommand(sendCommand, 'Page.reload');

    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'private-xhr',
      type: 'XHR',
      request: {
        url: 'https://example.test/private.json',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'private-xhr',
      type: 'XHR',
      response: {
        url: 'https://example.test/private.json',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/json',
        headers: {
          'Cache-Control': 'private',
        },
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.loadingFinished', {
      requestId: 'private-xhr',
      encodedDataLength: 32,
    });
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;

    expect(result.bodies).toEqual([]);
    expect(sendCommand.mock.calls.some((call) => call[1] === 'Network.getResponseBody')).toBe(
      false,
    );
  });

  it('skips response body reads above the per-resource limit', async () => {
    const { onEvent, sendCommand } = createChrome(async () => undefined);
    const controller = new CaptureController();
    const capture = controller.start(7);
    await waitForCommand(sendCommand, 'Page.reload');
    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'oversized',
      type: 'Image',
      request: {
        url: 'https://example.test/large.bin',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'oversized',
      type: 'Image',
      response: {
        url: 'https://example.test/large.bin',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/octet-stream',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.loadingFinished', {
      requestId: 'oversized',
      encodedDataLength: nativeResourceBodyMaxBytes + 1,
    });
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;

    expect(result.bodies).toEqual([]);
    expect(result.manifest.warnings.join(' ')).toContain('20 MB');
    expect(sendCommand.mock.calls.some((call) => call[1] === 'Network.getResponseBody')).toBe(
      false,
    );
  });

  it('uses a read-only CacheStorage body fallback for an observed GET URL', async () => {
    const cachedBody = 'self.cachedReady=true;';
    const { onEvent, sendCommand } = createChrome(
      async () => undefined,
      async (_target, method) => {
        switch (method) {
          case 'Runtime.evaluate':
            return {
              result: {
                value: {
                  title: 'Cache fixture',
                  url: 'https://example.test/',
                  userAgent: 'Chrome/150.0.0.0',
                  viewport: {
                    width: 1280,
                    height: 720,
                    deviceScaleFactor: 1,
                  },
                  preflight: {
                    origin: 'https://example.test',
                    serviceWorkerControlled: true,
                  },
                },
              },
            };
          case 'Network.getResponseBody':
            throw new Error('No resource with given identifier found');
          case 'CacheStorage.requestCacheNames':
            return {
              caches: [{ cacheId: 'cache-1' }],
            };
          case 'CacheStorage.requestEntries':
            return {
              cacheDataEntries: [
                {
                  requestURL: 'https://example.test/cached-worker.js',
                  requestMethod: 'GET',
                  responseStatus: 200,
                  responseHeaders: [
                    {
                      name: 'content-type',
                      value: 'application/javascript',
                    },
                  ],
                },
                {
                  requestURL: 'https://example.test/cookie-variant.js',
                  requestMethod: 'GET',
                  responseStatus: 200,
                  responseHeaders: [
                    {
                      name: 'content-type',
                      value: 'application/javascript',
                    },
                    {
                      name: 'vary',
                      value: 'Cookie',
                    },
                  ],
                },
              ],
              returnCount: 2,
            };
          case 'CacheStorage.requestCachedResponse':
            return {
              response: {
                body: btoa(cachedBody),
              },
            };
          default:
            return undefined;
        }
      },
    );
    const controller = new CaptureController();
    const capture = controller.start(7);
    await waitForCommand(sendCommand, 'Page.reload');
    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'cached',
      type: 'Script',
      request: {
        url: 'https://example.test/cached-worker.js',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'cached',
      type: 'Script',
      response: {
        url: 'https://example.test/cached-worker.js',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/javascript',
        fromServiceWorker: true,
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.loadingFinished', {
      requestId: 'cached',
      encodedDataLength: cachedBody.length,
    });
    onEvent.emit({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'variant',
      type: 'Script',
      request: {
        url: 'https://example.test/cookie-variant.js',
        method: 'GET',
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'variant',
      type: 'Script',
      response: {
        url: 'https://example.test/cookie-variant.js',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/javascript',
        fromServiceWorker: true,
      },
    });
    onEvent.emit({ tabId: 7 }, 'Network.loadingFinished', {
      requestId: 'variant',
      encodedDataLength: 16,
    });
    observeReloadedRootDocument(onEvent);
    onEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await capture;

    expect(new TextDecoder().decode(result.bodies[0]?.bytes)).toBe(cachedBody);
    expect(result.manifest.resources[0]?.body).toMatchObject({
      source: 'cache_storage',
      contentType: 'application/javascript',
    });
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'CacheStorage.requestCachedResponse', {
      cacheId: 'cache-1',
      requestURL: 'https://example.test/cached-worker.js',
      requestHeaders: [],
    });
    expect(sendCommand).not.toHaveBeenCalledWith(
      { tabId: 7 },
      'CacheStorage.requestCachedResponse',
      expect.objectContaining({
        requestURL: 'https://example.test/cookie-variant.js',
      }),
    );
  });
});
