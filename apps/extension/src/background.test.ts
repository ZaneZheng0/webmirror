import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CaptureManifest } from '@webmirror/capture';
import {
  nativeMessagingProtocolVersion,
  type NativeJobAction,
  type NativeJobActionResult,
  type NativeMirrorProgressEvent,
  type NativeMirrorResultSummary,
} from '@webmirror/shared';

import type { CaptureResult } from './capture-controller.js';
import type { ExtensionJobRecord } from './job-types.js';

type Listener<TArguments extends unknown[]> = (...arguments_: TArguments) => unknown;

class FakeChromeEvent<TArguments extends unknown[]> {
  readonly listeners = new Set<Listener<TArguments>>();

  addListener(listener: Listener<TArguments>): void {
    this.listeners.add(listener);
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function captureManifest(jobId: string): CaptureManifest {
  return {
    schemaVersion: 1,
    jobId,
    tabId: 7,
    sourceUrl: 'https://example.test/showcase',
    title: 'State race fixture',
    startedAt: '2026-08-14T00:00:00.000Z',
    completedAt: '2026-08-14T00:00:01.000Z',
    completionReason: 'network_idle',
    preflight: {
      origin: 'https://example.test',
      canvasElements: 1,
      iframeElements: 0,
      mediaElements: 0,
      serviceWorkerControlled: false,
      observedResourceCount: 0,
      observedTransferBytes: 0,
      workerResourceHints: 0,
      webglResourceHints: 0,
      wasmResourceHints: 0,
    },
    resources: [],
    warnings: [],
  };
}

function mirrorResult(
  status: 'complete' | 'partial',
  overrides: Partial<NativeMirrorResultSummary> = {},
): NativeMirrorResultSummary {
  return {
    status,
    outputDirectory: 'C:\\WebMirror\\fixture',
    previewUrl: 'http://127.0.0.1:43120/',
    entryUrl: 'http://127.0.0.1:43120/showcase',
    manifestPath: 'C:\\WebMirror\\fixture\\mirror.json',
    validationPath: 'C:\\WebMirror\\fixture\\validation.json',
    reportUrl: 'http://127.0.0.1:43121/report.html',
    totalResources: 17,
    downloadedResources: status === 'complete' ? 17 : 15,
    failedResources: status === 'complete' ? 0 : 2,
    downloadedBytes: 4_194_304,
    warningCount: status === 'complete' ? 0 : 3,
    elapsedMs: 12_345,
    completenessScore: status === 'complete' ? 100 : 92,
    onlineDependencies: status === 'complete' ? [] : ['https://cdn.example.test/optional.bin'],
    ...overrides,
  };
}

interface BackgroundHarness {
  captureCancel: ReturnType<typeof vi.fn<(jobId: string) => Promise<boolean>>>;
  createMirror: ReturnType<typeof vi.fn<(jobId: string) => Promise<NativeMirrorResultSummary>>>;
  helperCancel: ReturnType<typeof vi.fn<(jobId: string) => Promise<boolean>>>;
  runAction: ReturnType<
    typeof vi.fn<(jobId: string, action: NativeJobAction) => Promise<NativeJobActionResult>>
  >;
  dispatch: (message: unknown) => Promise<Record<string, unknown>>;
  emitProgress: (jobId: string, state: NativeMirrorProgressEvent['state'], message: string) => void;
  job: (jobId: string) => Promise<ExtensionJobRecord>;
  waitForState: (jobId: string, state: ExtensionJobRecord['state']) => Promise<ExtensionJobRecord>;
}

async function createHarness(
  createMirrorImplementation: (jobId: string) => Promise<NativeMirrorResultSummary>,
): Promise<BackgroundHarness> {
  const jobId = 'background-state-race-job';
  const captureCancel = vi.fn(async (_jobId: string) => false);
  const createMirror = vi.fn(createMirrorImplementation);
  const helperCancel = vi.fn(async (_jobId: string) => false);
  const runAction =
    vi.fn<(jobId: string, action: NativeJobAction) => Promise<NativeJobActionResult>>();
  let progressListener: ((event: NativeMirrorProgressEvent) => void) | undefined;

  vi.doMock('./capture-controller.js', () => ({
    CaptureController: class {
      async start(
        _tabId: number,
        options: {
          jobId: string;
          onProgress?: (progress: {
            jobId: string;
            state: 'attaching' | 'discovering';
            discoveredResources: number;
            pendingRequests: number;
            message: string;
          }) => void;
        },
      ): Promise<CaptureResult> {
        options.onProgress?.({
          jobId: options.jobId,
          state: 'attaching',
          discoveredResources: 0,
          pendingRequests: 0,
          message: 'Attaching to the active tab.',
        });
        options.onProgress?.({
          jobId: options.jobId,
          state: 'discovering',
          discoveredResources: 0,
          pendingRequests: 0,
          message: 'Discovering page resources.',
        });
        return {
          manifest: captureManifest(options.jobId),
          bodies: [],
        };
      }

      cancel(requestedJobId: string): Promise<boolean> {
        return captureCancel(requestedJobId);
      }
    },
  }));
  vi.doMock('./native-host-client.js', () => ({
    NativeHostClient: class {
      readonly info = {
        helperVersion: '0.0.48',
        protocolVersion: nativeMessagingProtocolVersion,
        capabilities: [],
      };

      async connectCurrentVersion() {
        return this.info;
      }

      createMirror(requestedJobId: string): Promise<NativeMirrorResultSummary> {
        return createMirror(requestedJobId);
      }

      cancel(requestedJobId: string): Promise<boolean> {
        return helperCancel(requestedJobId);
      }

      runAction(requestedJobId: string, action: NativeJobAction): Promise<NativeJobActionResult> {
        return runAction(requestedJobId, action);
      }

      onProgress(listener: (event: NativeMirrorProgressEvent) => void): () => void {
        progressListener = listener;
        return () => {
          if (progressListener === listener) {
            progressListener = undefined;
          }
        };
      }
    },
  }));

  const stored = new Map<string, unknown>();
  const onMessage = new FakeChromeEvent<
    [unknown, chrome.runtime.MessageSender, (response: unknown) => void]
  >();
  const onInstalled = new FakeChromeEvent<[]>();
  const storage = {
    async get(key: string): Promise<Record<string, unknown>> {
      return stored.has(key) ? { [key]: structuredClone(stored.get(key)) } : {};
    },
    async set(items: Record<string, unknown>): Promise<void> {
      for (const [key, value] of Object.entries(items)) {
        stored.set(key, structuredClone(value));
      }
    },
  };

  vi.stubGlobal('chrome', {
    runtime: {
      id: 'webmirror-background-test',
      onInstalled,
      onMessage,
      getURL: (path: string) => `chrome-extension://webmirror-background-test/${path}`,
      sendMessage: vi.fn(async () => undefined),
    },
    storage: {
      local: storage,
    },
    tabs: {
      query: vi.fn(async () => [
        {
          id: 7,
          url: 'https://example.test/showcase',
          title: 'State race fixture',
        },
      ]),
      get: vi.fn(async () => ({
        id: 7,
        url: 'https://example.test/showcase',
        title: 'State race fixture',
      })),
    },
  });
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn(() => jobId),
  });
  await import('./background.js');

