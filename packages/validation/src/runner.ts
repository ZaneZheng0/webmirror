import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MIMEType } from 'node:util';

import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type ConsoleMessage,
  type Frame,
  type Locator,
  type Page,
  type Request,
  type Response,
  type Route,
  type WebSocketRoute,
} from 'playwright';
import { PNG } from 'pngjs';

import { isKnownNonessentialExternalUrl, type RuntimeCapabilities } from '@webmirror/shared';

import {
  executeValidationAction,
  normalizeValidationActions,
  validationActionLabel,
} from './actions.js';
import { DiagnosticBudget } from './diagnostic-budget.js';
import {
  diagnosticErrorMessage,
  diagnosticMessage,
  diagnosticOrigin,
  diagnosticUrl,
  PublicValidationError,
  sanitizeTrustedText,
} from './diagnostics.js';
import { comparePngScreenshots, normalizedPerceptualSettings } from './perceptual.js';
import { atomicWriteFile, renderValidationReport } from './report.js';
import {
  validationSchemaVersion,
  type RunValidationOptions,
  type ValidationAction,
  type ValidationActionResult,
  type ValidationCanvasDetail,
  type ValidationCanvasResult,
  type ValidationCheckpointResult,
  type ValidationConsoleError,
  type ValidationDiagnosticsResult,
  type ValidationEntryResult,
  type ValidationHttpFailure,
  type ValidationInteractionResult,
  type ValidationPageError,
  type ValidationPerceptualResult,
  type ValidationPerceptualSettings,
  type ValidationRemoteDependency,
  type ValidationResult,
  type ValidationScreenshotResult,
  type ValidationStatus,
} from './types.js';
import { startValidationNetworkProxy, type ValidationNetworkProxy } from './validation-proxy.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_TIME_MS = 2_000;
const DEFAULT_VIEWPORT = {
  width: 1280,
  height: 720,
  deviceScaleFactor: 1,
} as const;
const SCREENSHOT_PATH = 'screenshots/validation-first-view.png';
const INTERACTION_INITIAL_SCREENSHOT_PATH = 'screenshots/interactions/validation-initial.png';
const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_ACTION_SETTLE_TIME_MS = 250;
const MAX_VISUAL_REFERENCE_BYTES = 20 * 1024 * 1024;
const MAX_VISUAL_REFERENCE_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_VIEWPORT_DIMENSION = 8_192;
const MAX_DEVICE_SCALE_FACTOR = 4;
const MAX_SCREENSHOT_PIXELS = 8 * 1024 * 1024;
const MAX_CANVAS_FRAMES = 32;
const MAX_CANVAS_DETAILS = 64;
const CANVAS_SAMPLE_CONCURRENCY = 8;
const MAX_CANVAS_SCREENSHOT_TOTAL_PIXELS = 16 * 1024 * 1024;
const MAX_STRONGLY_TRACKED_IN_FLIGHT_REQUESTS = 512;
const MAX_SCREENSHOT_MASK_FRAMES = 64;
const MAX_CLOSED_SHADOW_PROBE_FRAMES = 64;
const SENSITIVE_FORM_SELECTOR = [
  'input:not([type="button"]):not([type="submit"]):not([type="reset"])',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
].join(',');
const SCREENSHOT_MASK_COLOR = '#ff00fe';
const SCREENSHOT_MASK_RGBA = [255, 0, 254, 255] as const;
const SAFE_HTTP_METHODS = new Set([
  'CONNECT',
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
  'TRACE',
]);
const SAFE_ENTRY_CONTENT_TYPES = new Set(['application/xhtml+xml', 'text/html']);

class ValidationTimeoutError extends PublicValidationError {
  constructor(timeoutMs: number) {
    super(`Validation timed out after ${timeoutMs} ms`);
    this.name = 'ValidationTimeoutError';
  }
}

interface AbortMonitor {
  signal: AbortSignal;
  callerAborted: () => boolean;
  timedOut: () => boolean;
  cleanup: () => void;
}

interface ValidationCollector {
  httpFailures: Map<string, ValidationHttpFailure>;
  httpFailureEvents: ValidationHttpFailure[];
  consoleErrors: ValidationConsoleError[];
  pageErrors: ValidationPageError[];
  remoteDependencies: Map<string, ValidationRemoteDependency>;
  remoteDependencyEvents: ValidationRemoteDependency[];
  blockedRemoteRequests: Set<string>;
  consoleErrorKeys: Set<string>;
  pageErrorKeys: Set<string>;
  recoverableReplayConsoleErrors: Set<ValidationConsoleError>;
  recoverableReplayPageErrors: Set<ValidationPageError>;
  transportBlockedOrigins: Set<string>;
  budget: DiagnosticBudget;
}

interface ValidationListeners {
  detach: () => void;
  resetNetworkQuietWindow: () => void;
  waitForNetworkQuiet: (
    quietWindowMs: number,
    maximumWaitMs: number,
    signal: AbortSignal,
  ) => Promise<NetworkQuietResult>;
}

interface NetworkQuietResult {
  reached: boolean;
  inFlightRequests: number;
  quietForMs: number;
  waitedMs: number;
}

interface ExtraPageGuard {
  count: () => number;
  detach: () => void;
}

interface ClosedShadowRootMonitor {
  hasSeenClosedShadowRoot: () => Promise<boolean>;
  close: () => Promise<void>;
}

interface CanvasBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CanvasViewportSnapshot {
  image: PNG;
  cssWidth: number;
  cssHeight: number;
}

function createCollector(budget = new DiagnosticBudget()): ValidationCollector {
  return {
    httpFailures: new Map(),
    httpFailureEvents: [],
    consoleErrors: [],
    pageErrors: [],
    remoteDependencies: new Map(),
    remoteDependencyEvents: [],
    blockedRemoteRequests: new Set(),
    consoleErrorKeys: new Set(),
    pageErrorKeys: new Set(),
    recoverableReplayConsoleErrors: new Set(),
    recoverableReplayPageErrors: new Set(),
    transportBlockedOrigins: new Set(),
    budget,
  };
}

function installExtraPageGuard(context: BrowserContext, primaryPage: Page): ExtraPageGuard {
  let openedPages = 0;
  const onPage = (page: Page): void => {
    if (page === primaryPage) {
      return;
    }

    openedPages = Math.min(Number.MAX_SAFE_INTEGER, openedPages + 1);
    void page.close().catch(() => undefined);
  };
  context.on('page', onPage);

  return {
    count: () => openedPages,
    detach: () => context.off('page', onPage),
  };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;

  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }

  return normalized;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;

  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }

  return normalized;
}

function positiveNumber(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;

  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }

  return normalized;
}

function cleanHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = cleanHostname(hostname);

  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1'
  ) {
    return true;
  }

  const octets = normalized.split('.');
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    octets[0] === '127'
  );
}

function isSupportedNetworkProtocol(protocol: string): boolean {
  return protocol === 'http:' || protocol === 'https:' || protocol === 'ws:' || protocol === 'wss:';
}

function isLoopbackUrl(url: URL): boolean {
  return isSupportedNetworkProtocol(url.protocol) && isLoopbackHostname(url.hostname);
}

function parseLocalEntry(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new TypeError('entryUrl must be an absolute HTTP URL');
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !isLoopbackUrl(url) ||
    url.username ||
    url.password
  ) {
    throw new TypeError('entryUrl must use HTTP(S), contain no credentials, and target loopback');
  }

  return url;
}

function canonicalOrigin(url: URL): string {
  const normalized = new URL(url.href);

  if (normalized.protocol === 'ws:') {
    normalized.protocol = 'http:';
  } else if (normalized.protocol === 'wss:') {
    normalized.protocol = 'https:';
  }

  return normalized.origin;
}

