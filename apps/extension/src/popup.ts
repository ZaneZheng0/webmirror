import './styles.css';

import {
  Archive,
  Check,
  CircleAlert,
  CopyPlus,
  createIcons,
  Download,
  ExternalLink,
  FileCheck,
  FolderOpen,
  RotateCcw,
  RefreshCw,
  X,
} from 'lucide';
import type { JobState } from '@webmirror/shared';

import type {
  ExtensionJobRecord,
  JobActionResponse,
  JobGetResponse,
  JobStartResponse,
  JobUpdatedMessage,
} from './job-types.js';

const pageLabel = document.querySelector<HTMLParagraphElement>('#page-label');
const originValue = document.querySelector<HTMLElement>('#origin-value');
const helperValue = document.querySelector<HTMLElement>('#helper-value');
const statusBadge = document.querySelector<HTMLElement>('#status-badge');
const mirrorButton = document.querySelector<HTMLButtonElement>('#mirror-button');
const startPanel = document.querySelector<HTMLElement>('#start-panel');
const jobPanel = document.querySelector<HTMLElement>('#job-panel');
const jobMessage = document.querySelector<HTMLElement>('#job-message');
const elapsedValue = document.querySelector<HTMLElement>('#elapsed-value');
const foundValue = document.querySelector<HTMLElement>('#found-value');
const completedValue = document.querySelector<HTMLElement>('#completed-value');
const bytesValue = document.querySelector<HTMLElement>('#bytes-value');
const warningsValue = document.querySelector<HTMLElement>('#warnings-value');
const cancelButton = document.querySelector<HTMLButtonElement>('#cancel-button');
const resultPanel = document.querySelector<HTMLElement>('#result-panel');
const resultIcon = document.querySelector<HTMLElement>('#result-icon');
const resultTitle = document.querySelector<HTMLElement>('#result-title');
const resultSummary = document.querySelector<HTMLElement>('#result-summary');
const scoreValue = document.querySelector<HTMLElement>('#score-value');
const openPreviewButton = document.querySelector<HTMLButtonElement>('#open-preview-button');
const openFolderButton = document.querySelector<HTMLButtonElement>('#open-folder-button');
const exportZipButton = document.querySelector<HTMLButtonElement>('#export-zip-button');
const openReportButton = document.querySelector<HTMLButtonElement>('#open-report-button');
const retryButton = document.querySelector<HTMLButtonElement>('#retry-button');
const revalidateButton = document.querySelector<HTMLButtonElement>('#revalidate-button');
const newJobButton = document.querySelector<HTMLButtonElement>('#new-job-button');
const notice = document.querySelector<HTMLElement>('#notice');
const stageItems = [...document.querySelectorAll<HTMLElement>('#stage-list [data-stage]')];

interface HelperCheckResponse {
  ok: boolean;
  info?: {
    helperVersion: string;
  };
  error?: string;
}

const terminalStates = new Set<JobState>(['complete', 'partial', 'cancelled', 'failed']);
const stageOrder: readonly JobState[] = [
  'created',
  'preflight',
  'attaching',
  'discovering',
  'downloading',
  'localizing',
  'starting_preview',
  'fast_validating',
  'ready',
  'deep_validating',
  'complete',
  'partial',
];

let targetTabId: number | undefined;
let targetSupported = false;
let helperReady = false;
let currentJob: ExtensionJobRecord | undefined;

function setText(element: Element | null, value: string): void {
  if (element) {
    element.textContent = value;
  }
}

function setHidden(element: HTMLElement | null, hidden: boolean): void {
  if (element) {
    element.hidden = hidden;
  }
}

