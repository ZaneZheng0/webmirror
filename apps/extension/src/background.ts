import type { CaptureManifest } from '@webmirror/capture';
import {
  assertTransition,
  canTransition,
  nativeJobActions,
  redactSensitiveText,
  redactSensitiveUrl,
  type JobState,
  type NativeMirrorProgressEvent,
  type NativeMirrorResultSummary,
} from '@webmirror/shared';

import {
  CaptureController,
  type CaptureProgress,
  type CaptureResult,
} from './capture-controller.js';
import { toNativeCapture } from './capture-to-native.js';
import type {
  ExtensionJobRecord,
  JobActionMessage,
  JobCancelMessage,
  JobGetMessage,
  JobStartMessage,
} from './job-types.js';
import { NativeHostClient } from './native-host-client.js';

const captureController = new CaptureController();
const nativeHostClient = new NativeHostClient();
const jobs = new Map<string, ExtensionJobRecord>();
const cancelledJobs = new Set<string>();
let activeJobId: string | undefined;

interface LegacyCaptureRequestedMessage {
  type: 'webmirror.capture.requested';
  tabId: number;
}

interface HelperCheckMessage {
  type: 'webmirror.helper.check';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isLegacyCaptureRequestedMessage(
  message: unknown,
): message is LegacyCaptureRequestedMessage {
  return (
    isRecord(message) &&
    message.type === 'webmirror.capture.requested' &&
    typeof message.tabId === 'number'
  );
}

function isHelperCheckMessage(message: unknown): message is HelperCheckMessage {
  return isRecord(message) && message.type === 'webmirror.helper.check';
}

function isJobStartMessage(message: unknown): message is JobStartMessage {
  return (
    isRecord(message) &&
    message.type === 'webmirror.job.start' &&
    Number.isSafeInteger(message.tabId)
  );
}

function isJobGetMessage(message: unknown): message is JobGetMessage {
  return (
    isRecord(message) &&
    message.type === 'webmirror.job.get' &&
    (message.jobId === undefined || typeof message.jobId === 'string')
  );
}

function isJobCancelMessage(message: unknown): message is JobCancelMessage {
  return (
    isRecord(message) &&
    message.type === 'webmirror.job.cancel' &&
    typeof message.jobId === 'string'
  );
}

function isJobActionMessage(message: unknown): message is JobActionMessage {
  return (
    isRecord(message) &&
    message.type === 'webmirror.job.action' &&
    typeof message.jobId === 'string' &&
    nativeJobActions.includes(message.action as JobActionMessage['action'])
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function elapsed(record: ExtensionJobRecord): number {
  return Math.max(0, Date.now() - Date.parse(record.createdAt));
}

async function broadcastJob(record: ExtensionJobRecord): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: 'webmirror.job.updated',
      job: record,
    });
  } catch {
    // The popup is normally closed while a job is running.
  }
}

async function persistJob(
  record: ExtensionJobRecord,
  options: { refreshElapsed?: boolean } = {},
): Promise<void> {
  record.sourceUrl = record.sourceUrl ? redactSensitiveUrl(record.sourceUrl) : '';

  if (record.error) {
    record.error = redactSensitiveText(record.error);
  }

  if (record.result) {
    record.result.onlineDependencies = record.result.onlineDependencies.map(redactSensitiveUrl);
  }

  record.updatedAt = nowIso();

  if (options.refreshElapsed !== false) {
    record.elapsedMs = elapsed(record);
  }

  jobs.set(record.jobId, record);
  await chrome.storage.local.set({
    currentJobId: record.jobId,
    [`job:${record.jobId}`]: record,
  });
  await broadcastJob(record);
}

async function updateJob(
  jobId: string,
  update: Partial<Omit<ExtensionJobRecord, 'schemaVersion' | 'jobId' | 'createdAt'>>,
): Promise<void> {
  const record = jobs.get(jobId);

  if (!record) {
    return;
  }

  if (update.state && update.state !== record.state) {
    assertTransition(record.state, update.state);
  }

  Object.assign(record, update);
  await persistJob(record);
}