function parseOrigin(value: string, name: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${name} must contain absolute HTTP(S) URLs`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`${name} must contain HTTP(S) URLs`);
  }

  return canonicalOrigin(url);
}

function safeUrl(value: string): string {
  return diagnosticUrl(value);
}

function debugValidationEvent(
  kind: string,
  details: { url?: string; message?: string; resourceType?: string; method?: string },
): void {
  if (process.env.WEBMIRROR_DEBUG_VALIDATION !== '1') {
    return;
  }

  let path: string | undefined;

  if (details.url) {
    try {
      path = new URL(details.url).pathname;
    } catch {
      path = '[invalid-url]';
    }
  }

  console.error(
    '[webmirror-validation-debug]',
    JSON.stringify({
      kind,
      ...(path ? { path } : {}),
      ...(details.resourceType ? { resourceType: details.resourceType } : {}),
      ...(details.method ? { method: details.method } : {}),
      ...(details.message ? { message: sanitizeTrustedText(details.message) } : {}),
    }),
  );
}

function errorMessage(error: unknown, category = 'Validation error'): string {
  return diagnosticErrorMessage(error, category);
}

function safeContentType(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const essence = new MIMEType(value).essence;
    return SAFE_ENTRY_CONTENT_TYPES.has(essence)
      ? essence
      : diagnosticMessage('Content-Type', essence);
  } catch {
    return diagnosticMessage('Invalid Content-Type', value);
  }
}

function safeHttpMethod(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.toUpperCase();
  return SAFE_HTTP_METHODS.has(normalized) ? normalized : diagnosticMessage('HTTP method', value);
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) {
    return signal.reason;
  }

  return new DOMException('Validation was aborted', 'AbortError');
}

function createAbortMonitor(input: AbortSignal | undefined, timeoutMs: number): AbortMonitor {
  const controller = new AbortController();
  let wasCallerAborted = false;
  let wasTimedOut = false;
  const onCallerAbort = (): void => {
    wasCallerAborted = true;
    controller.abort(abortReason(input as AbortSignal));
  };

  if (input?.aborted) {
    onCallerAbort();
  } else {
    input?.addEventListener('abort', onCallerAbort, { once: true });
  }

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      wasTimedOut = true;
      controller.abort(new ValidationTimeoutError(timeoutMs));
    }
  }, timeoutMs);

  return {
    signal: controller.signal,
    callerAborted: () => wasCallerAborted,
    timedOut: () => wasTimedOut,
    cleanup: () => {
      clearTimeout(timer);
      input?.removeEventListener('abort', onCallerAbort);
    },
  };
}

async function launchBrowser(
  signal: AbortSignal,
  timeoutMs: number,
  captureBrowser: RunValidationOptions['browser'],
): Promise<Browser> {
  const executablePath = validationBrowserExecutable(captureBrowser);
  const launchPromise = chromium.launch({
    env: {
      ...process.env,
      CHROME_LOG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
    },
    headless: true,
    timeout: timeoutMs,
    args: [
      '--disable-quic',
      '--disable-features=WebTransport',
      '--disable-blink-features=WebTransport',
      '--dns-prefetch-disable',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
    ...(executablePath ? { executablePath } : {}),
  });

  if (signal.aborted) {
    void launchPromise.then((browser) => browser.close()).catch(() => undefined);
    throw abortReason(signal);
  }

  return await new Promise<Browser>((resolve, reject) => {
    const onAbort = (): void => {
      void launchPromise.then((browser) => browser.close()).catch(() => undefined);
      reject(abortReason(signal));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    void launchPromise.then(
      (browser) => {
        signal.removeEventListener('abort', onAbort);

        if (signal.aborted) {
          void browser.close().catch(() => undefined);
          reject(abortReason(signal));
        } else {
          resolve(browser);
        }
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function installedBrowserCandidates(captureBrowser: RunValidationOptions['browser']): string[] {
  if (process.platform !== 'win32' || !captureBrowser) {
    return [];
  }

  const name = captureBrowser.name.trim().toLowerCase();
  const roots = {
    localAppData: process.env.LOCALAPPDATA,
    programFiles: process.env.ProgramFiles,
    programFilesX86: process.env['ProgramFiles(x86)'],
  };
  const candidates: Array<string | undefined> = [];

  if (name.includes('edge')) {
    candidates.push(
      roots.programFilesX86
        ? join(roots.programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        : undefined,
      roots.programFiles
        ? join(roots.programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        : undefined,
      roots.localAppData
        ? join(roots.localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        : undefined,
    );
  } else if (name.includes('chrome')) {
    candidates.push(
      roots.programFiles
        ? join(roots.programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')
        : undefined,
      roots.programFilesX86
        ? join(roots.programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe')
        : undefined,
      roots.localAppData
        ? join(roots.localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
        : undefined,
    );
  }

  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))];
}

function validationBrowserExecutable(
  captureBrowser: RunValidationOptions['browser'],
): string | undefined {
  const configured = process.env.WEBMIRROR_PLAYWRIGHT_EXECUTABLE;

  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`WEBMIRROR_PLAYWRIGHT_EXECUTABLE does not exist: ${configured}`);
    }

    return configured;
  }

  if (process.platform !== 'win32') {
    return undefined;
  }

  for (const candidate of installedBrowserCandidates(captureBrowser)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const bundled = join(
    dirname(process.execPath),
    'browsers',
    'chromium-headless-shell',
    'chrome-headless-shell-win64',
    'chrome-headless-shell.exe',
  );

  if (existsSync(bundled)) {
    return bundled;
  }

  if (process.env.WEBMIRROR_SEA === '1') {
    throw new Error(`Bundled Playwright browser does not exist: ${bundled}`);
  }

  return undefined;
}

function requestUrl(request: Request): URL | undefined {
  try {
    return new URL(request.url());
  } catch {
    return undefined;
  }
}

const nonBlockingRuntimePathnames = new Set(['/.webmirror/noop', '/.webmirror/unavailable.js']);

function isNonBlockingRuntimeUrl(value: string, localOrigin: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      canonicalOrigin(parsed) === localOrigin && nonBlockingRuntimePathnames.has(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function blocksNetworkQuiet(request: Request, localOrigin: string): boolean {
  if (isKnownNonessentialExternalUrl(request.url())) {
    return false;
  }

  const parsed = requestUrl(request);

  if (parsed && isNonBlockingRuntimeUrl(parsed.toString(), localOrigin)) {
    return false;
  }

  return !['eventsource', 'media', 'ping'].includes(request.resourceType().toLowerCase());
}

function initialNetworkQuietMaximumWaitMs(quietWindowMs: number): number {
  return Math.min(15_000, Math.max(3_000, quietWindowMs * 6));
}

function actionNetworkQuietMaximumWaitMs(quietWindowMs: number): number {
  return Math.min(10_000, Math.max(1_000, quietWindowMs * 6));
}

function requestFailureKey(failure: ValidationHttpFailure): string {
  return [
    failure.kind,
    failure.method,
    failure.url,
    failure.status ?? '',
    failure.errorText ?? '',
  ].join(':');
}

function remoteDependencyKey(dependency: ValidationRemoteDependency): string {
  return `${dependency.reason}:${dependency.url}`;
}

function mergeRemoteDependency(
  existing: ValidationRemoteDependency,
  dependency: ValidationRemoteDependency,
): void {
  existing.allowed ||= dependency.allowed;
  existing.blocked ||= dependency.blocked;

  if (existing.resourceType.startsWith('proxy-') && !dependency.resourceType.startsWith('proxy-')) {
    existing.resourceType = dependency.resourceType;
  }

  if (!existing.method && dependency.method) {
    existing.method = dependency.method;
  }
}

function markTransportBlockedOrigin(collector: ValidationCollector, rawUrl: string): void {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }

  if (!isSupportedNetworkProtocol(url.protocol)) {
    return;
  }

  const origin = canonicalOrigin(url);
  const persistedOrigin = diagnosticOrigin(origin);
  collector.transportBlockedOrigins.add(origin);

  for (const dependency of [
    ...collector.remoteDependencies.values(),
    ...collector.remoteDependencyEvents,
  ]) {
    if (dependency.origin === persistedOrigin) {
      dependency.blocked = true;
      collector.blockedRemoteRequests.add(dependency.url);
    }
  }
}

function recordRemoteDependency(
  collector: ValidationCollector,
  rawUrl: string,
  resourceType: string,
  localOrigin: string,
  sourceOrigin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
  method?: string,
  blocked = false,
): void {
  if (isKnownNonessentialExternalUrl(rawUrl)) {
    return;
  }

  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }

  if (!isSupportedNetworkProtocol(url.protocol)) {
    return;
  }

  const origin = canonicalOrigin(url);

  if (origin === localOrigin) {
    return;
  }

  const reason =
    sourceOrigin !== undefined && origin === sourceOrigin
      ? ('source-origin' as const)
      : ('unexpected-remote' as const);
  const persistedMethod = safeHttpMethod(method);
  const transportBlocked = blocked || collector.transportBlockedOrigins.has(origin);
  const dependency: ValidationRemoteDependency = {
    url: safeUrl(rawUrl),
    origin: diagnosticOrigin(origin),
    reason,
    resourceType,
    ...(persistedMethod ? { method: persistedMethod } : {}),
    allowed: allowedOrigins.has(origin),
    blocked: transportBlocked,
  };
  const key = remoteDependencyKey(dependency);
  const existing = collector.remoteDependencies.get(key);

  if (existing) {
    mergeRemoteDependency(existing, dependency);
  }

  const recorded = collector.budget.record('remoteDependencies', () => dependency);

  if (recorded) {
    collector.remoteDependencyEvents.push(recorded);

    if (!existing) {
      collector.remoteDependencies.set(key, { ...recorded });
    }
  }

  if (transportBlocked && (existing || recorded)) {
    collector.blockedRemoteRequests.add(dependency.url);
  }
}

function recordRequest(
  collector: ValidationCollector,
  request: Request,
  localOrigin: string,
  sourceOrigin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): void {
  recordRemoteDependency(
    collector,
    request.url(),
    request.resourceType(),
    localOrigin,
    sourceOrigin,
    allowedOrigins,
    request.method(),
  );
}

async function startLocalNetworkGuard(
  collector: ValidationCollector,
  localOrigin: string,
  signal: AbortSignal,
): Promise<ValidationNetworkProxy> {
  return await startValidationNetworkProxy({
    localOrigin,
    signal,
    onBlocked: (url) => {
      markTransportBlockedOrigin(collector, url);
    },
  });
}

async function installLocalRequestGuard(
  context: BrowserContext,
  collector: ValidationCollector,
  localOrigin: string,
  sourceOrigin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): Promise<() => Promise<void>> {
  const handler = async (route: Route): Promise<void> => {
    const request = route.request();
    const parsed = requestUrl(request);

    if (
      parsed &&
      isSupportedNetworkProtocol(parsed.protocol) &&
      canonicalOrigin(parsed) !== localOrigin
    ) {
      recordRemoteDependency(
        collector,
        request.url(),
        request.resourceType(),
        localOrigin,
        sourceOrigin,
        allowedOrigins,
        request.method(),
        true,
      );
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }

    await route.continue().catch(() => undefined);
  };

  await context.route('**/*', handler);
  await context.routeWebSocket(/.*/u, async (webSocket: WebSocketRoute) => {
    let url: URL;

    try {
      url = new URL(webSocket.url());
    } catch {
      await webSocket.close({
        code: 1008,
        reason: 'Invalid WebSocket URL',
      });
      return;
    }

    if (canonicalOrigin(url) !== localOrigin) {
      recordRemoteDependency(
        collector,
        webSocket.url(),
        'websocket',
        localOrigin,
        sourceOrigin,
        allowedOrigins,
        undefined,
        true,
      );
      await webSocket.close({
        code: 1008,
        reason: 'Blocked by WebMirror validation',
      });
      return;
    }

    webSocket.connectToServer();
  });
  return async () => {
    await context.unroute('**/*', handler).catch(() => undefined);
  };
}

async function installValidationRuntimeGuards(
  context: BrowserContext,
  runtimeCapabilities: RuntimeCapabilities | undefined,
): Promise<string> {
  const closedShadowProbeKey = `__webmirror_closed_shadow_${randomUUID().replaceAll('-', '')}`;
  const serializedProbeKey = JSON.stringify(closedShadowProbeKey);
  const serializedRuntimeCapabilities = JSON.stringify(runtimeCapabilities ?? null);
  await context.addInitScript(`(() => {
    const probeKey = ${serializedProbeKey};
    const runtimeCapabilities = ${serializedRuntimeCapabilities};
    const globals = globalThis;
    const blockedConstructor = function () {
      throw new DOMException(
        "This network transport is disabled during WebMirror validation.",
        "SecurityError"
      );
    };

    for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "WebTransport"]) {
      try {
        Object.defineProperty(globals, name, {
          configurable: false,
          enumerable: false,
          writable: false,
          value: blockedConstructor
        });
      } catch {
        try {
          globals[name] = blockedConstructor;
        } catch {
          // A non-configurable missing transport is already unavailable.
        }
      }
    }

    const compressedTextureFamily = function (extensionName) {
      const normalized = String(extensionName || "").trim().toLowerCase();

      if (
        normalized === "webgl_compressed_texture_astc" ||
        normalized === "webkit_webgl_compressed_texture_astc"
      ) return "astc";
      if (normalized === "webgl_compressed_texture_atc") return "atc";
      if (normalized === "ext_texture_compression_bptc") return "bptc";
      if (
        normalized === "webgl_compressed_texture_etc" ||
        normalized === "webgl_compressed_texture_es3_0"
      ) return "etc";
      if (normalized === "webgl_compressed_texture_etc1") return "etc1";
      if (
        normalized === "webgl_compressed_texture_pvrtc" ||
        normalized === "webkit_webgl_compressed_texture_pvrtc"
      ) return "pvrtc";
      if (normalized === "ext_texture_compression_rgtc") return "rgtc";
      if (
        normalized === "webgl_compressed_texture_s3tc" ||
        normalized === "webkit_webgl_compressed_texture_s3tc" ||
        normalized === "moz_webgl_compressed_texture_s3tc"
      ) return "s3tc";
      if (normalized === "webgl_compressed_texture_s3tc_srgb") return "s3tc-srgb";
      return null;
    };

    const installCompressedTextureGuard = function (constructorName, profileName) {
      if (!runtimeCapabilities) return;
      const constructor = globals[constructorName];
      const prototype = constructor && constructor.prototype;
      const profile = runtimeCapabilities[profileName];

      if (!prototype || !profile || !Array.isArray(profile.compressedTextureFamilies)) return;
      const allowedFamilies = new Set(profile.compressedTextureFamilies);

      try {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "getExtension");
        const original = descriptor && descriptor.value;

        if (typeof original === "function") {
          Object.defineProperty(prototype, "getExtension", {
            ...descriptor,
            value: function (extensionName) {
              const family = compressedTextureFamily(extensionName);

              if (family && !allowedFamilies.has(family)) {
                return null;
              }

              return Reflect.apply(original, this, [extensionName]);
            }
          });
        }
      } catch {
        // The matching installed browser remains the primary capability control.
      }

      try {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "getSupportedExtensions");
        const original = descriptor && descriptor.value;

        if (typeof original === "function") {
          Object.defineProperty(prototype, "getSupportedExtensions", {
            ...descriptor,
            value: function () {
              const extensions = Reflect.apply(original, this, []);

              if (!Array.isArray(extensions)) {
                return extensions;
              }

              return extensions.filter((extensionName) => {
                const family = compressedTextureFamily(extensionName);
                return !family || allowedFamilies.has(family);
              });
            }
          });
        }
      } catch {
        // The matching installed browser remains the primary capability control.
      }
    };

    installCompressedTextureGuard("WebGLRenderingContext", "webgl");
    installCompressedTextureGuard("WebGL2RenderingContext", "webgl2");

    let closedShadowRootSeen = false;
    let closedShadowGuardFailed = false;

    try {
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow");
      const originalAttachShadow = descriptor && descriptor.value;

      if (typeof originalAttachShadow !== "function") {
        closedShadowGuardFailed = true;
      } else {
        const guardedAttachShadow = function (init) {
          const root = Reflect.apply(originalAttachShadow, this, [init]);

          if (init && init.mode === "closed") {
            closedShadowRootSeen = true;
          }

          return root;
        };

        Object.defineProperty(Element.prototype, "attachShadow", {
          ...descriptor,
          configurable: false,
          writable: false,
          value: guardedAttachShadow
        });
      }
    } catch {
      closedShadowGuardFailed = true;
    }

    try {
      Object.defineProperty(globals, probeKey, {
        configurable: false,
        enumerable: false,
        writable: false,
        value: function () {
          return closedShadowGuardFailed || closedShadowRootSeen;
        }
      });
    } catch {
      // A missing probe is treated as unsafe by the browser-side monitor.
    }
  })();`);

  return closedShadowProbeKey;
}

async function startClosedShadowRootMonitor(
  context: BrowserContext,
  page: Page,
  probeKey: string,
): Promise<ClosedShadowRootMonitor> {
  let session: CDPSession | undefined;
  let cdpSawClosedShadowRoot = false;
  let cdpInspectionFailed = false;
  const onShadowRootPushed = (event: unknown): void => {
    if (
      typeof event === 'object' &&
      event !== null &&
      'root' in event &&
      typeof event.root === 'object' &&
      event.root !== null &&
      'shadowRootType' in event.root &&
      event.root.shadowRootType === 'closed'
    ) {
      cdpSawClosedShadowRoot = true;
    }
  };

  try {
    session = await context.newCDPSession(page);
    session.on('DOM.shadowRootPushed', onShadowRootPushed);
    await session.send('DOM.enable');
  } catch {
    cdpInspectionFailed = true;
    await session?.detach().catch(() => undefined);
    session = undefined;
  }

  return {
    hasSeenClosedShadowRoot: async () => {
      if (cdpInspectionFailed || cdpSawClosedShadowRoot) {
        return true;
      }

      const frames = page.frames();

      if (frames.length > MAX_CLOSED_SHADOW_PROBE_FRAMES) {
        return true;
      }

      for (const frame of frames) {
        try {
          const unsafe = await frame.evaluate((key) => {
            const probe = (globalThis as unknown as Record<string, unknown>)[key];

            if (typeof probe !== 'function') {
              return true;
            }

            try {
              return (probe as () => unknown)() !== false;
            } catch {
              return true;
            }
          }, probeKey);

          if (unsafe) {
            return true;
          }
        } catch {
          if (page.frames().includes(frame)) {
            return true;
          }
        }
      }

      return cdpSawClosedShadowRoot;
    },
    close: async () => {
      if (!session) {
        return;
      }

      session.off('DOM.shadowRootPushed', onShadowRootPushed);
      await session.detach().catch(() => undefined);
      session = undefined;
    },
  };
}

function recordResponse(
  collector: ValidationCollector,
  response: Response,
  localOrigin: string,
): void {
  const status = response.status();

  if (
    status < 400 ||
    isKnownNonessentialExternalUrl(response.url()) ||
    isNonBlockingRuntimeUrl(response.url(), localOrigin)
  ) {
    return;
  }

  const request = response.request();
  const parsedUrl = requestUrl(request);
  const url = safeUrl(response.url());

  if (
    parsedUrl &&
    canonicalOrigin(parsedUrl) !== localOrigin &&
    collector.blockedRemoteRequests.has(url)
  ) {
    return;
  }

  const failure: ValidationHttpFailure = {
    kind: 'http-error',
    url,
    method: safeHttpMethod(request.method()) as string,
    resourceType: request.resourceType(),
    local: parsedUrl ? canonicalOrigin(parsedUrl) === localOrigin : false,
    status,
  };
  const recorded = collector.budget.record('httpFailures', () => failure);

  if (recorded) {
    collector.httpFailureEvents.push(recorded);
    collector.httpFailures.set(requestFailureKey(recorded), recorded);
  }
}

function recordRequestFailure(
  collector: ValidationCollector,
  request: Request,
  localOrigin: string,
): void {
  if (isKnownNonessentialExternalUrl(request.url())) {
    return;
  }

  const parsedUrl = requestUrl(request);
  const failureText = request.failure()?.errorText ?? 'Request failed';
  const url = safeUrl(request.url());
  debugValidationEvent('request-failed', {
    url: request.url(),
    resourceType: request.resourceType(),
    method: request.method(),
    message: failureText,
  });

  if (parsedUrl && !isSupportedNetworkProtocol(parsedUrl.protocol)) {
    return;
  }

  if (parsedUrl && isNonBlockingRuntimeUrl(parsedUrl.toString(), localOrigin)) {
    return;
  }

  if (
    parsedUrl &&
    canonicalOrigin(parsedUrl) === localOrigin &&
    !request.isNavigationRequest() &&
    (request.method() === 'GET' || request.method() === 'HEAD') &&
    failureText.trim().toLowerCase() === 'net::err_aborted'
  ) {
    return;
  }

  if (
    parsedUrl &&
    canonicalOrigin(parsedUrl) !== localOrigin &&
    (failureText.toLowerCase().includes('blocked_by_client') ||
      collector.blockedRemoteRequests.has(url))
  ) {
    return;
  }

  const failure: ValidationHttpFailure = {
    kind: 'request-failed',
    url,
    method: safeHttpMethod(request.method()) as string,
    resourceType: request.resourceType(),
    local: parsedUrl ? canonicalOrigin(parsedUrl) === localOrigin : false,
    errorText: diagnosticMessage('Network failure', failureText),
  };
  const recorded = collector.budget.record('httpFailures', () => failure);

  if (recorded) {
    collector.httpFailureEvents.push(recorded);
    collector.httpFailures.set(requestFailureKey(recorded), recorded);
  }
}

function isNetworkConsoleError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('failed to load resource:') ||
    normalized.includes('the server responded with a status of') ||
    normalized.includes('net::err_')
  );
}

function isLocalPreviewEnvironmentConsoleError(message: string): boolean {
  const normalized = message.toLowerCase();
  const sensorPolicyRestriction =
    (normalized.includes('permissions policy') || normalized.includes('permissions-policy')) &&
    (normalized.includes('accelerometer') || normalized.includes('deviceorientation')) &&
    (normalized.includes('not allowed') ||
      normalized.includes('blocked') ||
      normalized.includes('disabled') ||
      normalized.includes('violation'));
  const aboutBlankImageCspHint =
    normalized.includes('about:blank') &&
    normalized.includes('image') &&
    normalized.includes('content security policy') &&
    normalized.includes('img-src');
  return sensorPolicyRestriction || aboutBlankImageCspHint;
}

function isKnownNonessentialConsoleError(message: string): boolean {
  const candidates = message.match(/https?:\/\/[^\s"'<>]+/giu) ?? [];

  if (candidates.length === 0) {
    return false;
  }

  return candidates.every((candidate) =>
    isKnownNonessentialExternalUrl(candidate.replace(/[),.;:]+$/u, '')),
  );
}

function isRecoverableHydrationError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    /minified react error #(?:418|423)\b/iu.test(message) ||
    normalized.includes(
      'hydration failed because the initial ui does not match what was rendered on the server',
    ) ||
    normalized.includes('text content does not match server-rendered html') ||
    normalized.includes('expected server html to contain a matching') ||
    (normalized.includes('error while hydrating') &&
      normalized.includes('entire root will switch to client rendering')) ||
    (normalized.includes('error occurred during hydration') &&
      normalized.includes('server html was replaced'))
  );
}

function isRecoverableMediaPlaybackInterruption(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.startsWith('the play() request was interrupted by a call to pause().') ||
    normalized.startsWith('the play() request was interrupted by a new load request.') ||
    normalized.startsWith(
      'the play() request was interrupted because the media was removed from the document.',
    )
  );
}

function isRecoverableReplayError(message: string): boolean {
  return isRecoverableHydrationError(message) || isRecoverableMediaPlaybackInterruption(message);
}

function isRecoverableExternalIntegrationConsoleError(message: string): boolean {
  const normalized = message.trim();
  const lower = normalized.toLowerCase();

  if (!/^\[[^\]\r\n]{1,80}\]\s+/u.test(normalized)) {
    return false;
  }

  if (
    /\b(?:typeerror|referenceerror|syntaxerror|rangeerror)\b/u.test(lower) ||
    lower.includes('cannot read properties') ||
    lower.includes('is not a function') ||
    lower.includes('is not defined')
  ) {
    return false;
  }

  return (
    /\b(?:error|failed|failure|unable|unavailable)\b/u.test(lower) &&
    /\b(?:client|init|initialization|initialize|integration|pixel|service|tracker|tracking|widget)\b/u.test(
      lower,
    )
  );
}

function consoleLocation(message: ConsoleMessage): ValidationConsoleError['location'] {
  const location = message.location();
  const url = location.url ? safeUrl(location.url) : undefined;

  if (!url && location.lineNumber === 0 && location.columnNumber === 0) {
    return undefined;
  }

  return {
    ...(url ? { url } : {}),
    lineNumber: location.lineNumber,
    columnNumber: location.columnNumber,
  };
}

function recordConsoleError(collector: ValidationCollector, message: ConsoleMessage): void {
  if (message.type() !== 'error') {
    return;
  }

  const rawText = message.text();
  debugValidationEvent('console-error', {
    url: message.location().url,
    message: rawText,
  });
  const rawLocation = message.location();
  const key = [rawText, rawLocation.url, rawLocation.lineNumber, rawLocation.columnNumber].join(
    '\0',
  );

  if (collector.consoleErrorKeys.has(key)) {
    return;
  }

  collector.consoleErrorKeys.add(key);
  const blocking =
    !isNetworkConsoleError(rawText) &&
    !isLocalPreviewEnvironmentConsoleError(rawText) &&
    !isKnownNonessentialConsoleError(rawText);
  const recoverableCandidate =
    blocking &&
    (isRecoverableReplayError(rawText) || isRecoverableExternalIntegrationConsoleError(rawText));
  const location = consoleLocation(message);
  const recorded = collector.budget.record('consoleErrors', (): ValidationConsoleError => ({
    text: diagnosticMessage('Console error', rawText),
    blocking,
    ...(recoverableCandidate ? { recoverableCandidate: true } : {}),
    ...(location ? { location } : {}),
  }));

  if (recorded) {
    collector.consoleErrors.push(recorded);
    if (recoverableCandidate) {
      collector.recoverableReplayConsoleErrors.add(recorded);
    }
  } else if (blocking) {
    collector.budget.markDroppedBlocking('consoleErrors');
  }
}

function recordPageError(collector: ValidationCollector, error: Error): void {
  debugValidationEvent('page-error', { message: error.stack ?? error.message });
  const key = [error.name, error.message, error.stack ?? ''].join('\0');

  if (collector.pageErrorKeys.has(key)) {
    return;
  }

  collector.pageErrorKeys.add(key);
  const recoverableCandidate = isRecoverableReplayError(error.message);
  const recorded = collector.budget.record('pageErrors', (): ValidationPageError => ({
    message: diagnosticMessage('Page error', error.message),
    ...(error.stack ? { stack: diagnosticMessage('Page error stack', error.stack) } : {}),
    ...(recoverableCandidate ? { recoverableCandidate: true } : {}),
  }));

  if (recorded) {
    collector.pageErrors.push(recorded);
    if (recoverableCandidate) {
      collector.recoverableReplayPageErrors.add(recorded);
    }
  } else {
    collector.budget.markDroppedBlocking('pageErrors');
  }
}

function ordinaryBlockingConsoleErrors(
  collector: ValidationCollector,
  values: readonly ValidationConsoleError[] = collector.consoleErrors,
): ValidationConsoleError[] {
  return values.filter(
    (message) => message.blocking && !collector.recoverableReplayConsoleErrors.has(message),
  );
}

function ordinaryPageErrors(
  collector: ValidationCollector,
  values: readonly ValidationPageError[] = collector.pageErrors,
): ValidationPageError[] {
  return values.filter((error) => !collector.recoverableReplayPageErrors.has(error));
}

function isPrivacySuppressedScreenshot(screenshot: ValidationScreenshotResult): boolean {
  return !screenshot.passed && Boolean(screenshot.error?.includes('closed Shadow DOM'));
}

function attachListeners(
  context: BrowserContext,
  page: Page,
  collector: ValidationCollector,
  localOrigin: string,
  sourceOrigin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): ValidationListeners {
  const inFlightRequests = new Set<Request>();
  const overflowInFlightRequests = new WeakSet<Request>();
  let overflowInFlightCount = 0;
  let lastNetworkActivity = Date.now();
  const markNetworkActivity = (): void => {
    lastNetworkActivity = Date.now();
  };
  const onRequest = (request: Request): void => {
    if (blocksNetworkQuiet(request, localOrigin)) {
      if (inFlightRequests.size < MAX_STRONGLY_TRACKED_IN_FLIGHT_REQUESTS) {
        inFlightRequests.add(request);
      } else {
        overflowInFlightRequests.add(request);
        overflowInFlightCount = Math.min(Number.MAX_SAFE_INTEGER, overflowInFlightCount + 1);
      }

      markNetworkActivity();
    }

    recordRequest(collector, request, localOrigin, sourceOrigin, allowedOrigins);
  };
  const onResponse = (response: Response): void => {
    if (blocksNetworkQuiet(response.request(), localOrigin)) {
      markNetworkActivity();
    }

    recordResponse(collector, response, localOrigin);
  };
  const finishRequest = (request: Request): void => {
    if (!blocksNetworkQuiet(request, localOrigin)) {
      return;
    }

    if (!inFlightRequests.delete(request) && overflowInFlightRequests.delete(request)) {
      overflowInFlightCount = Math.max(0, overflowInFlightCount - 1);
    }

    markNetworkActivity();
  };
  const onRequestFinished = (request: Request): void => finishRequest(request);
  const onRequestFailed = (request: Request): void => {
    finishRequest(request);
    const parsed = requestUrl(request);
    const failureText = request.failure()?.errorText.trim().toLowerCase();

    if (
      parsed &&
      isSupportedNetworkProtocol(parsed.protocol) &&
      canonicalOrigin(parsed) !== localOrigin &&
      failureText === 'csp'
    ) {
      recordRemoteDependency(
        collector,
        request.url(),
        request.resourceType(),
        localOrigin,
        sourceOrigin,
        allowedOrigins,
        request.method(),
        true,
      );
    }

    recordRequestFailure(collector, request, localOrigin);
  };
  const onConsole = (message: ConsoleMessage): void => recordConsoleError(collector, message);
  const onPageError = (error: Error): void => recordPageError(collector, error);
  const onWebSocket = (webSocket: { url(): string }): void => {
    markNetworkActivity();
    recordRemoteDependency(
      collector,
      webSocket.url(),
      'websocket',
      localOrigin,
      sourceOrigin,
      allowedOrigins,
    );
  };

  context.on('request', onRequest);
  context.on('response', onResponse);
  context.on('requestfinished', onRequestFinished);
  context.on('requestfailed', onRequestFailed);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('websocket', onWebSocket);

  return {
    detach: () => {
      context.off('request', onRequest);
      context.off('response', onResponse);
      context.off('requestfinished', onRequestFinished);
      context.off('requestfailed', onRequestFailed);
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('websocket', onWebSocket);
    },
    resetNetworkQuietWindow: markNetworkActivity,
    waitForNetworkQuiet: async (
      quietWindowMs,
      maximumWaitMs,
      signal,
    ): Promise<NetworkQuietResult> => {
      const startedAt = Date.now();
      const deadline = startedAt + maximumWaitMs;

      while (true) {
        if (signal.aborted) {
          throw abortReason(signal);
        }

        const now = Date.now();

        if (
          inFlightRequests.size === 0 &&
          overflowInFlightCount === 0 &&
          now - lastNetworkActivity >= quietWindowMs
        ) {
          return {
            reached: true,
            inFlightRequests: 0,
            quietForMs: Math.max(0, now - lastNetworkActivity),
            waitedMs: Math.max(0, now - startedAt),
          };
        }

        if (now >= deadline) {
          return {
            reached: false,
            inFlightRequests: inFlightRequests.size + overflowInFlightCount,
            quietForMs: Math.max(0, now - lastNetworkActivity),
            waitedMs: Math.max(0, now - startedAt),
          };
        }

        await new Promise<void>((resolveWait) => {
          setTimeout(resolveWait, Math.min(100, deadline - now));
        });
      }
    },
  };
}

async function waitForRenderedFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

function screenshotMaskLocators(page: Page): Locator[] {
  const frames = page.frames();

  if (frames.length > MAX_SCREENSHOT_MASK_FRAMES) {
    throw new PublicValidationError(
      'Screenshot masking was skipped because the page exceeded the frame limit',
    );
  }

  return frames.map((frame) => frame.locator(SENSITIVE_FORM_SELECTOR));
}

function screenshotContainsSensitiveMask(bytes: Uint8Array): boolean {
  const image = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));

  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (
      image.data[offset] === SCREENSHOT_MASK_RGBA[0] &&
      image.data[offset + 1] === SCREENSHOT_MASK_RGBA[1] &&
      image.data[offset + 2] === SCREENSHOT_MASK_RGBA[2] &&
      image.data[offset + 3] === SCREENSHOT_MASK_RGBA[3]
    ) {
      return true;
    }
  }

  return false;
}

async function captureSanitizedPageScreenshot(
  page: Page,
  closedShadowRootMonitor: ClosedShadowRootMonitor,
): Promise<{ bytes: Uint8Array; maskedSensitiveControls: boolean }> {
  if (await closedShadowRootMonitor.hasSeenClosedShadowRoot()) {
    throw new PublicValidationError(
      'Screenshot was not saved because closed Shadow DOM prevents complete form-value masking',
    );
  }

  const buffer = await page.screenshot({
    type: 'png',
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
    mask: screenshotMaskLocators(page),
    maskColor: SCREENSHOT_MASK_COLOR,
  });
  const bytes = Uint8Array.from(buffer);

  if (await closedShadowRootMonitor.hasSeenClosedShadowRoot()) {
    throw new PublicValidationError(
      'Screenshot was not saved because closed Shadow DOM prevents complete form-value masking',
    );
  }

  return {
    bytes,
    maskedSensitiveControls: screenshotContainsSensitiveMask(bytes),
  };
}

async function sampleFrameCanvases(
  frame: Frame,
  maxCanvases: number,
  deviceScaleFactor: number,
  remainingScreenshotPixels: { value: number },
  viewport: { width: number; height: number } | null,
  getViewportSnapshot: () => Promise<CanvasViewportSnapshot>,
): Promise<{ details: ValidationCanvasDetail[]; total: number }> {
  const canvases = frame.locator('canvas');
  const total = await canvases.count();
  const frameUrl = safeUrl(frame.url());
  const inspectedCount = Math.min(total, maxCanvases);
  const details = new Array<ValidationCanvasDetail | undefined>(inspectedCount);
  let nextIndex = 0;

  async function inspectCanvas(index: number): Promise<ValidationCanvasDetail> {
    const canvas = canvases.nth(index);

    try {
      const [visible, bounds, widthAttribute, heightAttribute] = await Promise.all([
        canvas.isVisible(),
        canvas.boundingBox(),
        canvas.getAttribute('width'),
        canvas.getAttribute('height'),
      ]);
      const cssWidth = Math.max(0, Math.round(bounds?.width ?? 0));
      const cssHeight = Math.max(0, Math.round(bounds?.height ?? 0));
      const base = {
        frameUrl,
        index,
        width: canvasDimension(widthAttribute, 300),
        height: canvasDimension(heightAttribute, 150),
        cssWidth,
        cssHeight,
      };

      if (!visible || !bounds || cssWidth === 0 || cssHeight === 0) {
        return {
          ...base,
          context: 'unknown',
          outcome: 'skipped',
          sampledPixels: 0,
        };
      }

      if (
        viewport &&
        (bounds.x >= viewport.width ||
          bounds.y >= viewport.height ||
          bounds.x + bounds.width <= 0 ||
          bounds.y + bounds.height <= 0)
      ) {
        return {
          ...base,
          context: 'unknown',
          outcome: 'skipped',
          sampledPixels: 0,
        };
      }

      const estimatedPixels =
        (Math.ceil(bounds.width * deviceScaleFactor) + 2) *
        (Math.ceil(bounds.height * deviceScaleFactor) + 2);

      if (
        !Number.isFinite(estimatedPixels) ||
        estimatedPixels <= 0 ||
        estimatedPixels > MAX_SCREENSHOT_PIXELS ||
        estimatedPixels > remainingScreenshotPixels.value
      ) {
        return {
          ...base,
          context: 'unknown',
          outcome: 'unreadable',
          sampledPixels: 0,
          error: 'Canvas screenshot fallback exceeded the shared pixel budget',
        };
      }

      remainingScreenshotPixels.value -= estimatedPixels;
      const sample = sampleCanvasViewportSnapshot(
        await getViewportSnapshot(),
        bounds,
        estimatedPixels,
      );
      return {
        ...base,
        context: 'unknown',
        outcome: sample.nonEmpty ? 'non-empty' : 'empty',
        sampledPixels: sample.sampledPixels,
      };
    } catch (error) {
      return {
        frameUrl,
        index,
        width: 0,
        height: 0,
        cssWidth: 0,
        cssHeight: 0,
        context: 'unknown',
        outcome: 'unreadable',
        sampledPixels: 0,
        error: errorMessage(error, 'Canvas screenshot inspection error'),
      };
    }
  }

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= inspectedCount) {
        return;
      }

      details[index] = await inspectCanvas(index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CANVAS_SAMPLE_CONCURRENCY, inspectedCount) }, () => worker()),
  );

  return {
    details: details.filter((detail): detail is ValidationCanvasDetail => detail !== undefined),
    total,
  };
}

function canvasDimension(value: string | null, fallback: number): number {
  if (value === null) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function sampleCanvasViewportSnapshot(
  snapshot: CanvasViewportSnapshot,
  bounds: CanvasBounds,
  maximumPixels: number,
): { nonEmpty: boolean; sampledPixels: number } {
  const left = Math.max(
    0,
    Math.floor((Math.max(0, bounds.x) / snapshot.cssWidth) * snapshot.image.width),
  );
  const top = Math.max(
    0,
    Math.floor((Math.max(0, bounds.y) / snapshot.cssHeight) * snapshot.image.height),
  );
  const right = Math.min(
    snapshot.image.width,
    Math.ceil(
      (Math.min(snapshot.cssWidth, bounds.x + bounds.width) / snapshot.cssWidth) *
        snapshot.image.width,
    ),
  );
  const bottom = Math.min(
    snapshot.image.height,
    Math.ceil(
      (Math.min(snapshot.cssHeight, bounds.y + bounds.height) / snapshot.cssHeight) *
        snapshot.image.height,
    ),
  );
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const pixels = width * height;

  if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > maximumPixels) {
    throw new PublicValidationError('Canvas screenshot exceeded its declared pixel budget');
  }

  let sampledPixels = 0;

  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      sampledPixels += 1;
      const alphaOffset = (y * snapshot.image.width + x) * 4 + 3;

      if ((snapshot.image.data[alphaOffset] ?? 0) > 0) {
        return {
          nonEmpty: true,
          sampledPixels,
        };
      }
    }
  }

  return {
    nonEmpty: false,
    sampledPixels,
  };
}

async function captureCanvasViewportSnapshot(page: Page): Promise<CanvasViewportSnapshot> {
  const viewport = page.viewportSize();

  if (!viewport) {
    throw new PublicValidationError('Canvas screenshot inspection requires a fixed viewport');
  }

  const session = await page.context().newCDPSession(page);
  let transparentBackground = false;

  try {
    await session.send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
    transparentBackground = true;
    const metrics = (await session.send('Page.getLayoutMetrics')) as {
      cssVisualViewport?: {
        pageX?: number;
        pageY?: number;
        clientWidth?: number;
        clientHeight?: number;
      };
    };
    const visualViewport = metrics.cssVisualViewport;
    const pageX = visualViewport?.pageX ?? 0;
    const pageY = visualViewport?.pageY ?? 0;
    const cssWidth = visualViewport?.clientWidth ?? viewport.width;
    const cssHeight = visualViewport?.clientHeight ?? viewport.height;

    if (
      !Number.isFinite(pageX) ||
      !Number.isFinite(pageY) ||
      !Number.isFinite(cssWidth) ||
      !Number.isFinite(cssHeight) ||
      cssWidth <= 0 ||
      cssHeight <= 0
    ) {
      throw new PublicValidationError(
        'Canvas screenshot inspection returned invalid viewport data',
      );
    }

    const captured = (await session.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      optimizeForSpeed: true,
      clip: {
        x: pageX,
        y: pageY,
        width: cssWidth,
        height: cssHeight,
        scale: 1,
      },
    })) as { data?: unknown };

    if (typeof captured.data !== 'string' || !captured.data) {
      throw new PublicValidationError('Canvas screenshot inspection returned no image data');
    }

    const bytes = Buffer.from(captured.data, 'base64');

    try {
      const image = PNG.sync.read(bytes);
      const pixels = image.width * image.height;

      if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > MAX_SCREENSHOT_PIXELS) {
        throw new PublicValidationError('Canvas screenshot exceeded the viewport pixel budget');
      }

      return {
        image,
        cssWidth,
        cssHeight,
      };
    } finally {
      bytes.fill(0);
    }
  } finally {
    if (transparentBackground) {
      await session.send('Emulation.setDefaultBackgroundColorOverride').catch(() => undefined);
    }

    await session.detach().catch(() => undefined);
  }
}

async function inspectCanvases(
  page: Page,
  deviceScaleFactor: number,
  closedShadowRootMonitor: ClosedShadowRootMonitor,
): Promise<ValidationCanvasResult> {
  const details: ValidationCanvasDetail[] = [];
  const frames = page.frames();
  const inspectedFrames = frames.slice(0, MAX_CANVAS_FRAMES);
  const remainingScreenshotPixels = {
    value: MAX_CANVAS_SCREENSHOT_TOTAL_PIXELS,
  };
  const viewport = page.viewportSize();
  let viewportSnapshot: Promise<CanvasViewportSnapshot> | undefined;
  const getViewportSnapshot = (): Promise<CanvasViewportSnapshot> => {
    viewportSnapshot ??= captureCanvasViewportSnapshot(page);
    return viewportSnapshot;
  };
  let omitted = Math.max(0, frames.length - inspectedFrames.length);
  let observedCanvases = 0;

  for (const frame of inspectedFrames) {
    const remaining = MAX_CANVAS_DETAILS - details.length;

    if (remaining <= 0) {
      omitted += 1;
      continue;
    }

    try {
      const sample = await sampleFrameCanvases(
        frame,
        remaining,
        deviceScaleFactor,
        remainingScreenshotPixels,
        viewport,
        getViewportSnapshot,
      );
      const frameDetails = sample.details;
      observedCanvases += sample.total;
      omitted += Math.max(0, sample.total - frameDetails.length);

      details.push(
        ...frameDetails.map((detail) => ({
          ...detail,
        })),
      );
    } catch (error) {
      if (details.length < MAX_CANVAS_DETAILS) {
        details.push({
          frameUrl: safeUrl(frame.url()),
          index: 0,
          width: 0,
          height: 0,
          cssWidth: 0,
          cssHeight: 0,
          context: 'unknown',
          outcome: 'unreadable',
          sampledPixels: 0,
          error: errorMessage(error, 'Canvas inspection error'),
        });
      } else {
        omitted += 1;
      }
    }
  }

  const closedShadowRootSeen = await closedShadowRootMonitor.hasSeenClosedShadowRoot();

  if (closedShadowRootSeen) {
    omitted += 1;
  }

  const applicable = details.filter((detail) => detail.outcome !== 'skipped');
  const nonEmpty = applicable.filter((detail) => detail.outcome === 'non-empty').length;
  const empty = applicable.filter((detail) => detail.outcome === 'empty').length;
  const unreadable = applicable.filter((detail) => detail.outcome === 'unreadable').length;
  const truncated = omitted > 0;

  return {
    checked: true,
    present: observedCanvases > 0 || details.length > 0 || closedShadowRootSeen,
    passed: truncated ? nonEmpty > 0 : applicable.length === 0 || nonEmpty > 0,
    truncated,
    omitted,
    inspected: applicable.length,
    nonEmpty,
    empty,
    unreadable,
    details,
  };
}

async function inspectCanvasesUntilSettled(
  page: Page,
  settleTimeoutMs: number,
  deviceScaleFactor: number,
  closedShadowRootMonitor: ClosedShadowRootMonitor,
): Promise<ValidationCanvasResult> {
  const deadline = Date.now() + settleTimeoutMs;
  let result = await inspectCanvases(page, deviceScaleFactor, closedShadowRootMonitor);

  while (
    settleTimeoutMs > 0 &&
    result.present &&
    result.inspected > 0 &&
    result.nonEmpty === 0 &&
    result.unreadable === 0 &&
    !result.truncated &&
    Date.now() < deadline
  ) {
    await page.waitForTimeout(Math.min(500, Math.max(1, deadline - Date.now())));
    await waitForRenderedFrame(page);
    result = await inspectCanvases(page, deviceScaleFactor, closedShadowRootMonitor);
  }

  return result;
}

function initialCanvasResult(): ValidationCanvasResult {
  return {
    checked: false,
    present: false,
    passed: false,
    truncated: false,
    omitted: 0,
    inspected: 0,
    nonEmpty: 0,
    empty: 0,
    unreadable: 0,
    details: [],
  };
}

function initialScreenshotResult(): ValidationScreenshotResult {
  return {
    passed: false,
    error: 'Screenshot was not attempted',
  };
}

function initialInteractionResult(): ValidationInteractionResult {
  return {
    checked: false,
    passed: true,
    attempted: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    actions: [],
    errors: [],
  };
}

function initialPerceptualResult(): ValidationPerceptualResult {
  return {
    checked: false,
    passed: true,
    compared: 0,
    matched: 0,
    partial: 0,
    mismatched: 0,
    errors: 0,
    checkpoints: [],
  };
}

function normalizeVisualReferences(
  input: Readonly<Record<string, Uint8Array>> | undefined,
  actions: readonly ValidationAction[],
): Map<string, Uint8Array> {
  if (input === undefined) {
    return new Map();
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('visualReferences must be an object keyed by checkpoint id');
  }

  const allowedIds = new Set(['initial', ...actions.map((action) => action.id)]);
  const references = new Map<string, Uint8Array>();
  let totalBytes = 0;

  for (const [id, bytes] of Object.entries(input)) {
    if (!allowedIds.has(id)) {
      throw new TypeError(`visualReferences contains an unknown checkpoint id: ${id}`);
    }

    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new TypeError(`visualReferences.${id} must contain PNG bytes`);
    }

    if (bytes.byteLength > MAX_VISUAL_REFERENCE_BYTES) {
      throw new TypeError(
        `visualReferences.${id} exceeds the ${MAX_VISUAL_REFERENCE_BYTES} byte limit`,
      );
    }

    totalBytes += bytes.byteLength;

    if (totalBytes > MAX_VISUAL_REFERENCE_TOTAL_BYTES) {
      throw new TypeError(
        `visualReferences exceeds the ${MAX_VISUAL_REFERENCE_TOTAL_BYTES} byte total limit`,
      );
    }

    references.set(id, Uint8Array.from(bytes));
  }

  return references;
}

function checkpointPathSegment(id: string): string {
  return id.replaceAll(/[^A-Za-z0-9._-]/gu, '-');
}

interface CapturedCheckpoint {
  checkpoint: ValidationCheckpointResult;
  screenshotPaths: string[];
  referencePaths: string[];
  diffPaths: string[];
}

async function captureCheckpoint(
  page: Page,
  outputDirectory: string,
  input: {
    id: string;
    label: string;
    actionId?: string;
    actualPath: string;
    reference?: Uint8Array;
    settings: ValidationPerceptualSettings;
    signal: AbortSignal;
    closedShadowRootMonitor: ClosedShadowRootMonitor;
  },
): Promise<CapturedCheckpoint> {
  const screenshotPaths: string[] = [];
  const referencePaths: string[] = [];
  const diffPaths: string[] = [];
  let screenshot: ValidationScreenshotResult;
  let actualBytes: Uint8Array | undefined;

  try {
    const captured = await captureSanitizedPageScreenshot(page, input.closedShadowRootMonitor);
    actualBytes = captured.bytes;
    await atomicWriteFile(join(outputDirectory, input.actualPath), actualBytes);
    screenshot = {
      passed: true,
      path: input.actualPath,
      ...(captured.maskedSensitiveControls ? { maskedSensitiveControls: true } : {}),
    };
    screenshotPaths.push(input.actualPath);
  } catch (error) {
    screenshot = {
      passed: false,
      error: errorMessage(error, 'Checkpoint screenshot error'),
    };
  }

  if (!input.reference) {
    return {
      checkpoint: {
        id: input.id,
        label: input.label,
        ...(input.actionId ? { actionId: input.actionId } : {}),
        screenshot,
        comparison: {
          outcome: 'not-compared',
          actualPath: input.actualPath,
          reason: 'No trusted reference screenshot was supplied for this checkpoint.',
        },
      },
      screenshotPaths,
      referencePaths,
      diffPaths,
    };
  }

  const segment = checkpointPathSegment(input.id);
  const referencePath = `screenshots/references/checkpoint-${segment}.png`;
  const diffPath = `screenshots/diffs/checkpoint-${segment}.png`;

  if (!actualBytes) {
    return {
      checkpoint: {
        id: input.id,
        label: input.label,
        ...(input.actionId ? { actionId: input.actionId } : {}),
        screenshot,
        comparison: {
          outcome: 'error',
          actualPath: input.actualPath,
          settings: input.settings,
          reason:
            'The actual checkpoint screenshot could not be captured, so the reference was not persisted.',
        },
      },
      screenshotPaths,
      referencePaths,
      diffPaths,
    };
  }

  if (screenshot.maskedSensitiveControls) {
    return {
      checkpoint: {
        id: input.id,
        label: input.label,
        ...(input.actionId ? { actionId: input.actionId } : {}),
        screenshot,
        comparison: {
          outcome: 'not-compared',
          actualPath: input.actualPath,
          settings: input.settings,
          reason: 'Reference comparison was skipped because sensitive form controls were masked.',
        },
      },
      screenshotPaths,
      referencePaths,
      diffPaths,
    };
  }

  await atomicWriteFile(join(outputDirectory, referencePath), input.reference);
  referencePaths.push(referencePath);

  const comparison = await comparePngScreenshots(
    actualBytes,
    input.reference,
    {
      actualPath: input.actualPath,
      referencePath,
      diffPath,
    },
    input.settings,
    input.signal,
  );

  if (comparison.diff) {
    await atomicWriteFile(join(outputDirectory, diffPath), comparison.diff);
    diffPaths.push(diffPath);
  }

  return {
    checkpoint: {
      id: input.id,
      label: input.label,
      ...(input.actionId ? { actionId: input.actionId } : {}),
      screenshot,
      comparison: comparison.comparison,
    },
    screenshotPaths,
    referencePaths,
    diffPaths,
  };
}

interface CollectorEventSnapshot {
  httpFailures: number;
  consoleErrors: number;
  pageErrors: number;
  remoteDependencies: number;
  droppedEvents: number;
}

function collectorEventSnapshot(collector: ValidationCollector): CollectorEventSnapshot {
  return {
    httpFailures: collector.httpFailureEvents.length,
    consoleErrors: collector.consoleErrors.length,
    pageErrors: collector.pageErrors.length,
    remoteDependencies: collector.remoteDependencyEvents.length,
    droppedEvents: collector.budget.droppedEvents(),
  };
}

function uniqueHttpFailures(failures: readonly ValidationHttpFailure[]): ValidationHttpFailure[] {
  return [...new Map(failures.map((failure) => [requestFailureKey(failure), failure])).values()];
}

function uniqueRemoteDependencies(
  dependencies: readonly ValidationRemoteDependency[],
): ValidationRemoteDependency[] {
  const unique = new Map<string, ValidationRemoteDependency>();

  for (const dependency of dependencies) {
    const key = remoteDependencyKey(dependency);
    const existing = unique.get(key);

    if (existing) {
      mergeRemoteDependency(existing, dependency);
    } else {
      unique.set(key, { ...dependency });
    }
  }

  return [...unique.values()];
}

function collectorEvidenceSince(
  collector: ValidationCollector,
  snapshot: CollectorEventSnapshot,
): Pick<
  ValidationActionResult,
  'httpFailures' | 'pageErrors' | 'consoleErrors' | 'remoteDependencies'
> {
  return {
    httpFailures: uniqueHttpFailures(collector.httpFailureEvents.slice(snapshot.httpFailures)),
    pageErrors: collector.pageErrors.slice(snapshot.pageErrors),
    consoleErrors: collector.consoleErrors.slice(snapshot.consoleErrors),
    remoteDependencies: uniqueRemoteDependencies(
      collector.remoteDependencyEvents.slice(snapshot.remoteDependencies),
    ),
  };
}

function skippedActionResult(action: ValidationAction, reason: string): ValidationActionResult {
  return {
    id: action.id,
    label: sanitizeTrustedText(validationActionLabel(action)),
    type: action.type,
    status: 'skipped',
    durationMs: 0,
    error: reason,
    httpFailures: [],
    pageErrors: [],
    consoleErrors: [],
    remoteDependencies: [],
  };
}

function aggregatePerceptualResults(
  checkpoints: ValidationCheckpointResult[],
): ValidationPerceptualResult {
  const compared = checkpoints.filter(
    (checkpoint) => checkpoint.comparison.outcome !== 'not-compared',
  );
  const matched = compared.filter((checkpoint) => checkpoint.comparison.outcome === 'match').length;
  const partial = compared.filter(
    (checkpoint) => checkpoint.comparison.outcome === 'partial',
  ).length;
  const mismatched = compared.filter(
    (checkpoint) => checkpoint.comparison.outcome === 'mismatch',
  ).length;
  const errors = compared.filter((checkpoint) => checkpoint.comparison.outcome === 'error').length;

  return {
    checked: compared.length > 0,
    passed: partial === 0 && mismatched === 0 && errors === 0,
    compared: compared.length,
    matched,
    partial,
    mismatched,
    errors,
    checkpoints,
  };
}

function mergeNetworkEvidence(target: ValidationCollector, source: ValidationCollector): void {
  for (const failure of source.httpFailures.values()) {
    target.httpFailures.set(requestFailureKey(failure), failure);
  }

  target.httpFailureEvents.push(...source.httpFailureEvents);

  for (const dependency of source.remoteDependencies.values()) {
    const key = remoteDependencyKey(dependency);
    const existing = target.remoteDependencies.get(key);

    if (existing) {
      mergeRemoteDependency(existing, dependency);
    } else {
      target.remoteDependencies.set(key, { ...dependency });
    }
  }

  target.remoteDependencyEvents.push(...source.remoteDependencyEvents);
  for (const request of source.blockedRemoteRequests) {
    target.blockedRemoteRequests.add(request);
  }
  for (const origin of source.transportBlockedOrigins) {
    target.transportBlockedOrigins.add(origin);
  }
}

interface InteractionValidationOutput {
  interactions: ValidationInteractionResult;
  perceptual: ValidationPerceptualResult;
  collector: ValidationCollector;
  warnings: string[];
  screenshotPaths: string[];
  referencePaths: string[];
  diffPaths: string[];
}

async function runInteractionValidation(input: {
  browser: Browser;
  entryUrl: URL;
  outputDirectory: string;
  localOrigin: string;
  sourceOrigin: string | undefined;
  allowedOrigins: ReadonlySet<string>;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
  };
  runtimeCapabilities: RuntimeCapabilities | undefined;
  actions: readonly ValidationAction[];
  references: ReadonlyMap<string, Uint8Array>;
  settings: ValidationPerceptualSettings;
  timeoutMs: number;
  settleTimeMs: number;
  actionTimeoutMs: number;
  actionSettleTimeMs: number;
  signal: AbortSignal;
  budget: DiagnosticBudget;
}): Promise<InteractionValidationOutput> {
  const collector = createCollector(input.budget);
  const droppedBeforeReplay = input.budget.droppedEvents();
  const warnings: string[] = [];
  const actionResults: ValidationActionResult[] = [];
  const checkpoints: ValidationCheckpointResult[] = [];
  const screenshotPaths: string[] = [];
  const referencePaths: string[] = [];
  const diffPaths: string[] = [];
  const errors: string[] = [];
  let context: BrowserContext | undefined;
  let listeners: ValidationListeners | undefined;
  let removeRequestGuard: (() => Promise<void>) | undefined;
  let networkProxy: ValidationNetworkProxy | undefined;
  let extraPageGuard: ExtraPageGuard | undefined;
  let closedShadowRootMonitor: ClosedShadowRootMonitor | undefined;
  let sequenceFailed = false;

  try {
    networkProxy = await startLocalNetworkGuard(collector, input.localOrigin, input.signal);
    context = await input.browser.newContext({
      viewport: {
        width: input.viewport.width,
        height: input.viewport.height,
      },
      deviceScaleFactor: input.viewport.deviceScaleFactor,
      serviceWorkers: 'block',
      acceptDownloads: false,
      proxy: {
        server: networkProxy.server,
      },
    });
    const closedShadowProbeKey = await installValidationRuntimeGuards(
      context,
      input.runtimeCapabilities,
    );
    const page = await context.newPage();
    closedShadowRootMonitor = await startClosedShadowRootMonitor(
      context,
      page,
      closedShadowProbeKey,
    );
    extraPageGuard = installExtraPageGuard(context, page);
    removeRequestGuard = await installLocalRequestGuard(
      context,
      collector,
      input.localOrigin,
      input.sourceOrigin,
      input.allowedOrigins,
    );
    listeners = attachListeners(
      context,
      page,
      collector,
      input.localOrigin,
      input.sourceOrigin,
      input.allowedOrigins,
    );
    const response = await page.goto(input.entryUrl.href, {
      waitUntil: 'load',
      timeout: input.timeoutMs,
    });
    const finalUrl = new URL(page.url());
    const documentError = await entryDocumentError(page);

    if (
      response === null ||
      response.status() >= 400 ||
      canonicalOrigin(finalUrl) !== input.localOrigin ||
      documentError
    ) {
      throw new PublicValidationError(
        documentError ??
          `Interaction replay entry failed with HTTP ${response?.status() ?? 'unknown'}.`,
      );
    }

    const networkQuiet = await listeners.waitForNetworkQuiet(
      input.settleTimeMs,
      initialNetworkQuietMaximumWaitMs(input.settleTimeMs),
      input.signal,
    );

    if (!networkQuiet.reached) {
      errors.push(
        `Interaction replay did not become quiet for ${input.settleTimeMs} ms before the bounded wait ended with ${networkQuiet.inFlightRequests} request(s) still active and ${networkQuiet.quietForMs} ms of quiet observed.`,
      );
      sequenceFailed = true;
    }

    await waitForRenderedFrame(page);
    const initialBlockingConsoleErrors = ordinaryBlockingConsoleErrors(collector);
    const initialPageErrors = ordinaryPageErrors(collector);

    if (initialPageErrors.length > 0) {
      errors.push(
        `${initialPageErrors.length} uncaught page error(s) occurred while starting interaction replay.`,
      );
      sequenceFailed = true;
    }

    if (initialBlockingConsoleErrors.length > 0) {
      errors.push(
        `${initialBlockingConsoleErrors.length} blocking console error(s) occurred while starting interaction replay.`,
      );
      sequenceFailed = true;
    }

    if (extraPageGuard.count() > 0) {
      errors.push(
        `${extraPageGuard.count()} additional page(s) opened while interaction replay was starting and were closed.`,
      );
      sequenceFailed = true;
    }

    if (input.budget.droppedEvents() > droppedBeforeReplay) {
      errors.push(
        'Interaction diagnostics exceeded the evidence limits while replay was starting.',
      );
      sequenceFailed = true;
    }

    const initialReference = input.references.get('initial');
    const initialCheckpoint = await captureCheckpoint(page, input.outputDirectory, {
      id: 'initial',
      label: 'Initial interaction state',
      actualPath: INTERACTION_INITIAL_SCREENSHOT_PATH,
      ...(initialReference ? { reference: initialReference } : {}),
      settings: input.settings,
      signal: input.signal,
      closedShadowRootMonitor,
    });
    checkpoints.push(initialCheckpoint.checkpoint);
    screenshotPaths.push(...initialCheckpoint.screenshotPaths);
    referencePaths.push(...initialCheckpoint.referencePaths);
    diffPaths.push(...initialCheckpoint.diffPaths);

    if (isPrivacySuppressedScreenshot(initialCheckpoint.checkpoint.screenshot)) {
      warnings.push(
        'The initial interaction screenshot was not saved because closed Shadow DOM prevents complete form-value masking.',
      );
    } else if (!initialCheckpoint.checkpoint.screenshot.passed) {
      errors.push('The initial interaction checkpoint could not be captured.');
      sequenceFailed = true;
    }

    for (const [index, action] of input.actions.entries()) {
      if (sequenceFailed) {
        actionResults.push(
          skippedActionResult(action, 'Skipped because an earlier interaction step failed.'),
        );
        continue;
      }

      const snapshot = collectorEventSnapshot(collector);
      const extraPagesBeforeAction = extraPageGuard.count();
      const startedAt = Date.now();
      let actionError: string | undefined;

      try {
        await executeValidationAction(page, action, input.actionTimeoutMs);
        listeners.resetNetworkQuietWindow();
        const actionSettleTimeMs = action.settleTimeMs ?? input.actionSettleTimeMs;

        if (actionSettleTimeMs > 0) {
          const networkQuiet = await listeners.waitForNetworkQuiet(
            actionSettleTimeMs,
            actionNetworkQuietMaximumWaitMs(actionSettleTimeMs),
            input.signal,
          );

          if (!networkQuiet.reached) {
            throw new PublicValidationError(
              `The action did not reach ${actionSettleTimeMs} ms of network quiet before the bounded wait ended with ${networkQuiet.inFlightRequests} request(s) still active and ${networkQuiet.quietForMs} ms of quiet observed.`,
            );
          }
        }

        await waitForRenderedFrame(page);
        const extraPages = extraPageGuard.count() - extraPagesBeforeAction;

        if (extraPages > 0) {
          throw new PublicValidationError(
            `The action opened ${extraPages} additional page(s), which were closed.`,
          );
        }
      } catch (error) {
        if (input.signal.aborted) {
          throw abortReason(input.signal);
        }

        actionError = errorMessage(error, 'Interaction action error');
      }

      const checkpointPath = `screenshots/interactions/${String(index + 1).padStart(
        2,
        '0',
      )}-${checkpointPathSegment(action.id)}.png`;
      const actionReference = input.references.get(action.id);
      const checkpoint = await captureCheckpoint(page, input.outputDirectory, {
        id: action.id,
        label: sanitizeTrustedText(validationActionLabel(action)),
        actionId: action.id,
        actualPath: checkpointPath,
        ...(actionReference ? { reference: actionReference } : {}),
        settings: normalizedPerceptualSettings(action.perceptual, input.settings),
        signal: input.signal,
        closedShadowRootMonitor,
      });
      checkpoints.push(checkpoint.checkpoint);
      screenshotPaths.push(...checkpoint.screenshotPaths);
      referencePaths.push(...checkpoint.referencePaths);
      diffPaths.push(...checkpoint.diffPaths);
      const evidence = collectorEvidenceSince(collector, snapshot);
      const blockingConsoleErrors = ordinaryBlockingConsoleErrors(
        collector,
        evidence.consoleErrors,
      );
      const pageErrors = ordinaryPageErrors(collector, evidence.pageErrors);

      if (!actionError && isPrivacySuppressedScreenshot(checkpoint.checkpoint.screenshot)) {
        warnings.push(
          `Interaction ${sanitizeTrustedText(action.id)} completed without a saved screenshot because closed Shadow DOM prevents complete form-value masking.`,
        );
      } else if (!actionError && !checkpoint.checkpoint.screenshot.passed) {
        actionError = checkpoint.checkpoint.screenshot.error ?? 'Checkpoint screenshot failed.';
      }

      if (!actionError && pageErrors.length > 0) {
        actionError = `${pageErrors.length} uncaught page error(s) followed the action.`;
      }

      if (!actionError && blockingConsoleErrors.length > 0) {
        actionError = `${blockingConsoleErrors.length} blocking console error(s) followed the action.`;
      }

      if (!actionError && evidence.httpFailures.length > 0) {
        actionError = `${evidence.httpFailures.length} HTTP or network failure(s) followed the action.`;
      }

      if (!actionError && evidence.remoteDependencies.length > 0) {
        actionError = `${evidence.remoteDependencies.length} non-local request(s) followed the action and were blocked.`;
      }

      if (!actionError && input.budget.droppedEvents() > snapshot.droppedEvents) {
        actionError = 'Diagnostic evidence was truncated while the action was running.';
      }

      const status = actionError ? ('failed' as const) : ('passed' as const);
      actionResults.push({
        id: action.id,
        label: sanitizeTrustedText(validationActionLabel(action)),
        type: action.type,
        status,
        durationMs: Math.max(0, Date.now() - startedAt),
        checkpointId: action.id,
        ...(actionError ? { error: actionError } : {}),
        ...evidence,
      });

      if (actionError) {
        sequenceFailed = true;
      }
    }
  } catch (error) {
    if (input.signal.aborted) {
      throw abortReason(input.signal);
    }

    errors.push(`Interaction replay failed: ${errorMessage(error, 'Interaction replay error')}`);

    for (const action of input.actions.slice(actionResults.length)) {
      actionResults.push(
        skippedActionResult(action, 'Skipped because the interaction replay could not start.'),
      );
    }
  } finally {
    listeners?.detach();
    extraPageGuard?.detach();
    await removeRequestGuard?.();
    await closedShadowRootMonitor?.close();
    await context?.close().catch(() => undefined);
    await networkProxy?.close();
  }

  const attempted = actionResults.filter((action) => action.status !== 'skipped').length;
  const completed = actionResults.filter((action) => action.status === 'passed').length;
  const failed = actionResults.filter((action) => action.status === 'failed').length;
  const skipped = actionResults.filter((action) => action.status === 'skipped').length;
  const interactions: ValidationInteractionResult = {
    checked: input.actions.length > 0 || input.references.size > 0,
    passed: errors.length === 0 && failed === 0 && skipped === 0,
    attempted,
    completed,
    failed,
    skipped,
    actions: actionResults,
    errors,
  };

  return {
    interactions,
    perceptual: aggregatePerceptualResults(checkpoints),
    collector,
    warnings,
    screenshotPaths,
    referencePaths,
    diffPaths,
  };
}

async function entryDocumentError(page: Page): Promise<string | undefined> {
  const inspection = await page.evaluate(() => {
    const text = document.documentElement?.textContent ?? '';
    let replacementCharacters = 0;
    let controlCharacters = 0;

    for (const character of text) {
      if (character === '\uFFFD') {
        replacementCharacters += 1;
        continue;
      }

      const codePoint = character.codePointAt(0);

      if (
        codePoint !== undefined &&
        codePoint < 32 &&
        character !== '\t' &&
        character !== '\n' &&
        character !== '\r'
      ) {
        controlCharacters += 1;
      }
    }

    return {
      textLength: text.length,
      replacementCharacters,
      controlCharacters,
    };
  });

  if (inspection.textLength < 16) {
    return undefined;
  }

  const replacementRatio = inspection.replacementCharacters / inspection.textLength;
  const controlRatio = inspection.controlCharacters / inspection.textLength;

  if (
    (inspection.replacementCharacters >= 3 && replacementRatio >= 0.01) ||
    (inspection.controlCharacters >= 3 && controlRatio >= 0.01)
  ) {
    return 'Entry document appears to contain undecoded or binary data';
  }

  return undefined;
}

function droppedBlockingDiagnostics(diagnostics: ValidationDiagnosticsResult): number {
  return (
    diagnostics.categories.consoleErrors.droppedBlocking +
    diagnostics.categories.pageErrors.droppedBlocking
  );
}

function calculateStatus(
  entry: ValidationEntryResult,
  httpFailures: readonly ValidationHttpFailure[],
  pageErrors: readonly ValidationPageError[],
  blockingConsoleErrors: readonly ValidationConsoleError[],
  remoteDependencies: readonly ValidationRemoteDependency[],
  screenshot: ValidationScreenshotResult,
  canvas: ValidationCanvasResult,
  interactions: ValidationInteractionResult,
  perceptual: ValidationPerceptualResult,
  diagnostics: ValidationDiagnosticsResult,
  recoverableReplayErrors: number,
  runnerError: string | undefined,
): ValidationStatus {
  const confirmedBlankCanvas =
    canvas.checked &&
    !canvas.truncated &&
    canvas.inspected > 0 &&
    canvas.nonEmpty === 0 &&
    canvas.unreadable === 0;

  if (
    runnerError ||
    !entry.ok ||
    pageErrors.length > 0 ||
    blockingConsoleErrors.length > 0 ||
    droppedBlockingDiagnostics(diagnostics) > 0 ||
    confirmedBlankCanvas
  ) {
    return 'failed';
  }

  if (
    httpFailures.length > 0 ||
    remoteDependencies.length > 0 ||
    !screenshot.passed ||
    (canvas.checked && !canvas.passed) ||
    canvas.truncated ||
    (interactions.checked && !interactions.passed) ||
    (perceptual.checked && !perceptual.passed) ||
    diagnostics.truncated ||
    recoverableReplayErrors > 0
  ) {
    return 'partial';
  }

  return 'complete';
}

function calculateScore(
  status: ValidationStatus,
  entry: ValidationEntryResult,
  httpFailures: readonly ValidationHttpFailure[],
  pageErrors: readonly ValidationPageError[],
  blockingConsoleErrors: readonly ValidationConsoleError[],
  remoteDependencies: readonly ValidationRemoteDependency[],
  screenshot: ValidationScreenshotResult,
  canvas: ValidationCanvasResult,
  interactions: ValidationInteractionResult,
  perceptual: ValidationPerceptualResult,
): number {
  if (!entry.ok) {
    return 0;
  }

  const entryScore = 25;
  const resourceScore = Math.max(0, 25 - Math.min(25, httpFailures.length * 5));
  const runtimeScore = pageErrors.length === 0 && blockingConsoleErrors.length === 0 ? 15 : 0;
  const remoteScore = Math.max(0, 15 - Math.min(15, remoteDependencies.length * 5));
  const comparedSimilarities = perceptual.checkpoints.flatMap((checkpoint) =>
    checkpoint.comparison.similarity === undefined ? [] : [checkpoint.comparison.similarity],
  );
  const visualScore = perceptual.checked
    ? Math.round(
        10 *
          (comparedSimilarities.length === 0
            ? 0
            : comparedSimilarities.reduce((total, value) => total + value, 0) /
              comparedSimilarities.length),
      )
    : (screenshot.passed ? 5 : 0) +
      (canvas.checked ? (canvas.passed ? 5 : canvas.unreadable > 0 ? 2 : 0) : 0);
  const interactionScore = interactions.checked
    ? Math.round(
        10 *
          (interactions.actions.length === 0
            ? interactions.passed
              ? 1
              : 0
            : interactions.completed / interactions.actions.length),
      )
    : 10;
  const rawScore = Math.round(
    entryScore + resourceScore + runtimeScore + remoteScore + visualScore + interactionScore,
  );

  if (status === 'failed') {
    return Math.min(59, rawScore);
  }

  return status === 'partial' ? Math.min(99, rawScore) : 100;
}

function buildMessages(
  entry: ValidationEntryResult,
  httpFailures: readonly ValidationHttpFailure[],
  local404s: readonly ValidationHttpFailure[],
  pageErrors: readonly ValidationPageError[],
  blockingConsoleErrors: readonly ValidationConsoleError[],
  remoteDependencies: readonly ValidationRemoteDependency[],
  screenshot: ValidationScreenshotResult,
  canvas: ValidationCanvasResult,
  interactions: ValidationInteractionResult,
  perceptual: ValidationPerceptualResult,
  diagnostics: ValidationDiagnosticsResult,
  recoverableReplayErrors: number,
  runnerError: string | undefined,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (runnerError) {
    errors.push(runnerError);
  } else if (!entry.ok) {
    errors.push(`Local entry failed: ${entry.error ?? entry.httpStatus ?? 'unknown error'}`);
  }

  if (pageErrors.length > 0) {
    errors.push(`${pageErrors.length} uncaught page error(s) were recorded.`);
    errors.push(...pageErrors.slice(0, 5).map((error) => `Page error: ${error.message}`));
  }

  if (blockingConsoleErrors.length > 0) {
    errors.push(`${blockingConsoleErrors.length} blocking console error(s) were recorded.`);
    errors.push(
      ...blockingConsoleErrors.slice(0, 5).map((message) => `Console error: ${message.text}`),
    );
  }

  if (recoverableReplayErrors > 0) {
    warnings.push(
      `${recoverableReplayErrors} recoverable client-runtime error event(s) were retained as warnings after the local entry, resources, visual evidence, interactions, and diagnostics passed.`,
    );
  }

  if (
    canvas.checked &&
    !canvas.truncated &&
    canvas.inspected > 0 &&
    canvas.nonEmpty === 0 &&
    canvas.unreadable === 0
  ) {
    errors.push('All visible Canvas/WebGL surfaces sampled as empty.');
  }

  if (httpFailures.length > 0) {
    warnings.push(`${httpFailures.length} HTTP or network request failure(s) were recorded.`);
    warnings.push(
      ...httpFailures
        .slice(0, 5)
        .map(
          (failure) =>
            `${failure.status ? `HTTP ${failure.status}` : 'Request failed'}: ${failure.url}`,
        ),
    );
  }

  if (local404s.length > 0) {
    warnings.push(`${local404s.length} local resource request(s) returned HTTP 404.`);
  }

  if (remoteDependencies.length > 0) {
    const blocked = remoteDependencies.filter((dependency) => dependency.blocked).length;
    warnings.push(
      `${remoteDependencies.length} unexpected non-local request(s) were recorded; ${blocked} were blocked before leaving the validation context.`,
    );
    warnings.push(
      ...remoteDependencies
        .slice(0, 5)
        .map((dependency) => `${dependency.reason}: ${dependency.url}`),
    );
  }

  if (!screenshot.passed) {
    warnings.push(`First-view screenshot was not saved: ${screenshot.error ?? 'unknown error'}.`);
  }

  if (canvas.checked && canvas.nonEmpty === 0 && canvas.unreadable > 0) {
    warnings.push(`${canvas.unreadable} Canvas/WebGL surface(s) could not be sampled.`);
  }

  if (canvas.truncated) {
    warnings.push(
      `${canvas.omitted} Canvas/frame evidence item(s) were omitted after reaching the inspection limit.`,
    );
  }

  if (interactions.checked && !interactions.passed) {
    warnings.push(
      `Scripted interaction validation completed ${interactions.completed} of ${interactions.actions.length} action(s).`,
    );
    warnings.push(...interactions.errors);
    warnings.push(
      ...interactions.actions
        .filter((action) => action.status !== 'passed')
        .slice(0, 5)
        .map(
          (action) =>
            `Interaction ${action.id} ${action.status}: ${action.error ?? 'no evidence was captured'}`,
        ),
    );
  }

  if (perceptual.checked && !perceptual.passed) {
    warnings.push(
      `Perceptual comparison found ${perceptual.partial} partial, ${perceptual.mismatched} mismatched, and ${perceptual.errors} unreadable checkpoint(s).`,
    );
  }

  if (diagnostics.truncated) {
    warnings.push(
      `${diagnostics.droppedEvents} diagnostic event(s) were omitted after reaching the ${diagnostics.eventByteBudget} byte or per-category evidence limit.`,
    );
  }

  const droppedBlocking = droppedBlockingDiagnostics(diagnostics);

  if (droppedBlocking > 0) {
    errors.push(
      `${droppedBlocking} blocking runtime error event(s) were detected after diagnostic evidence limits were reached.`,
    );
  }

  return { errors, warnings };
}

async function closeBrowser(context: BrowserContext | undefined, browser: Browser | undefined) {
  const closeOperations: Promise<void>[] = [];

  if (context) {
    closeOperations.push(context.close());
  }

  if (browser) {
    closeOperations.push(browser.close());
  }

  await Promise.allSettled(closeOperations);
}

export async function runValidation(options: RunValidationOptions): Promise<ValidationResult> {
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const settleTimeMs = nonNegativeInteger(
    options.settleTimeMs,
    DEFAULT_SETTLE_TIME_MS,
    'settleTimeMs',
  );
  const canvasSettleTimeoutMs = nonNegativeInteger(
    options.canvasSettleTimeoutMs,
    0,
    'canvasSettleTimeoutMs',
  );
  const actionTimeoutMs = positiveInteger(
    options.actionTimeoutMs,
    DEFAULT_ACTION_TIMEOUT_MS,
    'actionTimeoutMs',
  );
  const actionSettleTimeMs = nonNegativeInteger(
    options.actionSettleTimeMs,
    DEFAULT_ACTION_SETTLE_TIME_MS,
    'actionSettleTimeMs',
  );
  const actions = normalizeValidationActions(options.actions);
  const references = normalizeVisualReferences(options.visualReferences, actions);
  const perceptualSettings = normalizedPerceptualSettings(options.perceptual);
  const entryUrl = parseLocalEntry(options.entryUrl);
  const localOrigin = canonicalOrigin(entryUrl);
  const sourceOrigin = options.sourceUrl ? parseOrigin(options.sourceUrl, 'sourceUrl') : undefined;
  const allowedOrigins = new Set(
    (options.allowedRemoteOrigins ?? []).map((origin) =>
      parseOrigin(origin, 'allowedRemoteOrigins'),
    ),
  );
  const viewport = {
    width: positiveInteger(options.viewport?.width, DEFAULT_VIEWPORT.width, 'viewport.width'),
    height: positiveInteger(options.viewport?.height, DEFAULT_VIEWPORT.height, 'viewport.height'),
    deviceScaleFactor: positiveNumber(
      options.viewport?.deviceScaleFactor,
      DEFAULT_VIEWPORT.deviceScaleFactor,
      'viewport.deviceScaleFactor',
    ),
  };
  const screenshotPixels =
    viewport.width * viewport.height * viewport.deviceScaleFactor * viewport.deviceScaleFactor;

  if (
    viewport.width > MAX_VIEWPORT_DIMENSION ||
    viewport.height > MAX_VIEWPORT_DIMENSION ||
    viewport.deviceScaleFactor > MAX_DEVICE_SCALE_FACTOR ||
    !Number.isFinite(screenshotPixels) ||
    screenshotPixels > MAX_SCREENSHOT_PIXELS
  ) {
    throw new TypeError(
      'viewport exceeds the supported dimensions, device scale factor, or screenshot pixel budget',
    );
  }

  const outputDirectory = options.outputDirectory;
  const startedAt = new Date();
  const diagnosticBudget = new DiagnosticBudget();
  const collector = createCollector(diagnosticBudget);
  const monitor = createAbortMonitor(options.signal, timeoutMs);
  try {
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let listeners: ValidationListeners | undefined;
    let removeRequestGuard: (() => Promise<void>) | undefined;
    let networkProxy: ValidationNetworkProxy | undefined;
    let extraPageGuard: ExtraPageGuard | undefined;
    let closedShadowRootMonitor: ClosedShadowRootMonitor | undefined;
    let runnerError: string | undefined;
    let networkQuietWarning: string | undefined;
    let extraPageWarning: string | undefined;
    let entry: ValidationEntryResult = {
      requestedUrl: safeUrl(entryUrl.href),
      ok: false,
      error: 'Entry navigation was not attempted',
    };
    let screenshot = initialScreenshotResult();
    let canvas = initialCanvasResult();
    let interactions = initialInteractionResult();
    let perceptual = initialPerceptualResult();
    let interactionScreenshotPaths: string[] = [];
    let referenceScreenshotPaths: string[] = [];
    let perceptualDiffPaths: string[] = [];
    const interactionWarnings: string[] = [];

    await mkdir(outputDirectory, { recursive: true });

    try {
      browser = await launchBrowser(monitor.signal, timeoutMs, options.browser);
      const closeOnAbort = (): void => {
        void browser?.close().catch(() => undefined);
      };
      monitor.signal.addEventListener('abort', closeOnAbort, { once: true });

      try {
        networkProxy = await startLocalNetworkGuard(collector, localOrigin, monitor.signal);
        context = await browser.newContext({
          viewport: {
            width: viewport.width,
            height: viewport.height,
          },
          deviceScaleFactor: viewport.deviceScaleFactor,
          serviceWorkers: 'block',
          acceptDownloads: false,
          proxy: {
            server: networkProxy.server,
          },
        });
        const closedShadowProbeKey = await installValidationRuntimeGuards(
          context,
          options.runtimeCapabilities,
        );
        page = await context.newPage();
        closedShadowRootMonitor = await startClosedShadowRootMonitor(
          context,
          page,
          closedShadowProbeKey,
        );
        extraPageGuard = installExtraPageGuard(context, page);
        removeRequestGuard = await installLocalRequestGuard(
          context,
          collector,
          localOrigin,
          sourceOrigin,
          allowedOrigins,
        );
        listeners = attachListeners(
          context,
          page,
          collector,
          localOrigin,
          sourceOrigin,
          allowedOrigins,
        );

        try {
          const response = await page.goto(entryUrl.href, {
            waitUntil: 'load',
            timeout: timeoutMs,
          });
          const finalUrl = safeUrl(page.url());
          const finalUrlObject = new URL(page.url());
          const httpStatus = response?.status();
          const contentType = response?.headers()['content-type'];
          const persistedContentType = safeContentType(contentType);
          const localFinalUrl = canonicalOrigin(finalUrlObject) === localOrigin;
          const documentError = await entryDocumentError(page);
          const ok =
            response !== null &&
            httpStatus !== undefined &&
            httpStatus < 400 &&
            localFinalUrl &&
            !documentError;
          entry = {
            requestedUrl: safeUrl(entryUrl.href),
            ok,
            finalUrl,
            ...(httpStatus !== undefined ? { httpStatus } : {}),
            ...(persistedContentType ? { contentType: persistedContentType } : {}),
            ...(!localFinalUrl
              ? { error: 'Entry navigation escaped the local preview origin' }
              : documentError
                ? { error: documentError }
                : {}),
          };
        } catch (error) {
          entry = {
            requestedUrl: safeUrl(entryUrl.href),
            ok: false,
            finalUrl: safeUrl(page.url()),
            error: monitor.timedOut()
              ? `Validation timed out after ${timeoutMs} ms`
              : errorMessage(error, 'Entry navigation error'),
          };
        }

        if (!monitor.signal.aborted && entry.ok) {
          const networkQuiet = await listeners.waitForNetworkQuiet(
            settleTimeMs,
            initialNetworkQuietMaximumWaitMs(settleTimeMs),
            monitor.signal,
          );

          if (!networkQuiet.reached) {
            networkQuietWarning = `Network activity did not become quiet for ${settleTimeMs} ms before the bounded validation wait ended with ${networkQuiet.inFlightRequests} request(s) still active and ${networkQuiet.quietForMs} ms of quiet observed.`;
          }

          if (extraPageGuard.count() > 0) {
            extraPageWarning = `${extraPageGuard.count()} additional page(s) opened during fast validation and were closed.`;
          }

          await waitForRenderedFrame(page);

          try {
            canvas = await inspectCanvasesUntilSettled(
              page,
              canvasSettleTimeoutMs,
              viewport.deviceScaleFactor,
              closedShadowRootMonitor,
            );
          } catch (error) {
            canvas = {
              checked: true,
              present: true,
              passed: false,
              truncated: false,
              omitted: 0,
              inspected: 1,
              nonEmpty: 0,
              empty: 0,
              unreadable: 1,
              details: [
                {
                  frameUrl: safeUrl(page.url()),
                  index: 0,
                  width: 0,
                  height: 0,
                  cssWidth: 0,
                  cssHeight: 0,
                  context: 'unknown',
                  outcome: 'unreadable',
                  sampledPixels: 0,
                  error: errorMessage(error, 'Canvas inspection error'),
                },
              ],
            };
          }

          try {
            const captured = await captureSanitizedPageScreenshot(page, closedShadowRootMonitor);
            await atomicWriteFile(join(outputDirectory, SCREENSHOT_PATH), captured.bytes);
            screenshot = {
              passed: true,
              path: SCREENSHOT_PATH,
              ...(captured.maskedSensitiveControls ? { maskedSensitiveControls: true } : {}),
            };
          } catch (error) {
            screenshot = {
              passed: false,
              error: errorMessage(error, 'First-view screenshot error'),
            };
          }

          if (actions.length > 0 || references.size > 0) {
            listeners.detach();
            listeners = undefined;
            extraPageGuard.detach();
            extraPageGuard = undefined;
            await removeRequestGuard();
            removeRequestGuard = undefined;
            await context.close();
            context = undefined;
            page = undefined;
            await networkProxy.close();
            networkProxy = undefined;

            const interaction = await runInteractionValidation({
              browser,
              entryUrl,
              outputDirectory,
              localOrigin,
              sourceOrigin,
              allowedOrigins,
              viewport,
              runtimeCapabilities: options.runtimeCapabilities,
              actions,
              references,
              settings: perceptualSettings,
              timeoutMs,
              settleTimeMs,
              actionTimeoutMs,
              actionSettleTimeMs,
              signal: monitor.signal,
              budget: diagnosticBudget,
            });
            interactions = interaction.interactions;
            perceptual = interaction.perceptual;
            interactionScreenshotPaths = interaction.screenshotPaths;
            referenceScreenshotPaths = interaction.referencePaths;
            perceptualDiffPaths = interaction.diffPaths;
            interactionWarnings.push(...interaction.warnings);
            mergeNetworkEvidence(collector, interaction.collector);
          }
        }
      } finally {
        monitor.signal.removeEventListener('abort', closeOnAbort);
      }
    } catch (error) {
      if (!monitor.callerAborted()) {
        runnerError = monitor.timedOut()
          ? `Validation timed out after ${timeoutMs} ms`
          : `Validation runner failed: ${errorMessage(error, 'Validation runner error')}`;
      }
    } finally {
      listeners?.detach();
      extraPageGuard?.detach();
      await removeRequestGuard?.();
      await closedShadowRootMonitor?.close();
      await closeBrowser(context, browser);
      await networkProxy?.close();
    }

    if (monitor.callerAborted()) {
      throw abortReason(options.signal as AbortSignal);
    }

    const timeoutIncludedInResult = monitor.timedOut();

    if (timeoutIncludedInResult && !runnerError) {
      runnerError = `Validation timed out after ${timeoutMs} ms`;
    }

    if (actions.length > 0 && !interactions.checked) {
      interactions = {
        checked: true,
        passed: false,
        attempted: 0,
        completed: 0,
        failed: 0,
        skipped: actions.length,
        actions: actions.map((action) =>
          skippedActionResult(
            action,
            'Skipped because fast validation did not produce a local page.',
          ),
        ),
        errors: ['Scripted interaction validation could not start.'],
      };
    }

    const httpFailures = [...collector.httpFailures.values()];
    const local404s = httpFailures.filter((failure) => failure.local && failure.status === 404);
    const remoteDependencies = [...collector.remoteDependencies.values()];
    const diagnostics = diagnosticBudget.result();
    const replayConsoleCandidates = [...collector.recoverableReplayConsoleErrors];
    const replayPageCandidates = [...collector.recoverableReplayPageErrors];
    const ordinaryConsoleErrors = ordinaryBlockingConsoleErrors(collector);
    const ordinaryErrors = ordinaryPageErrors(collector);
    const replayCandidateCount = replayConsoleCandidates.length + replayPageCandidates.length;
    const screenshotEvidencePassed = screenshot.passed || isPrivacySuppressedScreenshot(screenshot);
    const canvasEvidencePassed =
      canvas.checked && canvas.passed && (!canvas.truncated || canvas.nonEmpty > 0);
    const replayRecovered =
      replayCandidateCount > 0 &&
      !runnerError &&
      entry.ok &&
      httpFailures.length === 0 &&
      ordinaryErrors.length === 0 &&
      ordinaryConsoleErrors.length === 0 &&
      remoteDependencies.length === 0 &&
      screenshotEvidencePassed &&
      canvasEvidencePassed &&
      (!interactions.checked || interactions.passed) &&
      (!perceptual.checked || perceptual.passed) &&
      !diagnostics.truncated &&
      droppedBlockingDiagnostics(diagnostics) === 0;
    const pageErrors = replayRecovered ? ordinaryErrors : collector.pageErrors;
    const blockingConsoleErrors = replayRecovered
      ? ordinaryConsoleErrors
      : collector.consoleErrors.filter((message) => message.blocking);
    const recoverableReplayErrors = replayRecovered ? replayCandidateCount : 0;

    if (replayRecovered) {
      for (const message of replayConsoleCandidates) {
        message.blocking = false;
      }
    }

    const calculatedStatus = calculateStatus(
      entry,
      httpFailures,
      pageErrors,
      blockingConsoleErrors,
      remoteDependencies,
      screenshot,
      canvas,
      interactions,
      perceptual,
      diagnostics,
      recoverableReplayErrors,
      runnerError,
    );
    const status =
      (networkQuietWarning || extraPageWarning) && calculatedStatus === 'complete'
        ? 'partial'
        : calculatedStatus;
    const score = calculateScore(
      status,
      entry,
      httpFailures,
      pageErrors,
      blockingConsoleErrors,
      remoteDependencies,
      screenshot,
      canvas,
      interactions,
      perceptual,
    );
    const messages = buildMessages(
      entry,
      httpFailures,
      local404s,
      pageErrors,
      blockingConsoleErrors,
      remoteDependencies,
      screenshot,
      canvas,
      interactions,
      perceptual,
      diagnostics,
      recoverableReplayErrors,
      runnerError,
    );
    if (networkQuietWarning) {
      messages.warnings.push(networkQuietWarning);
    }
    if (extraPageWarning) {
      messages.warnings.push(extraPageWarning);
    }
    messages.warnings.push(...interactionWarnings);
    const completedAt = new Date();
    const result: ValidationResult = {
      schemaVersion: validationSchemaVersion,
      status,
      score,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      ...(options.sourceUrl ? { sourceUrl: safeUrl(options.sourceUrl) } : {}),
      entry,
      checks: {
        http: {
          passed: httpFailures.length === 0,
          failures: httpFailures,
          local404s,
        },
        runtime: {
          passed:
            pageErrors.length === 0 &&
            blockingConsoleErrors.length === 0 &&
            droppedBlockingDiagnostics(diagnostics) === 0,
          pageErrors: collector.pageErrors,
          consoleErrors: collector.consoleErrors,
          blockingConsoleErrors,
        },
        remoteDependencies: {
          passed: remoteDependencies.length === 0,
          dependencies: remoteDependencies,
        },
        diagnostics,
        screenshot,
        canvas,
        interactions,
        perceptual,
      },
      errors: messages.errors,
      warnings: messages.warnings,
      artifacts: {
        validationJson: 'validation.json',
        reportHtml: 'report.html',
        ...(screenshot.path ? { screenshot: screenshot.path } : {}),
        ...(interactionScreenshotPaths.length > 0
          ? { interactionScreenshots: interactionScreenshotPaths }
          : {}),
        ...(referenceScreenshotPaths.length > 0
          ? { referenceScreenshots: referenceScreenshotPaths }
          : {}),
        ...(perceptualDiffPaths.length > 0 ? { perceptualDiffs: perceptualDiffPaths } : {}),
      },
    };

    const validationPath = join(outputDirectory, result.artifacts.validationJson);
    const reportPath = join(outputDirectory, result.artifacts.reportHtml);
    const validationJson = `${JSON.stringify(result, null, 2)}\n`;
    const reportHtml = renderValidationReport(result);
    const artifactWriteWasCancelled = (): boolean =>
      monitor.callerAborted() || (monitor.timedOut() && !timeoutIncludedInResult);
    const throwIfArtifactWriteCancelled = (): void => {
      if (artifactWriteWasCancelled()) {
        throw abortReason(monitor.signal);
      }
    };
    throwIfArtifactWriteCancelled();

    try {
      await atomicWriteFile(validationPath, validationJson);
      throwIfArtifactWriteCancelled();
      await atomicWriteFile(reportPath, reportHtml);
      throwIfArtifactWriteCancelled();
    } catch (error) {
      if (artifactWriteWasCancelled()) {
        await Promise.allSettled([
          rm(validationPath, { force: true }),
          rm(reportPath, { force: true }),
        ]);
      }

      throw error;
    }

    return result;
  } finally {
    monitor.cleanup();
  }
}