function setNotice(message: string | undefined, tone: 'neutral' | 'warning' | 'error' = 'neutral') {
  if (!notice) {
    return;
  }

  notice.hidden = !message;
  notice.textContent = message ?? '';
  notice.dataset.tone = tone;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function stateIndex(state: JobState): number {
  if (state === 'cancelling') {
    return stageOrder.indexOf('downloading');
  }

  if (state === 'cancelled' || state === 'failed') {
    return -1;
  }

  return stageOrder.indexOf(state);
}

function renderStages(state: JobState): void {
  const currentIndex = stateIndex(state);

  for (const item of stageItems) {
    const stage = item.dataset.stage as JobState | undefined;
    const index = stage ? stageOrder.indexOf(stage) : -1;
    item.dataset.status =
      currentIndex < 0
        ? 'pending'
        : index < currentIndex
          ? 'complete'
          : index === currentIndex
            ? 'current'
            : 'pending';
  }
}

function setBadge(text: string, tone: 'neutral' | 'active' | 'success' | 'warning' | 'error') {
  setText(statusBadge, text);

  if (statusBadge) {
    statusBadge.dataset.tone = tone;
  }
}

function renderIdle(): void {
  setHidden(startPanel, false);
  setHidden(jobPanel, true);
  setHidden(resultPanel, true);
  setBadge(
    targetSupported && helperReady ? 'Ready' : 'Unavailable',
    targetSupported && helperReady ? 'success' : 'neutral',
  );

  if (mirrorButton) {
    mirrorButton.disabled = !targetSupported || !helperReady || targetTabId === undefined;
  }
}

function renderActiveJob(job: ExtensionJobRecord): void {
  setHidden(startPanel, true);
  setHidden(jobPanel, false);
  setHidden(resultPanel, true);
  setBadge(job.state === 'cancelling' ? 'Cancelling' : 'Running', 'active');
  setText(jobMessage, job.message);
  setText(elapsedValue, formatElapsed(job.elapsedMs));
  setText(foundValue, String(job.discoveredResources));
  setText(completedValue, String(job.completedResources));
  setText(bytesValue, formatBytes(job.downloadedBytes));
  setText(warningsValue, String(job.warningCount));
  renderStages(job.state);

  if (cancelButton) {
    cancelButton.disabled = job.state === 'cancelling';
  }
}

function resultCopy(job: ExtensionJobRecord): {
  badge: string;
  tone: 'success' | 'warning' | 'error' | 'neutral';
  title: string;
  summary: string;
  icon: 'check' | 'circle-alert' | 'x';
} {
  switch (job.state) {
    case 'complete':
      return {
        badge: 'Complete',
        tone: 'success',
        title: 'Mirror complete',
        summary: `${job.result?.downloadedResources ?? 0} resources saved in ${formatElapsed(job.elapsedMs)}.`,
        icon: 'check',
      };
    case 'partial':
      return {
        badge: 'Partial',
        tone: 'warning',
        title: 'Mirror ready with limits',
        summary: `${job.result?.failedResources ?? job.warningCount} items need attention.`,
        icon: 'circle-alert',
      };
    case 'cancelled':
      return {
        badge: 'Cancelled',
        tone: 'neutral',
        title: 'Mirror cancelled',
        summary: 'Completed files remain in the task directory.',
        icon: 'x',
      };
    default:
      return {
        badge: 'Failed',
        tone: 'error',
        title: 'Mirror failed',
        summary: job.error ?? 'The page could not be mirrored.',
        icon: 'x',
      };
  }
}

function renderResult(job: ExtensionJobRecord): void {
  const copy = resultCopy(job);
  setHidden(startPanel, true);
  setHidden(jobPanel, true);
  setHidden(resultPanel, false);
  setBadge(copy.badge, copy.tone);
  setText(resultTitle, copy.title);
  setText(resultSummary, copy.summary);

  if (resultIcon) {
    resultIcon.dataset.tone = copy.tone;
    resultIcon.innerHTML = `<i data-lucide="${copy.icon}" aria-hidden="true"></i>`;
  }

  const hasPreview = Boolean(job.result?.entryUrl);
  const hasOutput = Boolean(job.result?.outputDirectory);
  const hasReport = Boolean(job.result?.reportUrl);

  if (openPreviewButton) {
    openPreviewButton.disabled = !hasPreview;
  }

  if (openFolderButton) {
    openFolderButton.disabled = !hasOutput;
  }

  if (exportZipButton) {
    exportZipButton.disabled = !hasOutput;
    setText(
      exportZipButton.querySelector('span'),
      job.result?.zipPath ? 'ZIP exported' : 'Export ZIP',
    );
  }

  setHidden(openReportButton, !hasReport);
  setHidden(retryButton, (job.result?.failedResources ?? 0) === 0);

  if (revalidateButton) {
    revalidateButton.disabled = !hasPreview;
  }

  if (scoreValue && job.result?.completenessScore !== undefined) {
    scoreValue.hidden = false;
    scoreValue.textContent = String(job.result.completenessScore);
  } else {
    setHidden(scoreValue, true);
  }

  createIcons({
    icons: { Check, CircleAlert, X },
    attrs: { 'stroke-width': 1.8 },
  });
}

function renderJob(job: ExtensionJobRecord | undefined): void {
  currentJob = job;
  setNotice(undefined);

  if (!job) {
    renderIdle();
    return;
  }

  if (terminalStates.has(job.state)) {
    renderResult(job);
  } else {
    renderActiveJob(job);
  }
}

async function checkHelper(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: 'webmirror.helper.check',
  })) as HelperCheckResponse;
  helperReady = response.ok && Boolean(response.info);

  if (helperReady && response.info) {
    setText(helperValue, `Connected v${response.info.helperVersion}`);
  } else {
    setText(helperValue, 'Not installed');
    setNotice(response.error ?? 'Install the WebMirror helper to start mirroring.', 'warning');
  }
}