function captureProgressUpdate(progress: CaptureProgress): void {
  const record = jobs.get(progress.jobId);

  if (
    !record ||
    (progress.state !== record.state && !canTransition(record.state, progress.state))
  ) {
    return;
  }

  void updateJob(progress.jobId, {
    state: progress.state,
    message: redactSensitiveText(progress.message),
    discoveredResources: progress.discoveredResources,
    completedResources: Math.max(0, progress.discoveredResources - progress.pendingRequests),
  });
}

function nativeProgressUpdate(progress: NativeMirrorProgressEvent): void {
  const record = jobs.get(progress.jobId);

  if (
    !record ||
    (progress.state !== record.state && !canTransition(record.state, progress.state))
  ) {
    return;
  }

  void updateJob(progress.jobId, {
    state: progress.state,
    message: redactSensitiveText(progress.message),
    discoveredResources: progress.discoveredResources,
    completedResources: progress.completedResources,
    downloadedBytes: progress.downloadedBytes,
    warningCount: progress.warningCount,
    elapsedMs: progress.elapsedMs,
  });
}

nativeHostClient.onProgress(nativeProgressUpdate);

function terminalState(result: NativeMirrorResultSummary): JobState {
  switch (result.status) {
    case 'complete':
      return 'complete';
    case 'partial':
      return 'partial';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
  }
}

interface TerminalJobSnapshot {
  state: 'complete' | 'partial';
  message: string;
  sourceUrl: string;
  title: string;
  discoveredResources: number;
  completedResources: number;
  downloadedBytes: number;
  warningCount: number;
  elapsedMs: number;
  result: NativeMirrorResultSummary;
  error?: string;
}

function cloneMirrorResult(result: NativeMirrorResultSummary): NativeMirrorResultSummary {
  return {
    ...result,
    onlineDependencies: [...result.onlineDependencies],
  };
}

function terminalJobSnapshot(
  record: ExtensionJobRecord | undefined,
): TerminalJobSnapshot | undefined {
  if (!record?.result || (record.state !== 'complete' && record.state !== 'partial')) {
    return undefined;
  }

  return {
    state: record.state,
    message: record.message,
    sourceUrl: record.sourceUrl,
    title: record.title,
    discoveredResources: record.discoveredResources,
    completedResources: record.completedResources,
    downloadedBytes: record.downloadedBytes,
    warningCount: record.warningCount,
    elapsedMs: record.elapsedMs,
    result: cloneMirrorResult(record.result),
    ...(record.error ? { error: record.error } : {}),
  };
}

async function restoreTerminalJob(
  record: ExtensionJobRecord,
  snapshot: TerminalJobSnapshot,
): Promise<void> {
  record.state = snapshot.state;
  record.message = snapshot.message;
  record.sourceUrl = snapshot.sourceUrl;
  record.title = snapshot.title;
  record.discoveredResources = snapshot.discoveredResources;
  record.completedResources = snapshot.completedResources;
  record.downloadedBytes = snapshot.downloadedBytes;
  record.warningCount = snapshot.warningCount;
  record.elapsedMs = snapshot.elapsedMs;
  record.result = cloneMirrorResult(snapshot.result);

  if (snapshot.error) {
    record.error = snapshot.error;
  } else {
    delete record.error;
  }

  await persistJob(record, { refreshElapsed: false });
}

