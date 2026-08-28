import { lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as sleepTimeout } from 'node:timers/promises';
import { pathToFileURL, URL } from 'node:url';
import { chromium } from '@playwright/test';

import { loadRegressionPlan, runLoopbackRegression } from './real-site-plan.mjs';

const terminalStates = new Set(['complete', 'partial', 'failed', 'cancelled']);
const defaultTimeoutMs = 180_000;
const finalizationStates = new Set(['starting_preview', 'fast_validating', 'ready']);
const finalizationGraceMs = 90_000;
const sourceNavigationAttempts = 3;
const sourceNavigationRetryDelayMs = 2_000;
const transientSourceNavigationErrorPattern =
  /net::ERR_(?:CONNECTION_ABORTED|CONNECTION_CLOSED|CONNECTION_RESET|HTTP2_PROTOCOL_ERROR|NETWORK_CHANGED|QUIC_PROTOCOL_ERROR|TIMED_OUT)\b/u;

function usage() {
  return [
    'Usage: node scripts/real-site-regression.mjs <https://authorized.example/> [--plan <plan.json>] [--timeout-ms <milliseconds>]',
    '',
    'Runs the installed Native Host through the unpacked WebMirror extension,',
    'then opens the generated loopback mirror and records offline interaction evidence.',
  ].join('\n');
}

function parseArguments(arguments_) {
  let targetArgument;
  let planPath;
  let timeoutMs = defaultTimeoutMs;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (argument === '--plan') {
      const value = arguments_[index + 1];

      if (!value || value.startsWith('-') || planPath) {
        throw new Error(usage());
      }

      planPath = value;
      index += 1;
      continue;
    }

    if (argument.startsWith('--plan=')) {
      const value = argument.slice('--plan='.length);

      if (!value || planPath) {
        throw new Error(usage());
      }

      planPath = value;
      continue;
    }

    if (argument === '--timeout-ms') {
      const value = arguments_[index + 1];

      if (!value || value.startsWith('-')) {
        throw new Error(usage());
      }

      timeoutMs = Number(value);
      index += 1;
      continue;
    }

    if (argument.startsWith('--timeout-ms=')) {
      timeoutMs = Number(argument.slice('--timeout-ms='.length));
      continue;
    }

    if (argument.startsWith('-') || targetArgument) {
      throw new Error(usage());
    }

    targetArgument = argument;
  }

  if (!targetArgument) {
    throw new Error(usage());
  }

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 1_800_000) {
    throw new Error('--timeout-ms must be an integer between 10000 and 1800000.');
  }

  const target = new URL(targetArgument);

  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('The target URL must use HTTP or HTTPS.');
  }

  return { target, planPath, timeoutMs };
}

function siteLabel(target) {
  return `${target.hostname.replaceAll(/[^a-z0-9]+/giu, '-').replaceAll(/^-|-$/gu, '') || 'site'}-${Date.now()}`;
}

async function sleep(milliseconds) {
  await sleepTimeout(milliseconds);
}

export function isTransientSourceNavigationError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return transientSourceNavigationErrorPattern.test(message);
}

export async function navigateSourcePage(
  page,
  targetUrl,
  {
    attempts = sourceNavigationAttempts,
    retryDelayMs = sourceNavigationRetryDelayMs,
    sleep: wait = sleep,
  } = {},
) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(targetUrl, {
        timeout: 60_000,
        waitUntil: 'domcontentloaded',
      });
      return;
    } catch (error) {
      lastError = error;

      if (attempt >= attempts || !isTransientSourceNavigationError(error)) {
        throw error;
      }

      await page
        .goto('about:blank', {
          timeout: 10_000,
          waitUntil: 'commit',
        })
        .catch(() => undefined);
      await wait(retryDelayMs * attempt);
    }
  }

  throw lastError;
}

async function extensionWorker(context) {
  return context.serviceWorkers()[0] ?? context.waitForEvent('serviceworker');
}

async function storedJob(worker, jobId) {
  return worker.evaluate(async (id) => {
    const stored = await globalThis.chrome.storage.local.get(`job:${id}`);
    return stored[`job:${id}`];
  }, jobId);
}