  const dispatch = async (message: unknown): Promise<Record<string, unknown>> => {
    const listener = [...onMessage.listeners][0];

    if (!listener) {
      throw new Error('Expected the background message listener to be registered.');
    }

    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      let responded = false;
      const sendResponse = (response: unknown): void => {
        responded = true;
        resolve(structuredClone(response) as Record<string, unknown>);
      };

      try {
        const keepOpen = listener(
          message,
          {
            id: 'webmirror-background-test',
            url: 'chrome-extension://webmirror-background-test/popup.html',
          },
          sendResponse,
        );

        if (keepOpen !== true && !responded) {
          reject(new Error('The background listener did not keep the response channel open.'));
        }
      } catch (error) {
        reject(error);
      }
    });
  };
  const readJob = async (requestedJobId: string): Promise<ExtensionJobRecord> => {
    const response = await dispatch({
      type: 'webmirror.job.get',
      jobId: requestedJobId,
    });
    const record = response.job;

    if (!record || typeof record !== 'object') {
      throw new Error(`Expected job ${requestedJobId} to exist.`);
    }

    return record as ExtensionJobRecord;
  };
  const waitForState = async (
    requestedJobId: string,
    state: ExtensionJobRecord['state'],
  ): Promise<ExtensionJobRecord> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const record = await readJob(requestedJobId);

      if (record.state === state) {
        return record;
      }

      await Promise.resolve();
    }

    const record = await readJob(requestedJobId);
    throw new Error(
      `Timed out waiting for ${requestedJobId} to reach ${state}; saw ${record.state}.`,
    );
  };

  return {
    captureCancel,
    createMirror,
    helperCancel,
    runAction,
    dispatch,
    emitProgress(requestedJobId, state, message) {
      progressListener?.({
        type: 'mirror_progress',
        protocolVersion: nativeMessagingProtocolVersion,
        jobId: requestedJobId,
        state,
        discoveredResources: 99,
        completedResources: 77,
        downloadedBytes: 88_000_000,
        warningCount: 66,
        elapsedMs: 55_000,
        message,
      });
    },
    job: readJob,
    waitForState,
  };
}

async function startJob(harness: BackgroundHarness): Promise<string> {
  const response = await harness.dispatch({
    type: 'webmirror.job.start',
    tabId: 7,
  });

  expect(response).toMatchObject({ ok: true });
  expect(typeof response.jobId).toBe('string');
  return response.jobId as string;
}

async function advanceMirrorToReady(
  harness: BackgroundHarness,
  jobId: string,
): Promise<ExtensionJobRecord> {
  harness.emitProgress(jobId, 'localizing', 'Finalizing localized resource paths.');
  harness.emitProgress(jobId, 'starting_preview', 'Starting the loopback preview server.');
  harness.emitProgress(jobId, 'fast_validating', 'Validating the local mirror.');
  harness.emitProgress(jobId, 'ready', 'The local mirror is ready.');
  return harness.waitForState(jobId, 'ready');
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('./capture-controller.js');
  vi.doUnmock('./native-host-client.js');
});