async function resolveTargetTab(): Promise<void> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const targetTab = activeTab;

  if (!targetTab?.id || !targetTab.url) {
    setText(pageLabel, 'No active web page is available.');
    setText(originValue, '-');
    targetSupported = false;
    return;
  }

  const url = new URL(targetTab.url);
  targetTabId = targetTab.id;
  targetSupported = isSupportedUrl(targetTab.url);
  setText(pageLabel, targetTab.title ?? url.href);
  setText(originValue, url.origin);
}

function isSupportedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function loadCurrentJob(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: 'webmirror.job.get',
  })) as JobGetResponse;

  if (!response.ok) {
    throw new Error(response.error ?? 'Could not load the current mirror job.');
  }

  renderJob(response.job);
}

async function startMirror(): Promise<void> {
  if (targetTabId === undefined || !mirrorButton) {
    return;
  }

  mirrorButton.disabled = true;
  setNotice(undefined);
  const response = (await chrome.runtime.sendMessage({
    type: 'webmirror.job.start',
    tabId: targetTabId,
  })) as JobStartResponse;

  if (!response.ok) {
    mirrorButton.disabled = false;
    setNotice(response.error ?? 'The mirror job could not be started.', 'error');
    return;
  }

  await loadCurrentJob();
}

async function cancelMirror(): Promise<void> {
  if (!currentJob || !cancelButton) {
    return;
  }

  cancelButton.disabled = true;
  const response = (await chrome.runtime.sendMessage({
    type: 'webmirror.job.cancel',
    jobId: currentJob.jobId,
  })) as { ok: boolean; error?: string };

  if (!response.ok) {
    cancelButton.disabled = false;
    setNotice(response.error ?? 'The mirror job could not be cancelled.', 'error');
  }
}

async function runAction(
  action: 'open_output' | 'export_zip' | 'retry_failed' | 'revalidate',
): Promise<void> {
  if (!currentJob) {
    return;
  }

  const response = (await chrome.runtime.sendMessage({
    type: 'webmirror.job.action',
    jobId: currentJob.jobId,
    action,
  })) as JobActionResponse;

  if (!response.ok) {
    setNotice(response.error ?? `The ${action} action failed.`, 'error');
    return;
  }

  if (action === 'export_zip' && response.result?.success && response.result.path) {
    await loadCurrentJob();
    setNotice(`ZIP exported to ${response.result.path}`);
  } else if ((action === 'retry_failed' || action === 'revalidate') && response.result?.success) {
    await loadCurrentJob();
    setNotice(
      action === 'retry_failed' ? 'Failed resources were retried.' : 'Validation completed.',
    );
  }
}

async function initialize(): Promise<void> {
  createIcons({
    icons: {
      Archive,
      Check,
      CircleAlert,
      CopyPlus,
      Download,
      ExternalLink,
      FileCheck,
      FolderOpen,
      RotateCcw,
      RefreshCw,
      X,
    },
    attrs: { 'stroke-width': 1.8 },
  });
  await Promise.all([resolveTargetTab(), checkHelper()]);
  await loadCurrentJob();

  mirrorButton?.addEventListener('click', () => {
    void startMirror();
  });
  cancelButton?.addEventListener('click', () => {
    void cancelMirror();
  });
  openPreviewButton?.addEventListener('click', () => {
    const url = currentJob?.result?.entryUrl;

    if (url) {
      void chrome.tabs.create({ url });
    }
  });
  openFolderButton?.addEventListener('click', () => {
    void runAction('open_output');
  });
  exportZipButton?.addEventListener('click', () => {
    void runAction('export_zip');
  });
  openReportButton?.addEventListener('click', () => {
    const url = currentJob?.result?.reportUrl;

    if (url) {
      void chrome.tabs.create({ url });
    }
  });
  retryButton?.addEventListener('click', () => {
    void runAction('retry_failed');
  });
  revalidateButton?.addEventListener('click', () => {
    void runAction('revalidate');
  });
  newJobButton?.addEventListener('click', () => {
    currentJob = undefined;
    renderIdle();
  });
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'webmirror.job.updated' &&
    'job' in message
  ) {
    renderJob((message as JobUpdatedMessage).job);
  }
});

setInterval(() => {
  if (currentJob && !terminalStates.has(currentJob.state)) {
    currentJob.elapsedMs = Math.max(0, Date.now() - Date.parse(currentJob.createdAt));
    setText(elapsedValue, formatElapsed(currentJob.elapsedMs));
  }
}, 1_000);

void initialize().catch((error: unknown) => {
  setNotice(error instanceof Error ? error.message : 'WebMirror could not initialize.', 'error');
  renderIdle();
});