async function storedCapture(worker, jobId) {
  return worker.evaluate(async (id) => {
    const stored = await globalThis.chrome.storage.local.get(`capture:${id}`);
    return stored[`capture:${id}`];
  }, jobId);
}

async function authoritativeJob(extensionPage, jobId) {
  const response = await extensionPage.evaluate(
    async (id) =>
      globalThis.chrome.runtime.sendMessage({
        type: 'webmirror.job.get',
        jobId: id,
      }),
    jobId,
  );
  return response?.ok ? response.job : undefined;
}

export async function waitForTerminalJob(
  worker,
  extensionPage,
  jobId,
  timeoutMs,
  { now = () => Date.now(), sleep: wait = sleep, graceMs = finalizationGraceMs } = {},
) {
  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    const job = await storedJob(worker, jobId);

    if (job && terminalStates.has(job.state)) {
      return job;
    }

    await wait(Math.min(500, Math.max(1, deadline - now())));
  }

  let job = await authoritativeJob(extensionPage, jobId);

  if (job && terminalStates.has(job.state)) {
    return job;
  }

  if (job && finalizationStates.has(job.state)) {
    const graceDeadline = now() + graceMs;

    while (now() < graceDeadline) {
      await wait(Math.min(500, Math.max(1, graceDeadline - now())));
      job = await authoritativeJob(extensionPage, jobId);

      if (job && terminalStates.has(job.state)) {
        return job;
      }
    }
  }

  const error = new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)} seconds waiting for mirror job ${jobId}.`,
  );
  error.lastJob = job;
  throw error;
}

function errorDetails(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack ?? error.message,
    };
  }

  const message = String(error);
  return { message, stack: message };
}

function isPathInside(rootDirectory, candidatePath) {
  const root = resolve(rootDirectory);
  const candidate = resolve(candidatePath);
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

async function isRegularDirectory(path) {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

async function isRegularFile(path) {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))];
}

async function outputDirectories(outputRoot, jobResult) {
  const declaredPaths = [
    jobResult?.outputDirectory,
    typeof jobResult?.manifestPath === 'string' ? dirname(jobResult.manifestPath) : undefined,
    typeof jobResult?.validationPath === 'string' ? dirname(jobResult.validationPath) : undefined,
  ];
  const directories = [];

  for (const value of declaredPaths) {
    if (
      typeof value === 'string' &&
      isPathInside(outputRoot, value) &&
      (await isRegularDirectory(value))
    ) {
      directories.push(resolve(value));
    }
  }

  try {
    const discovered = await Promise.all(
      (await readdir(outputRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const path = resolve(outputRoot, entry.name);
          const metadata = await stat(path);
          return { path, modifiedAt: metadata.mtimeMs };
        }),
    );

    discovered.sort((left, right) => right.modifiedAt - left.modifiedAt);
    directories.push(...discovered.map((entry) => entry.path));
  } catch {
    // A Helper failure can happen before an output directory is created.
  }

  if (await isRegularDirectory(outputRoot)) {
    directories.push(resolve(outputRoot));
  }

  return uniqueStrings(directories);
}

async function firstArtifactPath(outputRoot, declaredPath, directories, fileName) {
  const candidates = [
    typeof declaredPath === 'string' ? declaredPath : undefined,
    ...directories.map((directory) => join(directory, fileName)),
  ];

  for (const candidate of uniqueStrings(candidates)) {
    if (
      basename(candidate) === fileName &&
      isPathInside(outputRoot, candidate) &&
      (await isRegularFile(candidate))
    ) {
      return resolve(candidate);
    }
  }

  return undefined;
}

async function readJsonIfPresent(path, label, errors) {
  if (!path) {
    return undefined;
  }

  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    errors.push(`Could not read ${label} at ${path}: ${errorDetails(error).message}`);
    return undefined;
  }
}

export async function collectRegressionDiagnostics(job, outputRoot) {
  const errors = [];
  const directories = await outputDirectories(outputRoot, job?.result);
  const manifestPath = await firstArtifactPath(
    outputRoot,
    job?.result?.manifestPath,
    directories,
    'mirror.json',
  );
  const validationPath = await firstArtifactPath(
    outputRoot,
    job?.result?.validationPath,
    directories,
    'validation.json',
  );
  const reportPath = await firstArtifactPath(outputRoot, undefined, directories, 'report.html');
  const artifactDirectory = manifestPath
    ? dirname(manifestPath)
    : validationPath
      ? dirname(validationPath)
      : directories[0];
  const mirrorManifest = await readJsonIfPresent(manifestPath, 'mirror manifest', errors);
  const validation = await readJsonIfPresent(validationPath, 'validation result', errors);

  return {
    artifacts: {
      ...(artifactDirectory ? { outputDirectory: artifactDirectory } : {}),
      ...(manifestPath ? { manifestPath } : {}),
      ...(validationPath ? { validationPath } : {}),
      ...(reportPath ? { reportPath } : {}),
    },
    ...(mirrorManifest !== undefined ? { mirrorManifest } : {}),
    ...(validation !== undefined ? { validation } : {}),
    errors,
  };
}

function failureDiagnostics(job, runnerError, diagnostics, diagnosticCollectionError) {
  const runner = runnerError === undefined ? undefined : errorDetails(runnerError);
  const collectionError =
    diagnosticCollectionError === undefined ? undefined : errorDetails(diagnosticCollectionError);
  const failedJob = job?.state === 'failed' || job?.state === 'cancelled';
  const validationErrors = Array.isArray(diagnostics.validation?.errors)
    ? diagnostics.validation.errors.filter((value) => typeof value === 'string')
    : [];
  const manifestWarnings = Array.isArray(diagnostics.mirrorManifest?.warnings)
    ? diagnostics.mirrorManifest.warnings.filter((value) => typeof value === 'string')
    : [];
  const primaryError = failedJob
    ? (job?.error ??
      validationErrors[0] ??
      manifestWarnings.at(-1) ??
      runner?.message ??
      job?.message)
    : (runner?.message ?? job?.error ?? validationErrors[0] ?? manifestWarnings.at(-1));
  const diagnosticMessages = uniqueStrings([
    job?.error,
    ...(failedJob ? [job?.message] : []),
    ...validationErrors,
    ...(diagnostics.mirrorManifest?.status === 'failed' ? manifestWarnings.slice(-5) : []),
    runner?.message,
    ...diagnostics.errors,
    collectionError?.message,
  ]);

  if (!primaryError && diagnosticMessages.length === 0) {
    return undefined;
  }

  return {
    ...(primaryError ? { primaryError } : {}),
    ...(job?.state ? { jobState: job.state } : {}),
    ...(job?.message ? { jobMessage: job.message } : {}),
    ...(job?.error ? { jobError: job.error } : {}),
    ...(runner ? { runnerError: runner.stack } : {}),
    ...(collectionError ? { diagnosticCollectionError: collectionError.stack } : {}),
    ...(diagnostics.mirrorManifest?.status
      ? { manifestStatus: diagnostics.mirrorManifest.status }
      : {}),
    ...(diagnostics.validation?.status ? { validationStatus: diagnostics.validation.status } : {}),
    diagnosticMessages,
  };
}

export async function persistRegressionResult({
  summary,
  summaryPath,
  outputRoot,
  runnerError,
  now = () => new Date(),
}) {
  let diagnostics = { artifacts: {}, errors: [] };
  let diagnosticCollectionError;

  try {
    diagnostics = await collectRegressionDiagnostics(summary.job, outputRoot);
  } catch (error) {
    diagnosticCollectionError = error;
  }

  if (Object.keys(diagnostics.artifacts).length > 0) {
    summary.artifacts = diagnostics.artifacts;
  }

  if (diagnostics.mirrorManifest !== undefined) {
    summary.mirrorManifest = diagnostics.mirrorManifest;
  }

  if (diagnostics.validation !== undefined) {
    summary.validation = diagnostics.validation;
  }

  const failure = failureDiagnostics(
    summary.job,
    runnerError,
    diagnostics,
    diagnosticCollectionError,
  );

  if (failure) {
    summary.failure = failure;
    summary.error = failure.primaryError ?? failure.diagnosticMessages[0];
  }

  if (
    runnerError !== undefined ||
    summary.job?.state === 'failed' ||
    summary.job?.state === 'cancelled'
  ) {
    summary.regressionPassed = false;
  }

  summary.finishedAt = now().toISOString();
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}

export async function main(arguments_ = process.argv.slice(2)) {
  const { target, planPath, timeoutMs } = parseArguments(arguments_);
  const root = resolve('.codex-runtime', 'real-site-regressions');
  const evidenceDirectory = join(root, siteLabel(target));
  const outputRoot = join(evidenceDirectory, 'mirror-output');
  const cacheRoot = join(evidenceDirectory, 'cache-v1');
  const extensionPath = resolve('apps/extension/dist');
  const summaryPath = join(evidenceDirectory, 'result.json');

  await mkdir(outputRoot, { recursive: true });
  const summary = {
    targetUrl: target.toString(),
    evidenceDirectory,
    plan: {
      ...(planPath ? { path: resolve(planPath) } : {}),
    },
    startedAt: new Date().toISOString(),
    timeoutMs,
  };
  let context;
  let runnerError;

  try {
    const plan = await loadRegressionPlan(planPath);
    summary.plan = {
      ...summary.plan,
      schemaVersion: plan.schemaVersion,
      viewport: plan.viewport,
      actions: plan.actions,
    };
    context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: false,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: '0',
        WEBMIRROR_OUTPUT_ROOT: outputRoot,
        WEBMIRROR_CACHE_ROOT: cacheRoot,
      },
    });
    const worker = await extensionWorker(context);
    const extensionId = new URL(worker.url()).host;
    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/popup.html`);
    const targetPage = await context.newPage();
    await navigateSourcePage(targetPage, target.toString());
    await targetPage.waitForTimeout(plan.sourceSettleMs);
    await targetPage.screenshot({
      fullPage: true,
      path: join(evidenceDirectory, 'source-first-view.png'),
    });
    await targetPage.bringToFront();

    const helper = await extensionPage.evaluate(async () =>
      globalThis.chrome.runtime.sendMessage({
        type: 'webmirror.helper.check',
      }),
    );
    summary.extensionId = extensionId;
    summary.helper = helper;

    if (!helper?.ok) {
      throw new Error(`Native Host handshake failed: ${helper?.error ?? 'unknown failure'}`);
    }

    const tabId = await worker.evaluate(async () => {
      const [tab] = await globalThis.chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab?.id) {
        throw new Error('The target tab is not active.');
      }

      return tab.id;
    });
    const start = await extensionPage.evaluate(
      async (activeTabId) =>
        globalThis.chrome.runtime.sendMessage({
          type: 'webmirror.job.start',
          tabId: activeTabId,
        }),
      tabId,
    );
    summary.start = start;

    if (!start?.ok || typeof start.jobId !== 'string') {
      throw new Error(
        `The extension rejected the mirror job: ${start?.error ?? 'unknown failure'}`,
      );
    }

    const job = await waitForTerminalJob(worker, extensionPage, start.jobId, timeoutMs);
    summary.job = job;
    summary.capture = await storedCapture(worker, start.jobId);

    if (!job?.result?.entryUrl) {
      throw new Error(
        job?.error
          ? `The mirror job failed: ${job.error}`
          : 'The mirror job completed without a local preview entry URL.',
      );
    }

    summary.loopback = await runLoopbackRegression(job.result.entryUrl, evidenceDirectory, plan);
    summary.regressionPassed =
      job.state !== 'failed' && job.state !== 'cancelled' && summary.loopback.passed;

    if (!summary.regressionPassed) {
      process.exitCode = 1;
    }
  } catch (error) {
    runnerError = error;
    process.exitCode = 1;
  } finally {
    if (context) {
      try {
        await context.close();
      } catch (error) {
        summary.contextCloseError = errorDetails(error).stack;
        runnerError ??= error;
        process.exitCode = 1;
      }
    }

    const persisted = await persistRegressionResult({
      summary,
      summaryPath,
      outputRoot,
      ...(runnerError !== undefined ? { runnerError } : {}),
    });

    if (runnerError !== undefined) {
      console.error(persisted.error ?? errorDetails(runnerError).message);
    } else {
      console.log(JSON.stringify(persisted, null, 2));
    }
  }

  return summary;
}

const invokedPath = process.argv[1];

if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  void main();
}