describe('background job state races', () => {
  it('restores the previous state and removes the cancellation marker when nobody accepted cancellation', async () => {
    const mirror = deferred<NativeMirrorResultSummary>();
    const harness = await createHarness(() => mirror.promise);
    const jobId = await startJob(harness);
    const beforeCancel = await harness.waitForState(jobId, 'downloading');

    const response = await harness.dispatch({
      type: 'webmirror.job.cancel',
      jobId,
    });
    const restored = await harness.job(jobId);

    expect(response).toEqual({ ok: false, error: 'The job had already finished.' });
    expect(restored.state).toBe(beforeCancel.state);
    expect(restored.message).toBe(beforeCancel.message);
    expect(harness.captureCancel).toHaveBeenCalledWith(jobId);
    expect(harness.helperCancel).toHaveBeenCalledWith(jobId);

    mirror.reject(new Error('The final Helper result could not be delivered.'));
    const failed = await harness.waitForState(jobId, 'failed');
    expect(failed.state).not.toBe('cancelled');
    expect(failed.message).toBe('The mirror job failed.');
  });

  it('does not roll a completed terminal result back when an unaccepted cancel overlaps delivery', async () => {
    const mirror = deferred<NativeMirrorResultSummary>();
    const captureCancellation = deferred<boolean>();
    const completeResult = mirrorResult('complete');
    const harness = await createHarness(() => mirror.promise);
    harness.captureCancel.mockImplementation(() => captureCancellation.promise);
    const jobId = await startJob(harness);
    await harness.waitForState(jobId, 'downloading');
    await advanceMirrorToReady(harness, jobId);

    const cancelResponse = harness.dispatch({
      type: 'webmirror.job.cancel',
      jobId,
    });
    await harness.waitForState(jobId, 'cancelling');
    mirror.resolve(completeResult);
    await harness.waitForState(jobId, 'complete');
    captureCancellation.resolve(false);

    await expect(cancelResponse).resolves.toEqual({
      ok: false,
      error: 'The job had already finished.',
    });
    const finalJob = await harness.job(jobId);
    expect(finalJob.state).toBe('complete');
    expect(finalJob.message).toBe('The offline mirror is complete.');
    expect(finalJob.result).toEqual(completeResult);
  });

  it.each([
    {
      initialStatus: 'complete' as const,
      action: 'revalidate' as const,
      progressState: 'fast_validating' as const,
      progressMessage: 'Revalidating the local mirror.',
    },
    {
      initialStatus: 'partial' as const,
      action: 'retry_failed' as const,
      progressState: 'downloading' as const,
      progressMessage: 'Retrying failed resources.',
    },
  ])(
    'restores a $initialStatus result after $action progress is followed by an action failure',
    async ({ initialStatus, action, progressState, progressMessage }) => {
      const initialResult = mirrorResult(initialStatus);
      const initialMirror = deferred<NativeMirrorResultSummary>();
      const actionResult = deferred<NativeJobActionResult>();
      const harness = await createHarness(() => initialMirror.promise);
      const jobId = await startJob(harness);
      await harness.waitForState(jobId, 'downloading');
      await advanceMirrorToReady(harness, jobId);
      initialMirror.resolve(initialResult);
      const original = structuredClone(await harness.waitForState(jobId, initialStatus));
      harness.runAction.mockImplementation((_requestedJobId, requestedAction) => {
        expect(requestedAction).toBe(action);
        harness.emitProgress(jobId, progressState, progressMessage);
        return actionResult.promise;
      });

      const response = harness.dispatch({
        type: 'webmirror.job.action',
        jobId,
        action,
      });
      const active = await harness.waitForState(jobId, progressState);
      expect(active.message).toBe(progressMessage);
      expect(active.discoveredResources).toBe(99);
      expect(active.downloadedBytes).toBe(88_000_000);

      actionResult.reject(new Error(`${action} failed`));
      await expect(response).resolves.toEqual({ ok: false, error: `${action} failed` });
      const restored = await harness.job(jobId);

      expect(restored.state).toBe(original.state);
      expect(restored.message).toBe(original.message);
      expect(restored.sourceUrl).toBe(original.sourceUrl);
      expect(restored.title).toBe(original.title);
      expect(restored.discoveredResources).toBe(original.discoveredResources);
      expect(restored.completedResources).toBe(original.completedResources);
      expect(restored.downloadedBytes).toBe(original.downloadedBytes);
      expect(restored.warningCount).toBe(original.warningCount);
      expect(restored.elapsedMs).toBe(original.elapsedMs);
      expect(restored.result).toEqual(original.result);
      expect(restored.result?.entryUrl).toBe(original.result?.entryUrl);
      expect(restored.result?.reportUrl).toBe(original.result?.reportUrl);
    },
  );
});