async function runJob(record: ExtensionJobRecord): Promise<void> {
  const jobId = record.jobId;

  try {
    await updateJob(jobId, {
      state: 'preflight',
      message: 'Checking the page and local helper.',
    });
    const helperPromise = nativeHostClient.connectCurrentVersion().catch(async (error: unknown) => {
      await captureController.cancel(jobId);
      throw error;
    });
    const capturePromise = captureController.start(record.tabId, {
      jobId,
      onProgress: captureProgressUpdate,
    });
    const [capture] = await Promise.all([capturePromise, helperPromise]);
    const { manifest, bodies } = capture;

    if (manifest.completionReason === 'cancelled' || cancelledJobs.has(jobId)) {
      await updateJob(jobId, {
        state: 'cancelled',
        message: 'The mirror job was cancelled.',
      });
      return;
    }

    await updateJob(jobId, {
      state: 'downloading',
      message: 'Sending the discovered resources to the local helper.',
      sourceUrl: manifest.sourceUrl,
      title: manifest.title,
      discoveredResources: manifest.resources.length,
      warningCount: manifest.warnings.length,
    });
    const result = await nativeHostClient.createMirror(jobId, toNativeCapture(manifest), bodies);
    await updateJob(jobId, {
      state: terminalState(result),
      message:
        result.status === 'complete'
          ? 'The offline mirror is complete.'
          : result.status === 'partial'
            ? 'The mirror is usable with reported limitations.'
            : result.status === 'cancelled'
              ? 'The mirror job was cancelled.'
              : 'The mirror could not be completed.',
      discoveredResources: result.totalResources,
      completedResources: result.downloadedResources + result.failedResources,
      downloadedBytes: result.downloadedBytes,
      warningCount: result.warningCount,
      elapsedMs: result.elapsedMs,
      result,
    });
  } catch (error) {
    const cancelled = cancelledJobs.has(jobId);
    await updateJob(jobId, {
      state: cancelled ? 'cancelled' : 'failed',
      message: cancelled ? 'The mirror job was cancelled.' : 'The mirror job failed.',
      ...(cancelled
        ? {}
        : { error: error instanceof Error ? error.message : 'Unknown WebMirror failure.' }),
    });
  } finally {
    cancelledJobs.delete(jobId);

    if (activeJobId === jobId) {
      activeJobId = undefined;
    }
  }
}

async function startJob(
  message: JobStartMessage,
): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  if (activeJobId) {
    return {
      ok: false,
      error: `Another WebMirror job is already running (${activeJobId}).`,
    };
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab?.id || activeTab.id !== message.tabId) {
    return {
      ok: false,
      error: 'WebMirror can only capture the active tab in the current window.',
    };
  }

  const tab = await chrome.tabs.get(message.tabId);
  const jobId = crypto.randomUUID();
  const createdAt = nowIso();
  const visibleUrl = tab.url && isHttpUrl(tab.url) ? tab.url : '';
  const record: ExtensionJobRecord = {
    schemaVersion: 1,
    jobId,
    tabId: message.tabId,
    sourceUrl: visibleUrl,
    title: tab.title ?? (visibleUrl ? new URL(visibleUrl).hostname : 'Current page'),
    createdAt,
    updatedAt: createdAt,
    state: 'created',
    message: 'The mirror job was created.',
    discoveredResources: 0,
    completedResources: 0,
    downloadedBytes: 0,
    warningCount: 0,
    elapsedMs: 0,
  };
  activeJobId = jobId;
  await persistJob(record);
  void runJob(record);
  return { ok: true, jobId };
}

async function getStoredJob(jobId?: string): Promise<ExtensionJobRecord | undefined> {
  const resolvedJobId =
    jobId ?? activeJobId ?? (await chrome.storage.local.get('currentJobId')).currentJobId;

  if (typeof resolvedJobId !== 'string') {
    return undefined;
  }

  const inMemory = jobs.get(resolvedJobId);

  if (inMemory) {
    return inMemory;
  }

  const stored = await chrome.storage.local.get(`job:${resolvedJobId}`);
  const record = stored[`job:${resolvedJobId}`];
  return isRecord(record) ? (record as unknown as ExtensionJobRecord) : undefined;
}

