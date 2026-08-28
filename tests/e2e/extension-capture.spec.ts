import { chromium, expect, test, type BrowserContext, type Worker } from '@playwright/test';
import { resolve } from 'node:path';

interface StoredCapture {
  lastCaptureJobId?: string;
  lastCaptureError?: {
    message: string;
  };
  manifest?: {
    completionReason: string;
    preflight: {
      origin: string;
      canvasElements: number;
      iframeElements: number;
      observedResourceCount: number;
      observedTransferBytes: number;
      serviceWorkerControlled: boolean;
    };
    resources: Array<{
      request: {
        headers: Record<string, string>;
        url: string;
      };
      state: string;
    }>;
    sourceUrl: string;
  };
}

interface CaptureResponse {
  ok: boolean;
  jobId?: string;
  resourceCount?: number;
  error?: string;
}

async function waitForExtensionServiceWorker(context: BrowserContext): Promise<Worker> {
  const existingWorker = context.serviceWorkers()[0];
  return existingWorker ?? context.waitForEvent('serviceworker');
}

async function readStoredCapture(serviceWorker: Worker): Promise<StoredCapture> {
  return serviceWorker.evaluate(async (): Promise<StoredCapture> => {
    const storage = await chrome.storage.local.get(['lastCaptureJobId', 'lastCaptureError']);
    const jobId =
      typeof storage.lastCaptureJobId === 'string' ? storage.lastCaptureJobId : undefined;
    const storedManifest = jobId ? await chrome.storage.local.get(`capture:${jobId}`) : {};
    const manifest = jobId ? storedManifest[`capture:${jobId}`] : undefined;
    const captureError = storage.lastCaptureError;

    return {
      ...(jobId ? { lastCaptureJobId: jobId } : {}),
      ...(captureError &&
      typeof captureError === 'object' &&
      'message' in captureError &&
      typeof captureError.message === 'string'
        ? {
            lastCaptureError: {
              message: captureError.message,
            },
          }
        : {}),
      ...(manifest && typeof manifest === 'object'
        ? {
            manifest: manifest as StoredCapture['manifest'],
          }
        : {}),
    };
  });
}

test('captures the deterministic static fixture through chrome.debugger', async () => {
  const extensionPath = resolve('apps/extension/dist');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });

  try {
    const serviceWorker = await waitForExtensionServiceWorker(context);
    const extensionId = new URL(serviceWorker.url()).host;
    const targetPage = await context.newPage();
    await targetPage.goto('http://127.0.0.1:4178/basic/');
    await expect(targetPage).toHaveTitle('WebMirror Basic Fixture');
    await targetPage.bringToFront();

    let targetTabId: number | undefined;
    await expect
      .poll(
        async () => {
          targetTabId = await serviceWorker.evaluate(async (): Promise<number | undefined> => {
            const [activeTab] = await chrome.tabs.query({
              active: true,
              currentWindow: true,
            });
            return activeTab?.id;
          });
          return targetTabId;
        },
        {
          message: 'waiting for the fixture tab to become active',
        },
      )
      .toEqual(expect.any(Number));

    if (targetTabId === undefined) {
      throw new Error('The fixture tab does not expose an id.');
    }

    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.clear();
    });
    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/popup.html`);
    const untrustedExtensionPage = await context.newPage();
    await untrustedExtensionPage.goto(`chrome-extension://${extensionId}/manifest.json`);
    const rejectedCapture = await untrustedExtensionPage.evaluate(
      async (tabId): Promise<CaptureResponse> =>
        chrome.runtime.sendMessage({
          type: 'webmirror.capture.requested',
          tabId,
        }),
      targetTabId,
    );
    expect(rejectedCapture).toMatchObject({
      ok: false,
      error: expect.stringContaining('WebMirror popup'),
    });
    await untrustedExtensionPage.close();
    await targetPage.bringToFront();
    await expect
      .poll(() =>
        serviceWorker.evaluate(async (): Promise<number | undefined> => {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          return activeTab?.id;
        }),
      )
      .toBe(targetTabId);
    const captureResponse = await extensionPage.evaluate(
      async (tabId): Promise<CaptureResponse> =>
        chrome.runtime.sendMessage({
          type: 'webmirror.capture.requested',
          tabId,
        }),
      targetTabId,
    );

    expect(captureResponse.ok, captureResponse.error ?? 'capture failed').toBe(true);
    expect(captureResponse).toMatchObject({
      ok: true,
      jobId: expect.any(String),
      resourceCount: expect.any(Number),
    });

    await expect
      .poll(() => readStoredCapture(serviceWorker), {
        message: 'waiting for the extension capture manifest',
        timeout: 45_000,
      })
      .toMatchObject({
        lastCaptureJobId: expect.any(String),
        manifest: {
          sourceUrl: 'http://127.0.0.1:4178/basic/',
        },
      });

    const stored = await readStoredCapture(serviceWorker);

    expect(stored.lastCaptureError).toBeUndefined();
    expect(stored.manifest?.completionReason).toBe('network_idle');
    expect(stored.manifest?.preflight).toMatchObject({
      origin: 'http://127.0.0.1:4178',
      canvasElements: 0,
      iframeElements: 0,
      serviceWorkerControlled: false,
    });
    expect(stored.manifest?.preflight.observedResourceCount).toBeGreaterThanOrEqual(3);
    expect(stored.manifest?.preflight.observedTransferBytes).toBeGreaterThan(0);

    const urls = stored.manifest?.resources.map((resource) => resource.request.url) ?? [];
    expect(urls).toEqual(
      expect.arrayContaining([
        'http://127.0.0.1:4178/basic/',
        'http://127.0.0.1:4178/basic/styles.css',
        'http://127.0.0.1:4178/basic/app.js',
        'http://127.0.0.1:4178/basic/fixture-art.svg',
      ]),
    );
    expect(
      stored.manifest?.resources.some((resource) => 'cookie' in resource.request.headers),
    ).toBe(false);
  } finally {
    await context.close();
  }
});