async function cancelJob(message: JobCancelMessage): Promise<{ ok: boolean; error?: string }> {
  const record = await getStoredJob(message.jobId);

  if (!record || !activeJobId || activeJobId !== message.jobId) {
    return { ok: false, error: 'The active WebMirror job was not found.' };
  }

  const previousState = record.state;
  const previousMessage = record.message;
  cancelledJobs.add(message.jobId);
  await updateJob(message.jobId, {
    state: 'cancelling',
    message: 'Cancelling the mirror job.',
  });
  const captureCancelled = await captureController.cancel(message.jobId);
  let helperCancelled = false;

  if (nativeHostClient.info) {
    helperCancelled = await nativeHostClient.cancel(message.jobId).catch(() => false);
  }

  if (captureCancelled || helperCancelled) {
    return { ok: true };
  }

  cancelledJobs.delete(message.jobId);
  const current = jobs.get(message.jobId);

  if (current?.state === 'cancelling') {
    current.state = previousState;
    current.message = previousMessage;
    await persistJob(current);
  }

  return { ok: false, error: 'The job had already finished.' };
}

async function runJobAction(message: JobActionMessage) {
  const initialRecord = await getStoredJob(message.jobId);
  const snapshot =
    message.action === 'retry_failed' || message.action === 'revalidate'
      ? terminalJobSnapshot(initialRecord)
      : undefined;
  let result: Awaited<ReturnType<NativeHostClient['runAction']>>;

  try {
    result = await nativeHostClient.runAction(message.jobId, message.action);
  } catch (error) {
    if (initialRecord && snapshot) {
      await restoreTerminalJob(initialRecord, snapshot);
    }

    throw error;
  }

  const record = await getStoredJob(message.jobId);

  if (record?.result && result.success) {
    if (result.result) {
      record.result = result.result;
      record.state = terminalState(result.result);
      record.message =
        result.result.status === 'complete'
          ? 'The offline mirror is complete.'
          : result.result.status === 'partial'
            ? 'The mirror is usable with reported limitations.'
            : 'The mirror validation failed.';
      record.discoveredResources = result.result.totalResources;
      record.completedResources = result.result.downloadedResources + result.result.failedResources;
      record.downloadedBytes = result.result.downloadedBytes;
      record.warningCount = result.result.warningCount;
      record.elapsedMs = result.result.elapsedMs;
    } else if (result.action === 'export_zip' && result.path) {
      record.result.zipPath = result.path;
    }

    await persistJob(record);
  }

  return { ok: true, result };
}

function isTrustedPopupSender(sender: chrome.runtime.MessageSender): boolean {
  const popupUrl = chrome.runtime.getURL('popup.html');
  const senderUrl = sender.url?.split(/[?#]/u)[0];
  return sender.id === chrome.runtime.id && senderUrl === popupUrl;
}

async function runLegacyCapture(
  message: LegacyCaptureRequestedMessage,
  sender: chrome.runtime.MessageSender,
): Promise<CaptureManifest> {
  if (!isTrustedPopupSender(sender)) {
    throw new Error('Capture requests are accepted only from the WebMirror popup.');
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab?.id || activeTab.id !== message.tabId) {
    throw new Error('WebMirror can capture only the active tab.');
  }

  const result: CaptureResult = await captureController.start(message.tabId);
  return result.manifest;
}

chrome.runtime.onInstalled.addListener(() => {
  console.info('WebMirror extension installed.');
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isHelperCheckMessage(message)) {
    void nativeHostClient
      .connectCurrentVersion()
      .then((info) => {
        sendResponse({ ok: true, info });
      })
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  if (isJobStartMessage(message)) {
    void startJob(message)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  if (isJobGetMessage(message)) {
    void getStoredJob(message.jobId)
      .then((job) => sendResponse({ ok: true, ...(job ? { job } : {}) }))
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  if (isJobCancelMessage(message)) {
    void cancelJob(message)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  if (isJobActionMessage(message)) {
    void runJobAction(message)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  if (!isLegacyCaptureRequestedMessage(message)) {
    return;
  }

  void runLegacyCapture(message, sender)
    .then((manifest) => {
      sendResponse({
        ok: true,
        jobId: manifest.jobId,
        resourceCount: manifest.resources.length,
      });
    })
    .catch((error: unknown) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return true;
});
