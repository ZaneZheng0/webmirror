import {
  CaptureRecorder,
  capturedResponseBodyIntegrityError,
  capturedResponseBodyReuseScope,
  historicalStaticResourceType,
  type CaptureManifest,
  type CapturePreflight,
  type CapturedResource,
  type CapturedResponseBodyDescriptor,
  type CapturedResponseBodyReuseScope,
  type LoadingFailedEvent,
  type LoadingFinishedEvent,
  type RequestWillBeSentEvent,
  type RequestWillBeSentExtraInfoEvent,
  type ResponseReceivedEvent,
  type ResponseReceivedExtraInfoEvent,
} from '@webmirror/capture';
import {
  isKnownNonessentialExternalUrl,
  nativeResourceBodiesMaxBytes,
  nativeResourceBodyMaxBytes,
  redactSensitiveText,
  redactSensitiveUrl,
  runtimeCapabilitiesFromProbe,
  type RuntimeCapabilities,
} from '@webmirror/shared';

const protocolVersion = '1.3';
const quietWindowMs = 2_000;
const maximumCaptureMs = 30_000;
const maximumInteractiveCaptureMs = 45_000;
// Interactive runtimes often defer their real asset graph until an intro or
// renderer warm-up has completed. A ten-second floor was short enough for the
// first quiet window to close immediately before those requests began, which
// made otherwise identical one-click captures nondeterministic.
const minimumInteractiveCaptureMs = 20_000;
const ordinaryRuntimeExplorationCheckpoints = 16;
const interactiveRuntimeExplorationCheckpoints = 64;
const ordinaryRuntimeExplorationDwellMs = 100;
const interactiveRuntimeExplorationDwellMs = 250;
const ordinaryRuntimeExplorationReadinessMs = 750;
const interactiveRuntimeExplorationReadinessMs = 4_000;
const runtimeExplorationReadinessPollMs = 250;
const runtimeExplorationTimeoutBufferMs = 2_000;
const responseBodyConcurrency = 8;
const responseBodyCommandTimeoutMs = 3_000;
const criticalResponseBodyCommandTimeoutMs = 15_000;
const maximumCacheNames = 32;
const maximumCacheEntries = 1_000;
const cacheEntryPageSize = 250;
const maximumPerformanceResourceHints = 1_000;
const bodyEligibleResourceTypes = new Set([
  'Document',
  'Font',
  'Image',
  'Manifest',
  'Other',
  'Script',
  'Stylesheet',
  'TextTrack',
]);

interface AttachedToTargetEvent {
  sessionId: string;
  targetInfo: {
    type: string;
    url: string;
  };
  waitingForDebugger: boolean;
}

interface DetachedFromTargetEvent {
  sessionId: string;
}

interface LifecycleEvent {
  name: string;
}

interface RuntimePreflightResult {
  origin?: string;
  canvasElements?: number;
  iframeElements?: number;
  mediaElements?: number;
  serviceWorkerControlled?: boolean;
  observedResourceCount?: number;
  observedTransferBytes?: number;
  workerResourceHints?: number;
  webglResourceHints?: number;
  wasmResourceHints?: number;
  observedResources?: Array<{
    url?: string;
    initiatorType?: string;
  }>;
}

interface RuntimeEvaluationResult {
  result?: {
    value?: {
      title?: string;
      url?: string;
      userAgent?: string;
      viewport?: {
        width?: number;
        height?: number;
        deviceScaleFactor?: number;
      };
      runtimeCapabilities?: unknown;
      preflight?: RuntimePreflightResult;
    };
  };
}

interface RuntimeExplorationResult {
  result?: {
    value?: {
      checkpointCount?: number;
      maximumGapViewports?: number;
      heightExpanded?: boolean;
      restored?: boolean;
    };
  };
  exceptionDetails?: unknown;
}

interface GetResponseBodyResult {
  body?: string;
  base64Encoded?: boolean;
}

interface CacheStorageCache {
  cacheId?: string;
}

interface RequestCacheNamesResult {
  caches?: CacheStorageCache[];
}

interface CacheStorageHeader {
  name?: string;
  value?: string;
}

interface CacheStorageDataEntry {
  requestURL?: string;
  requestMethod?: string;
  responseStatus?: number;
  responseHeaders?: CacheStorageHeader[];
}

interface RequestCacheEntriesResult {
  cacheDataEntries?: CacheStorageDataEntry[];
  returnCount?: number;
}

interface RequestCachedResponseResult {
  response?: {
    body?: string;
  };
}

export interface CaptureProgress {
  jobId: string;
  state: 'attaching' | 'discovering';
  discoveredResources: number;
  pendingRequests: number;
  message: string;
}

export interface CaptureStartOptions {
  jobId?: string;
  onProgress?: (progress: CaptureProgress) => void;
}

export interface CapturedResponseBody {
  descriptor: CapturedResponseBodyDescriptor;
  bytes: Uint8Array;
}

export interface CaptureResult {
  manifest: CaptureManifest;
  bodies: readonly CapturedResponseBody[];
}

class AsyncLimiter {
  readonly #limit: number;
  #active = 0;
  readonly #waiting: Array<{ priority: number; sequence: number; resolve: () => void }> = [];
  #sequence = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  async run<T>(task: () => Promise<T>, priority = 0): Promise<T> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve) => {
        this.#waiting.push({ priority, sequence: this.#sequence, resolve });
        this.#sequence += 1;
        this.#waiting.sort(
          (left, right) => right.priority - left.priority || left.sequence - right.sequence,
        );
      });
    }

    this.#active += 1;

    try {
      return await task();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.resolve();
    }
  }
}

interface ActiveCapture {
  tabId: number;
  jobId: string;
  sourceUrl: string;
  title: string;
  startedAt: string;
  recorder: CaptureRecorder;
  pendingRequests: Set<string>;
  workerPendingRequests: Set<string>;
  pendingBodyReads: Set<Promise<void>>;
  completedBodyEvents: Map<string, LoadingFinishedEvent>;
  queuedBodyResourceIds: Set<string>;
  responseBodyLimiter: AsyncLimiter;
  bodies: Map<string, CapturedResponseBody>;
  capturedBodyBytes: number;
  bodyReadFailures: number;
  oversizedBodies: number;
  bodyBudgetSkips: number;
  cacheStorageFailures: number;
  initializingTargets: Set<string>;
  workerSessionIds: Set<string>;
  workerTargetUrls: Set<string>;
  warnings: string[];
  browser?: {
    name: string;
    version: string;
  };
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor: number;
  };
  runtimeCapabilities?: RuntimeCapabilities;
  preflight: CapturePreflight;
  onProgress?: (progress: CaptureProgress) => void;
  pageLoaded: boolean;
  rootDocumentObserved: boolean;
  runtimeExplorationStarted: boolean;
  runtimeExplorationPending: boolean;
  reloadStartedAt: number | undefined;
  attached: boolean;
  finishing: boolean;
  abortController: AbortController;
  completionReason?: CaptureManifest['completionReason'];
  quietTimer: ReturnType<typeof setTimeout> | undefined;
  maximumTimer: ReturnType<typeof setTimeout> | undefined;
  resolve: (result: CaptureResult) => void;
  reject: (error: Error) => void;
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function requestKey(sessionId: string | undefined, requestId: string): string {
  return `${sessionId ?? 'root'}:${requestId}`;
}

function normalizedHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);

    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return undefined;
    }

    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

function isImplicitDefaultFavicon(
  value: string,
  sourceUrl: string,
  initiatorType: string | undefined,
  resourceType?: string,
): boolean {
  if (initiatorType?.toLowerCase() !== 'other' || (resourceType && resourceType !== 'Other')) {
    return false;
  }

  const url = normalizedHttpUrl(value);
  const source = normalizedHttpUrl(sourceUrl);

  if (!url || !source) {
    return false;
  }

  const parsed = new URL(url);
  const parsedSource = new URL(source);
  return (
    parsed.origin === parsedSource.origin &&
    parsed.pathname.toLowerCase() === '/favicon.ico' &&
    parsed.search === ''
  );
}

function isLongLivedResource(resourceType: string | undefined): boolean {
  return (
    resourceType === 'WebSocket' ||
    resourceType === 'EventSource' ||
    resourceType === 'Media' ||
    resourceType === 'Ping'
  );
}

function isWorkerTargetType(value: string): boolean {
  return value === 'worker' || value === 'shared_worker';
}

function isWorkerRequest(
  capture: ActiveCapture,
  sessionId: string | undefined,
  requestUrl: string,
): boolean {
  const normalizedUrl = normalizedHttpUrl(requestUrl);
  return (
    (sessionId !== undefined && capture.workerSessionIds.has(sessionId)) ||
    (normalizedUrl !== undefined && capture.workerTargetUrls.has(normalizedUrl))
  );
}

function hasBlockingPendingRequests(capture: ActiveCapture): boolean {
  for (const key of capture.pendingRequests) {
    if (!capture.workerPendingRequests.has(key)) {
      return true;
    }
  }

  return false;
}

function resourcesWithWorkerContext(capture: ActiveCapture): CapturedResource[] {
  return capture.recorder.snapshot().map((resource) => {
    const resourceUrl = normalizedHttpUrl(resource.response?.url ?? resource.request.url);
    const workerContext =
      resource.request.workerContext === true ||
      (resource.sessionId !== undefined && capture.workerSessionIds.has(resource.sessionId)) ||
      (resourceUrl !== undefined && capture.workerTargetUrls.has(resourceUrl));

    return workerContext
      ? {
          ...resource,
          request: {
            ...resource.request,
            workerContext: true,
          },
        }
      : resource;
  });
}

function isBodyEligibleResource(resource: CapturedResource, sourceOrigin: string): boolean {
  const status = resource.response?.status ?? 0;
  const resourceUrl = normalizedHttpUrl(resource.response?.url ?? resource.request.url);

  if (!resourceUrl) {
    return false;
  }

  return (
    resource.request.method.toUpperCase() === 'GET' &&
    new URL(resourceUrl).origin === sourceOrigin &&
    !isKnownNonessentialExternalUrl(resourceUrl) &&
    !isLongLivedResource(resource.request.resourceType) &&
    bodyEligibleResourceTypes.has(resource.request.resourceType ?? '') &&
    status >= 200 &&
    status <= 203
  );
}

function base64DecodedLength(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  if (value.length % 4 !== 0) {
    return Number.POSITIVE_INFINITY;
  }

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);

  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }

  return bytes;
}

function responseBodyLengthLowerBound(body: string, base64Encoded: boolean): number {
  return base64Encoded ? base64DecodedLength(body) : body.length;
}

function runtimeExplorationExpression(
  maximumCheckpoints: number,
  dwellMs: number,
  readinessMs: number,
): string {
  return `(async () => {
    const __webmirrorDeferredResourceExploration = true;
    const scrollingElement = document.scrollingElement || document.documentElement;
    if (!scrollingElement) {
      return {
        checkpointCount: 0,
        maximumGapViewports: 0,
        heightExpanded: false,
        restored: true,
      };
    }

    const viewportHeight = Math.max(
      1,
      Number(window.innerHeight || document.documentElement.clientHeight || 1),
    );
    let previousHeight = Number(scrollingElement.scrollHeight || 0);
    let stableSamples = 0;
    let waitedMs = 0;

    while (waitedMs < ${readinessMs}) {
      await new Promise((resolve) => setTimeout(resolve, ${runtimeExplorationReadinessPollMs}));
      waitedMs += ${runtimeExplorationReadinessPollMs};
      const currentHeight = Number(scrollingElement.scrollHeight || 0);
      const tallEnough = currentHeight > viewportHeight * 1.5;
      const stable =
        Math.abs(currentHeight - previousHeight) <= Math.max(2, viewportHeight * 0.05);
      stableSamples = tallEnough && stable ? stableSamples + 1 : 0;
      previousHeight = currentHeight;

      if (stableSamples >= 4) {
        break;
      }
    }

    const initialTop = Number(scrollingElement.scrollTop || 0);
    const initialLeft = Number(scrollingElement.scrollLeft || 0);
    const initialMaximum = Math.max(
      0,
      Number(scrollingElement.scrollHeight || 0) - viewportHeight,
    );

    if (initialMaximum <= Math.max(64, viewportHeight * 0.5)) {
      return {
        checkpointCount: 0,
        maximumGapViewports: 0,
        heightExpanded: false,
        restored: true,
      };
    }

    const desiredGap = Math.max(1, Math.floor(viewportHeight * 0.85));
    const naturalCheckpointCount = Math.max(1, Math.ceil(initialMaximum / desiredGap));
    const checkpointCount = Math.min(${maximumCheckpoints}, naturalCheckpointCount);
    const settle = () => new Promise((resolve) => setTimeout(resolve, ${dwellMs}));
    let visited = 0;

    try {
      for (let index = 1; index <= checkpointCount; index += 1) {
        scrollingElement.scrollLeft = initialLeft;
        scrollingElement.scrollTop = Math.round((initialMaximum * index) / checkpointCount);
        await settle();
        visited += 1;
      }
    } finally {
      scrollingElement.scrollLeft = initialLeft;
      scrollingElement.scrollTop = initialTop;
      await settle();
    }

    const finalMaximum = Math.max(
      0,
      Number(scrollingElement.scrollHeight || 0) - viewportHeight,
    );
    return {
      checkpointCount: visited,
      maximumGapViewports: initialMaximum / checkpointCount / viewportHeight,
      heightExpanded: finalMaximum > initialMaximum + viewportHeight,
      restored:
        Math.abs(Number(scrollingElement.scrollTop || 0) - initialTop) <= 2 &&
        Math.abs(Number(scrollingElement.scrollLeft || 0) - initialLeft) <= 2,
    };
  })()`;
}

function decodeResponseBody(body: string, base64Encoded: boolean): Uint8Array {
  return base64Encoded ? decodeBase64(body) : new TextEncoder().encode(body);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', digestInput);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function cacheContentType(headers: readonly CacheStorageHeader[] | undefined): string | undefined {
  const contentType = headers?.find((header) => header.name?.toLowerCase() === 'content-type');
  return typeof contentType?.value === 'string' && contentType.value
    ? contentType.value
    : undefined;
}

function hasVaryHeader(headers: readonly CacheStorageHeader[] | undefined): boolean {
  return headers?.some((header) => header.name?.toLowerCase() === 'vary') === true;
}

function hasPrivateCacheDirective(headers: readonly CacheStorageHeader[] | undefined): boolean {
  const cacheControl = headers?.find((header) => header.name?.toLowerCase() === 'cache-control');

  if (typeof cacheControl?.value !== 'string') {
    return false;
  }

  return cacheControl.value
    .toLowerCase()
    .split(',')
    .some((directive) => directive.trim() === 'private' || directive.trim() === 'no-store');
}

function manifestForStorage(manifest: CaptureManifest): CaptureManifest {
  const stored = structuredClone(manifest);
  stored.sourceUrl = redactSensitiveUrl(stored.sourceUrl);
  stored.warnings = stored.warnings.map(redactSensitiveText);

  for (const resource of stored.resources) {
    resource.request.url = redactSensitiveUrl(resource.request.url);
    resource.request.headers = Object.fromEntries(
      Object.entries(resource.request.headers).map(([name, value]) => [
        name,
        redactSensitiveText(value),
      ]),
    );

    if (resource.response) {
      resource.response.url = redactSensitiveUrl(resource.response.url);
      resource.response.headers = Object.fromEntries(
        Object.entries(resource.response.headers).map(([name, value]) => [
          name,
          redactSensitiveText(value),
        ]),
      );
    }

    if (resource.failureReason) {
      resource.failureReason = redactSensitiveText(resource.failureReason);
    }
  }

  return stored;
}

async function sendCommand<T extends object = Record<string, never>>(
  target: chrome.debugger.DebuggerSession,
  method: string,
  commandParams: Record<string, unknown> = {},
): Promise<T> {
  const result = await chrome.debugger.sendCommand(target, method, commandParams);
  return (result ?? {}) as T;
}

async function sendCommandBounded<T extends object>(
  target: chrome.debugger.DebuggerSession,
  method: string,
  commandParams: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs = responseBodyCommandTimeoutMs,
): Promise<T> {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException('Capture operation was aborted', 'AbortError');
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      operation();
    };
    const abort = (): void => {
      finish(() => {
        reject(signal.reason ?? new DOMException('Capture operation was aborted', 'AbortError'));
      });
    };
    const timeout = setTimeout(() => {
      finish(() => {
        reject(new Error(`${method} timed out after ${timeoutMs} ms.`));
      });
    }, timeoutMs);

    signal.addEventListener('abort', abort, { once: true });
    void sendCommand<T>(target, method, commandParams).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export class CaptureController {
  readonly #active = new Map<number, ActiveCapture>();

  constructor() {
    chrome.debugger.onEvent.addListener((source, method, params) => {
      void this.#handleEvent(source, method, params ?? {});
    });
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId === undefined) {
        return;
      }

      const capture = this.#active.get(source.tabId);

      if (!capture || (!capture.attached && capture.finishing)) {
        return;
      }

      capture.attached = false;
      capture.warnings.push(`Debugger detached: ${reason}`);
      capture.completionReason = 'detached';
      capture.abortController.abort();

      if (capture.finishing) {
        return;
      }

      void this.#finish(capture, 'detached');
    });
  }

  async start(tabId: number, options: CaptureStartOptions = {}): Promise<CaptureResult> {
    if (this.#active.size > 0) {
      throw new Error('Another capture is already running.');
    }

    const tab = await chrome.tabs.get(tabId);

    let resolveCapture: (result: CaptureResult) => void = () => undefined;
    let rejectCapture: (error: Error) => void = () => undefined;
    const completion = new Promise<CaptureResult>((resolve, reject) => {
      resolveCapture = resolve;
      rejectCapture = reject;
    });
    const capture: ActiveCapture = {
      tabId,
      jobId: options.jobId ?? crypto.randomUUID(),
      sourceUrl: tab.url ?? '',
      title: tab.title ?? '',
      startedAt: new Date().toISOString(),
      recorder: new CaptureRecorder(),
      pendingRequests: new Set(),
      workerPendingRequests: new Set(),
      pendingBodyReads: new Set(),
      completedBodyEvents: new Map(),
      queuedBodyResourceIds: new Set(),
      responseBodyLimiter: new AsyncLimiter(responseBodyConcurrency),
      bodies: new Map(),
      capturedBodyBytes: 0,
      bodyReadFailures: 0,
      oversizedBodies: 0,
      bodyBudgetSkips: 0,
      cacheStorageFailures: 0,
      initializingTargets: new Set(),
      workerSessionIds: new Set(),
      workerTargetUrls: new Set(),
      warnings: [],
      preflight: {
        origin: '',
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
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      pageLoaded: false,
      rootDocumentObserved: false,
      runtimeExplorationStarted: false,
      runtimeExplorationPending: false,
      reloadStartedAt: undefined,
      attached: false,
      finishing: false,
      abortController: new AbortController(),
      quietTimer: undefined,
      maximumTimer: undefined,
      resolve: resolveCapture,
      reject: rejectCapture,
    };

    this.#active.set(tabId, capture);
    this.#notifyProgress(capture, 'attaching', 'Attaching to the active tab.');

    try {
      const root = { tabId };
      await chrome.debugger.attach(root, protocolVersion);
      capture.attached = true;
      await this.#configureRootSession(capture);

      if (capture.finishing) {
        return completion;
      }

      await this.#resolvePageIdentity(capture);

      if (capture.finishing) {
        return completion;
      }

      this.#notifyProgress(capture, 'discovering', 'Reloading and discovering page resources.');
      capture.reloadStartedAt = Date.now();
      const maximumDurationMs = this.#maximumCaptureDurationMs(capture);
      capture.maximumTimer = setTimeout(() => {
        capture.warnings.push(
          `Capture discovery reached the ${Math.round(
            maximumDurationMs / 1000,
          )}-second maximum duration with ${capture.pendingRequests.size} pending request(s), ${capture.pendingBodyReads.size} pending response-body read(s), ${capture.initializingTargets.size} initializing target(s), and deferred exploration ${
            capture.runtimeExplorationPending ? 'still running' : 'finished'
          }.`,
        );
        void this.#finish(capture, 'maximum_duration');
      }, maximumDurationMs);
      await sendCommand(root, 'Page.reload', {
        ignoreCache: true,
      });
    } catch (error) {
      await this.#fail(capture, errorFromUnknown(error));
    }

    return completion;
  }

  async cancel(jobId: string): Promise<boolean> {
    const capture = [...this.#active.values()].find((candidate) => candidate.jobId === jobId);

    if (!capture) {
      return false;
    }

    if (capture.completionReason !== 'cancelled') {
      capture.warnings.push('Capture cancelled by the user.');
    }

    capture.completionReason = 'cancelled';
    capture.abortController.abort();

    if (!capture.finishing) {
      await this.#finish(capture, 'cancelled');
    }

    return true;
  }

  async #resolvePageIdentity(capture: ActiveCapture): Promise<void> {
    const evaluation = await sendCommand<RuntimeEvaluationResult>(
      { tabId: capture.tabId },
      'Runtime.evaluate',
      {
        expression: `(() => {
          const resources = performance.getEntriesByType('resource');
          const resourceNames = resources.map((entry) => String(entry.name || ''));
           const matches = (pattern) =>
             resourceNames.filter((name) => pattern.test(name)).length;
           const inspectWebGL = (contextType) => {
             let context = null;

             try {
               context = document.createElement('canvas').getContext(contextType);
             } catch {
               // An unavailable rendering context has no capability-dependent variants.
             }

             let extensions = [];

             try {
               extensions = Array.from(context?.getSupportedExtensions?.() || [])
                 .slice(0, 128)
                 .map((value) => String(value).slice(0, 128));
             } catch {
               // A page-modified probe is treated as exposing no trusted extensions.
             }

             return { extensions };
           };
           return {
             url: location.href,
             title: document.title,
             userAgent: navigator.userAgent,
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
               deviceScaleFactor: window.devicePixelRatio || 1,
             },
             runtimeCapabilities: {
               webgl: inspectWebGL('webgl'),
               webgl2: inspectWebGL('webgl2'),
             },
             preflight: {
              origin: location.origin,
              canvasElements: document.querySelectorAll('canvas').length,
              iframeElements: document.querySelectorAll('iframe').length,
              mediaElements: document.querySelectorAll('audio, video').length,
              serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
              observedResourceCount: resources.length,
              observedTransferBytes: resources.reduce(
                (total, entry) =>
                  total +
                  Number(entry.transferSize || entry.encodedBodySize || entry.decodedBodySize || 0),
                0,
              ),
              workerResourceHints: resources.filter(
                (entry) => entry.initiatorType === 'worker',
              ).length,
              webglResourceHints: matches(
                /\\.(?:glb|gltf|dds|ktx2?|pvr|frag|vert|glsl)(?:[?#]|$)/i,
              ),
              wasmResourceHints: matches(/\\.wasm(?:[?#]|$)/i),
              observedResources: resources.slice(0, ${maximumPerformanceResourceHints}).map(
                (entry) => ({
                  url: String(entry.name || '').slice(0, 8192),
                  initiatorType: String(entry.initiatorType || '').slice(0, 64),
                }),
              ),
            },
          };
        })()`,
        returnByValue: true,
        timeout: 5_000,
      },
    );
    const identity = evaluation.result?.value;
    const sourceUrl = identity?.url ?? capture.sourceUrl;
    const title = identity?.title ?? capture.title;

    if (!sourceUrl) {
      throw new Error('The active tab does not expose a page URL.');
    }

    const parsedUrl = new URL(sourceUrl);

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Unsupported page protocol: ${parsedUrl.protocol}`);
    }

    capture.sourceUrl = parsedUrl.href;
    capture.title = title || parsedUrl.hostname;
    capture.preflight = this.#normalizePreflight(identity?.preflight, parsedUrl.origin);
    const historicalResourceHints = this.#seedPerformanceResourceHints(
      capture,
      identity?.preflight?.observedResources,
    );
    capture.warnings.push(...this.#preflightWarnings(capture.preflight));
    this.#notifyProgress(
      capture,
      'attaching',
      `Preflight found ${capture.preflight.observedResourceCount} existing resources, retained ${historicalResourceHints} static URL hint(s), and found ${capture.preflight.canvasElements} canvas element(s) plus ${capture.preflight.iframeElements} iframe(s).`,
    );
    const browser = this.#browserInfo(identity?.userAgent);

    if (browser) {
      capture.browser = browser;
    }

    const viewport = identity?.viewport;

    if (
      viewport &&
      Number.isSafeInteger(viewport.width) &&
      Number(viewport.width) > 0 &&
      Number.isSafeInteger(viewport.height) &&
      Number(viewport.height) > 0 &&
      typeof viewport.deviceScaleFactor === 'number' &&
      Number.isFinite(viewport.deviceScaleFactor) &&
      viewport.deviceScaleFactor > 0
    ) {
      capture.viewport = {
        width: Number(viewport.width),
        height: Number(viewport.height),
        deviceScaleFactor: viewport.deviceScaleFactor,
      };
    }

    const runtimeCapabilities = runtimeCapabilitiesFromProbe(identity?.runtimeCapabilities);

    if (runtimeCapabilities) {
      capture.runtimeCapabilities = runtimeCapabilities;
    }
  }

  async #configureRootSession(capture: ActiveCapture): Promise<void> {
    const root = { tabId: capture.tabId };

    await sendCommand(root, 'Runtime.enable');
    await sendCommand(root, 'Network.enable', {
      maxTotalBufferSize: 64 * 1024 * 1024,
      maxResourceBufferSize: nativeResourceBodyMaxBytes,
      maxPostDataSize: 64 * 1024,
    });
    await sendCommand(root, 'Network.setCacheDisabled', {
      cacheDisabled: true,
    });
    await sendCommand(root, 'Page.enable');
    await sendCommand(root, 'Page.setLifecycleEventsEnabled', {
      enabled: true,
    });
    await sendCommand(root, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  }

  async #configureChildSession(
    capture: ActiveCapture,
    event: AttachedToTargetEvent,
  ): Promise<void> {
    const child = {
      tabId: capture.tabId,
      sessionId: event.sessionId,
    };

    try {
      await sendCommandBounded(child, 'Runtime.enable', {}, capture.abortController.signal);
      await sendCommandBounded(
        child,
        'Network.enable',
        {
          maxTotalBufferSize: 64 * 1024 * 1024,
          maxResourceBufferSize: nativeResourceBodyMaxBytes,
          maxPostDataSize: 64 * 1024,
        },
        capture.abortController.signal,
      );
      await sendCommandBounded(
        child,
        'Network.setCacheDisabled',
        {
          cacheDisabled: true,
        },
        capture.abortController.signal,
      );
      await sendCommandBounded(
        child,
        'Target.setAutoAttach',
        {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        },
        capture.abortController.signal,
      );

      if (event.targetInfo.type === 'page' || event.targetInfo.type === 'iframe') {
        await sendCommandBounded(child, 'Page.enable', {}, capture.abortController.signal);
        await sendCommandBounded(
          child,
          'Page.setLifecycleEventsEnabled',
          {
            enabled: true,
          },
          capture.abortController.signal,
        );
      }

      if (event.waitingForDebugger) {
        await sendCommandBounded(
          child,
          'Runtime.runIfWaitingForDebugger',
          {},
          capture.abortController.signal,
        );
      }
    } catch (error) {
      capture.warnings.push(
        `Unable to initialize ${event.targetInfo.type} target ${redactSensitiveUrl(
          event.targetInfo.url,
        )}: ${errorFromUnknown(error).message}`,
      );

      if (event.waitingForDebugger) {
        try {
          await sendCommandBounded(
            child,
            'Runtime.runIfWaitingForDebugger',
            {},
            capture.abortController.signal,
          );
        } catch {
          capture.warnings.push(`Unable to resume child session ${event.sessionId}.`);
        }
      }
    } finally {
      capture.initializingTargets.delete(event.sessionId);
      this.#scheduleQuietCheck(capture);
    }
  }

  #queueResponseBodyRead(
    capture: ActiveCapture,
    sessionId: string | undefined,
    event: LoadingFinishedEvent,
  ): void {
    const completedKey = requestKey(sessionId, event.requestId);
    const resource = capture.recorder.currentResource(sessionId, event.requestId);
    const sourceOrigin = new URL(capture.sourceUrl).origin;
    const reuseScope = resource
      ? capturedResponseBodyReuseScope(resource, sourceOrigin)
      : undefined;

    if (!resource) {
      capture.completedBodyEvents.delete(completedKey);
      return;
    }

    if (!reuseScope || capture.queuedBodyResourceIds.has(resource.id)) {
      return;
    }

    if (
      event.encodedDataLength !== undefined &&
      event.encodedDataLength > nativeResourceBodyMaxBytes
    ) {
      capture.oversizedBodies += 1;
      capture.completedBodyEvents.delete(completedKey);
      return;
    }

    const resourceUrl = normalizedHttpUrl(resource.response?.url ?? resource.request.url);

    if (!resourceUrl) {
      capture.completedBodyEvents.delete(completedKey);
      return;
    }

    capture.completedBodyEvents.delete(completedKey);
    capture.queuedBodyResourceIds.add(resource.id);
    this.#cancelQuietTimer(capture);
    const criticalEntryBody =
      sessionId === undefined &&
      resource.request.resourceType === 'Document' &&
      resourceUrl === normalizedHttpUrl(capture.sourceUrl);
    const bodyRead = capture.responseBodyLimiter
      .run(
        async () => {
          const target: chrome.debugger.DebuggerSession = {
            tabId: capture.tabId,
            ...(sessionId ? { sessionId } : {}),
          };
          const response = await sendCommandBounded<GetResponseBodyResult>(
            target,
            'Network.getResponseBody',
            {
              requestId: event.requestId,
            },
            capture.abortController.signal,
            criticalEntryBody ? criticalResponseBodyCommandTimeoutMs : responseBodyCommandTimeoutMs,
          );

          if (typeof response.body !== 'string') {
            throw new Error('CDP did not return a response body.');
          }

          const base64Encoded = response.base64Encoded === true;
          const lowerBound = responseBodyLengthLowerBound(response.body, base64Encoded);
          const remainingBudget = nativeResourceBodiesMaxBytes - capture.capturedBodyBytes;

          if (lowerBound > nativeResourceBodyMaxBytes) {
            capture.oversizedBodies += 1;
            return;
          }

          if (lowerBound > remainingBudget) {
            capture.bodyBudgetSkips += 1;
            return;
          }

          const bytes = decodeResponseBody(response.body, base64Encoded);
          const bodyIntegrityError = capturedResponseBodyIntegrityError(resource, bytes.byteLength);

          if (bodyIntegrityError) {
            throw new Error(bodyIntegrityError);
          }

          await this.#storeCapturedBody(capture, resource, bytes, 'network', reuseScope);
        },
        criticalEntryBody ? 1 : 0,
      )
      .catch((error: unknown) => {
        if (!capture.abortController.signal.aborted) {
          capture.bodyReadFailures += 1;
          capture.warnings.push(
            `Browser response-body read failed for ${redactSensitiveUrl(resourceUrl)}: ${redactSensitiveText(
              errorFromUnknown(error).message,
            )}`,
          );
        }
      })
      .finally(() => {
        capture.pendingBodyReads.delete(bodyRead);
        this.#scheduleQuietCheck(capture);
      });
    capture.pendingBodyReads.add(bodyRead);
  }

  #retryCompletedBodyRead(
    capture: ActiveCapture,
    sessionId: string | undefined,
    requestId: string,
  ): void {
    const event = capture.completedBodyEvents.get(requestKey(sessionId, requestId));

    if (event) {
      this.#queueResponseBodyRead(capture, sessionId, event);
    }
  }

  async #storeCapturedBody(
    capture: ActiveCapture,
    resource: CapturedResource,
    bytes: Uint8Array,
    source: CapturedResponseBodyDescriptor['source'],
    reuseScope: CapturedResponseBodyReuseScope,
    contentType = resource.response?.mimeType ?? 'application/octet-stream',
    httpStatus = resource.response?.status ?? 200,
  ): Promise<CapturedResponseBodyDescriptor | undefined> {
    if (bytes.byteLength > nativeResourceBodyMaxBytes) {
      capture.oversizedBodies += 1;
      return undefined;
    }

    if (capture.capturedBodyBytes + bytes.byteLength > nativeResourceBodiesMaxBytes) {
      capture.bodyBudgetSkips += 1;
      return undefined;
    }

    capture.capturedBodyBytes += bytes.byteLength;

    try {
      const sha256 = await sha256Hex(bytes);
      const descriptor: CapturedResponseBodyDescriptor = {
        id: crypto.randomUUID(),
        byteLength: bytes.byteLength,
        sha256,
        source,
        reuseScope,
        contentType,
        httpStatus,
      };
      capture.bodies.set(descriptor.id, {
        descriptor,
        bytes,
      });
      capture.recorder.attachResponseBodyByResourceId(resource.id, descriptor);
      return descriptor;
    } catch (error) {
      capture.capturedBodyBytes = Math.max(0, capture.capturedBodyBytes - bytes.byteLength);
      throw error;
    }
  }

  async #captureCacheStorageFallback(capture: ActiveCapture): Promise<void> {
    if (
      !capture.attached ||
      !capture.preflight.serviceWorkerControlled ||
      !normalizedHttpUrl(capture.preflight.origin)
    ) {
      return;
    }

    const candidates = new Map<string, CapturedResource[]>();
    const sourceOrigin = new URL(capture.sourceUrl).origin;

    for (const resource of capture.recorder.snapshot()) {
      if (
        resource.body ||
        !isBodyEligibleResource(resource, sourceOrigin) ||
        resource.response?.fromServiceWorker !== true
      ) {
        continue;
      }

      const resourceUrl = normalizedHttpUrl(resource.response?.url ?? resource.request.url);

      if (!resourceUrl) {
        continue;
      }

      const resources = candidates.get(resourceUrl) ?? [];
      resources.push(resource);
      candidates.set(resourceUrl, resources);
    }

    if (candidates.size === 0) {
      return;
    }

    const target = { tabId: capture.tabId };
    let cacheNames: RequestCacheNamesResult;

    try {
      cacheNames = await sendCommandBounded<RequestCacheNamesResult>(
        target,
        'CacheStorage.requestCacheNames',
        {
          securityOrigin: capture.preflight.origin,
        },
        capture.abortController.signal,
      );
    } catch {
      if (capture.preflight.serviceWorkerControlled && !capture.abortController.signal.aborted) {
        capture.cacheStorageFailures += 1;
      }
      return;
    }

    const caches = (cacheNames.caches ?? []).slice(0, maximumCacheNames);

    for (const cache of caches) {
      if (capture.abortController.signal.aborted) {
        return;
      }

      if (!cache.cacheId || candidates.size === 0) {
        continue;
      }

      let skipCount = 0;
      let inspectedEntries = 0;

      while (inspectedEntries < maximumCacheEntries && candidates.size > 0) {
        if (capture.abortController.signal.aborted) {
          return;
        }

        let page: RequestCacheEntriesResult;

        try {
          page = await sendCommandBounded<RequestCacheEntriesResult>(
            target,
            'CacheStorage.requestEntries',
            {
              cacheId: cache.cacheId,
              skipCount,
              pageSize: Math.min(cacheEntryPageSize, maximumCacheEntries - inspectedEntries),
              pathFilter: '',
            },
            capture.abortController.signal,
          );
        } catch {
          if (!capture.abortController.signal.aborted) {
            capture.cacheStorageFailures += 1;
          }
          break;
        }

        const entries = page.cacheDataEntries ?? [];

        if (entries.length === 0) {
          break;
        }

        for (const entry of entries) {
          const requestUrl =
            typeof entry.requestURL === 'string' ? normalizedHttpUrl(entry.requestURL) : undefined;
          const matchingResources = requestUrl ? candidates.get(requestUrl) : undefined;

          if (
            !requestUrl ||
            !matchingResources ||
            entry.requestMethod?.toUpperCase() !== 'GET' ||
            entry.responseStatus === undefined ||
            entry.responseStatus < 200 ||
            entry.responseStatus > 203 ||
            hasVaryHeader(entry.responseHeaders) ||
            hasPrivateCacheDirective(entry.responseHeaders)
          ) {
            continue;
          }

          try {
            const cached = await sendCommandBounded<RequestCachedResponseResult>(
              target,
              'CacheStorage.requestCachedResponse',
              {
                cacheId: cache.cacheId,
                requestURL: entry.requestURL,
                requestHeaders: [],
              },
              capture.abortController.signal,
            );

            if (typeof cached.response?.body !== 'string') {
              throw new Error('CacheStorage did not return a response body.');
            }

            const firstResource = matchingResources[0];

            if (!firstResource) {
              continue;
            }

            const lowerBound = base64DecodedLength(cached.response.body);
            const remainingBudget = nativeResourceBodiesMaxBytes - capture.capturedBodyBytes;

            if (lowerBound > nativeResourceBodyMaxBytes) {
              capture.oversizedBodies += 1;
              continue;
            }

            if (lowerBound > remainingBudget) {
              capture.bodyBudgetSkips += 1;
              continue;
            }

            const descriptor = await this.#storeCapturedBody(
              capture,
              firstResource,
              decodeBase64(cached.response.body),
              'cache_storage',
              'same_origin',
              cacheContentType(entry.responseHeaders) ??
                firstResource.response?.mimeType ??
                'application/octet-stream',
              entry.responseStatus,
            );

            if (descriptor) {
              for (const resource of matchingResources.slice(1)) {
                capture.recorder.attachResponseBodyByResourceId(resource.id, descriptor);
              }

              candidates.delete(requestUrl);
            }
          } catch {
            if (!capture.abortController.signal.aborted) {
              capture.cacheStorageFailures += 1;
            }
          }
        }

        inspectedEntries += entries.length;
        skipCount += entries.length;

        if (
          entries.length < cacheEntryPageSize ||
          (page.returnCount !== undefined && skipCount >= page.returnCount)
        ) {
          break;
        }
      }
    }
  }

  #appendBodyCaptureWarnings(capture: ActiveCapture): void {
    if (capture.bodyReadFailures > 0) {
      capture.warnings.push(
        `Browser response-body capture failed for ${capture.bodyReadFailures} resource(s); public download or CacheStorage fallback will be used.`,
      );
    }

    if (capture.oversizedBodies > 0) {
      capture.warnings.push(
        `${capture.oversizedBodies} browser response body or bodies exceeded the 20 MB per-resource capture limit.`,
      );
    }

    if (capture.bodyBudgetSkips > 0) {
      capture.warnings.push(
        `${capture.bodyBudgetSkips} browser response body or bodies were skipped after the 50 MB in-memory capture budget was reached.`,
      );
    }

    if (capture.cacheStorageFailures > 0) {
      capture.warnings.push(
        `CacheStorage fallback could not read ${capture.cacheStorageFailures} cache operation(s).`,
      );
    }
  }

  async #handleEvent(
    source: chrome.debugger.DebuggerSession,
    method: string,
    params: object,
  ): Promise<void> {
    if (source.tabId === undefined) {
      return;
    }

    const capture = this.#active.get(source.tabId);

    if (!capture || capture.finishing) {
      return;
    }

    const sessionId = source.sessionId;

    switch (method) {
      case 'Network.requestWillBeSent': {
        const event = params as RequestWillBeSentEvent;

        if (
          isKnownNonessentialExternalUrl(event.request.url) ||
          event.type === 'Ping' ||
          isImplicitDefaultFavicon(
            event.request.url,
            capture.sourceUrl,
            event.initiator?.type,
            event.type,
          )
        ) {
          break;
        }

        if (
          sessionId === undefined &&
          event.type === 'Document' &&
          normalizedHttpUrl(event.request.url)
        ) {
          capture.rootDocumentObserved = true;
          capture.pageLoaded = false;
        }

        capture.recorder.requestWillBeSent(sessionId, event);

        let workerPendingRequest = false;

        if (!isLongLivedResource(event.type) && normalizedHttpUrl(event.request.url)) {
          const key = requestKey(sessionId, event.requestId);
          capture.pendingRequests.add(key);
          workerPendingRequest = isWorkerRequest(capture, sessionId, event.request.url);

          if (workerPendingRequest) {
            capture.workerPendingRequests.add(key);
          }
        }

        this.#cancelQuietTimer(capture);
        this.#notifyProgress(capture, 'discovering', 'Discovering page resources.');

        if (workerPendingRequest) {
          this.#scheduleQuietCheck(capture);
        }
        break;
      }
      case 'Network.requestWillBeSentExtraInfo':
        capture.recorder.requestWillBeSentExtraInfo(
          sessionId,
          params as RequestWillBeSentExtraInfoEvent,
        );
        this.#retryCompletedBodyRead(
          capture,
          sessionId,
          (params as RequestWillBeSentExtraInfoEvent).requestId,
        );
        break;
      case 'Network.responseReceived':
        capture.recorder.responseReceived(sessionId, params as ResponseReceivedEvent);
        this.#retryCompletedBodyRead(
          capture,
          sessionId,
          (params as ResponseReceivedEvent).requestId,
        );
        break;
      case 'Network.responseReceivedExtraInfo':
        capture.recorder.responseReceivedExtraInfo(
          sessionId,
          params as ResponseReceivedExtraInfoEvent,
        );
        this.#retryCompletedBodyRead(
          capture,
          sessionId,
          (params as ResponseReceivedExtraInfoEvent).requestId,
        );
        break;
      case 'Network.loadingFinished': {
        const event = params as LoadingFinishedEvent;
        capture.recorder.loadingFinished(sessionId, event);
        capture.pendingRequests.delete(requestKey(sessionId, event.requestId));
        capture.workerPendingRequests.delete(requestKey(sessionId, event.requestId));
        capture.completedBodyEvents.set(requestKey(sessionId, event.requestId), event);
        this.#queueResponseBodyRead(capture, sessionId, event);
        this.#notifyProgress(capture, 'discovering', 'Collecting completed responses.');
        this.#scheduleQuietCheck(capture);
        break;
      }
      case 'Network.loadingFailed': {
        const event = params as LoadingFailedEvent;
        capture.recorder.loadingFailed(sessionId, event);
        capture.pendingRequests.delete(requestKey(sessionId, event.requestId));
        capture.workerPendingRequests.delete(requestKey(sessionId, event.requestId));
        this.#notifyProgress(capture, 'discovering', 'Recording failed responses.');
        this.#scheduleQuietCheck(capture);
        break;
      }
      case 'Page.loadEventFired':
        if (sessionId === undefined) {
          this.#pageReady(capture);
        }
        break;
      case 'Page.domContentEventFired':
        if (sessionId === undefined && capture.rootDocumentObserved) {
          this.#pageReady(capture);
        }
        break;
      case 'Page.lifecycleEvent': {
        const event = params as LifecycleEvent;

        if (sessionId === undefined) {
          if (event.name === 'DOMContentLoaded' && capture.rootDocumentObserved) {
            this.#pageReady(capture);
          } else if (event.name === 'load' || event.name === 'networkIdle') {
            this.#pageReady(capture);
          }
        }
        break;
      }
      case 'Target.attachedToTarget': {
        const event = params as AttachedToTargetEvent;

        if (isWorkerTargetType(event.targetInfo.type)) {
          capture.workerSessionIds.add(event.sessionId);
          const targetUrl = normalizedHttpUrl(event.targetInfo.url);

          if (targetUrl) {
            capture.workerTargetUrls.add(targetUrl);

            for (const resource of capture.recorder.snapshot()) {
              const resourceUrl = normalizedHttpUrl(resource.response?.url ?? resource.request.url);

              if (
                resourceUrl === targetUrl &&
                resource.state !== 'complete' &&
                resource.state !== 'failed'
              ) {
                capture.workerPendingRequests.add(
                  requestKey(resource.sessionId, resource.requestId),
                );
              }
            }
          }
        }

        capture.initializingTargets.add(event.sessionId);
        this.#cancelQuietTimer(capture);
        void this.#configureChildSession(capture, event);
        break;
      }
      case 'Target.detachedFromTarget': {
        const event = params as DetachedFromTargetEvent;
        capture.initializingTargets.delete(event.sessionId);

        for (const key of capture.pendingRequests) {
          if (key.startsWith(`${event.sessionId}:`)) {
            capture.pendingRequests.delete(key);
            capture.workerPendingRequests.delete(key);
          }
        }

        this.#scheduleQuietCheck(capture);
        break;
      }
    }
  }

  #pageReady(capture: ActiveCapture): void {
    if (!capture.rootDocumentObserved || capture.reloadStartedAt === undefined) {
      return;
    }

    capture.pageLoaded = true;

    if (capture.rootDocumentObserved) {
      this.#startRuntimeExploration(capture);
    }

    this.#scheduleQuietCheck(capture);
  }

  #startRuntimeExploration(capture: ActiveCapture): void {
    if (
      capture.runtimeExplorationStarted ||
      capture.runtimeExplorationPending ||
      capture.finishing ||
      !capture.attached
    ) {
      return;
    }

    capture.runtimeExplorationStarted = true;
    capture.runtimeExplorationPending = true;
    this.#cancelQuietTimer(capture);
    const interactive =
      capture.preflight.canvasElements > 0 ||
      capture.preflight.webglResourceHints > 0 ||
      capture.preflight.wasmResourceHints > 0;
    const maximumCheckpoints = interactive
      ? interactiveRuntimeExplorationCheckpoints
      : ordinaryRuntimeExplorationCheckpoints;
    const dwellMs = interactive
      ? interactiveRuntimeExplorationDwellMs
      : ordinaryRuntimeExplorationDwellMs;
    const readinessMs = interactive
      ? interactiveRuntimeExplorationReadinessMs
      : ordinaryRuntimeExplorationReadinessMs;
    this.#notifyProgress(
      capture,
      'discovering',
      interactive
        ? 'Exploring deferred interactive page resources.'
        : 'Exploring deferred page resources.',
    );

    void sendCommand<RuntimeExplorationResult>({ tabId: capture.tabId }, 'Runtime.evaluate', {
      expression: runtimeExplorationExpression(maximumCheckpoints, dwellMs, readinessMs),
      awaitPromise: true,
      returnByValue: true,
      timeout: readinessMs + maximumCheckpoints * dwellMs + runtimeExplorationTimeoutBufferMs,
    })
      .then((evaluation) => {
        if (capture.finishing || capture.abortController.signal.aborted) {
          return;
        }

        if (evaluation.exceptionDetails) {
          throw new Error('The page rejected bounded deferred-resource exploration.');
        }

        const result = evaluation.result?.value;

        if (
          typeof result?.maximumGapViewports === 'number' &&
          Number.isFinite(result.maximumGapViewports) &&
          result.maximumGapViewports > 1.5
        ) {
          capture.warnings.push(
            `Capability boundary: the page is too long for dense deferred-resource exploration; sampled gaps reached ${result.maximumGapViewports.toFixed(
              1,
            )} viewport heights.`,
          );
        }

        if (result?.heightExpanded) {
          capture.warnings.push(
            'Capability boundary: the document grew by more than one viewport during deferred-resource exploration; later infinite-scroll content may remain uncaptured.',
          );
        }

        if (result?.restored === false) {
          capture.warnings.push(
            'The page did not fully restore its original scroll position after deferred-resource exploration.',
          );
        }
      })
      .catch((error: unknown) => {
        if (!capture.finishing && !capture.abortController.signal.aborted) {
          capture.warnings.push(
            `Bounded deferred-resource exploration could not complete: ${redactSensitiveText(
              errorFromUnknown(error).message,
            )}`,
          );
        }
      })
      .finally(() => {
        capture.runtimeExplorationPending = false;
        this.#scheduleQuietCheck(capture);
      });
  }

  #scheduleQuietCheck(capture: ActiveCapture): void {
    if (
      !capture.pageLoaded ||
      !capture.rootDocumentObserved ||
      capture.reloadStartedAt === undefined ||
      hasBlockingPendingRequests(capture) ||
      capture.pendingBodyReads.size > 0 ||
      capture.initializingTargets.size > 0 ||
      capture.runtimeExplorationPending ||
      capture.finishing
    ) {
      return;
    }

    this.#cancelQuietTimer(capture);
    const webGlWarmupRemaining = Math.max(
      0,
      this.#minimumCaptureDurationMs(capture) -
        Math.max(0, Date.now() - (capture.reloadStartedAt ?? Date.parse(capture.startedAt))),
    );
    capture.quietTimer = setTimeout(
      () => {
        void this.#finish(capture, 'network_idle');
      },
      Math.max(quietWindowMs, webGlWarmupRemaining),
    );
  }

  #cancelQuietTimer(capture: ActiveCapture): void {
    if (capture.quietTimer !== undefined) {
      clearTimeout(capture.quietTimer);
      capture.quietTimer = undefined;
    }
  }

  async #finish(
    capture: ActiveCapture,
    completionReason: CaptureManifest['completionReason'],
  ): Promise<void> {
    if (capture.finishing) {
      if (completionReason === 'cancelled' || completionReason === 'detached') {
        capture.completionReason = completionReason;
        capture.abortController.abort();
      }

      return;
    }

    capture.finishing = true;
    capture.completionReason = capture.completionReason ?? completionReason;
    this.#clearTimers(capture);

    if (
      capture.completionReason === 'cancelled' ||
      capture.completionReason === 'detached' ||
      capture.completionReason === 'failed'
    ) {
      capture.abortController.abort();
    }

    try {
      await Promise.allSettled([...capture.pendingBodyReads]);

      if (capture.completionReason === 'network_idle' && !capture.abortController.signal.aborted) {
        await this.#captureCacheStorageFallback(capture);
      }

      const finalReason = capture.completionReason ?? completionReason;
      this.#appendBodyCaptureWarnings(capture);
      const manifest: CaptureManifest = {
        schemaVersion: 1,
        jobId: capture.jobId,
        tabId: capture.tabId,
        sourceUrl: capture.sourceUrl,
        title: capture.title,
        startedAt: capture.startedAt,
        completedAt: new Date().toISOString(),
        completionReason: finalReason,
        preflight: capture.preflight,
        resources: resourcesWithWorkerContext(capture),
        warnings: [...capture.warnings],
        ...(capture.browser ? { browser: capture.browser } : {}),
        ...(capture.viewport ? { viewport: capture.viewport } : {}),
        ...(capture.runtimeCapabilities
          ? { runtimeCapabilities: capture.runtimeCapabilities }
          : {}),
      };

      await this.#detach(capture, manifest);

      try {
        await chrome.storage.local.set({
          lastCaptureJobId: manifest.jobId,
          [`capture:${manifest.jobId}`]: manifestForStorage(manifest),
        });
      } catch (error) {
        capture.reject(
          new Error(
            `Could not persist the capture manifest: ${redactSensitiveText(
              errorFromUnknown(error).message,
            )}`,
          ),
        );
        return;
      }

      capture.resolve({
        manifest,
        bodies: [...capture.bodies.values()],
      });
    } finally {
      this.#active.delete(capture.tabId);
    }
  }

  async #fail(capture: ActiveCapture, error: Error): Promise<void> {
    if (capture.finishing) {
      capture.completionReason = 'failed';
      capture.abortController.abort();
      return;
    }

    capture.finishing = true;
    capture.completionReason = 'failed';
    capture.abortController.abort();
    this.#clearTimers(capture);

    try {
      await Promise.allSettled([...capture.pendingBodyReads]);
      await this.#detach(capture);

      await chrome.storage.local
        .set({
          lastCaptureError: {
            at: new Date().toISOString(),
            jobId: capture.jobId,
            message: redactSensitiveText(error.message),
          },
        })
        .catch(() => undefined);
      capture.reject(error);
    } finally {
      this.#active.delete(capture.tabId);
    }
  }

  async #detach(capture: ActiveCapture, manifest?: CaptureManifest): Promise<void> {
    if (!capture.attached) {
      return;
    }

    capture.attached = false;

    try {
      await chrome.debugger.detach({ tabId: capture.tabId });
    } catch (error) {
      manifest?.warnings.push(`Debugger detach failed: ${errorFromUnknown(error).message}`);
    }
  }

  #clearTimers(capture: ActiveCapture): void {
    this.#cancelQuietTimer(capture);

    if (capture.maximumTimer !== undefined) {
      clearTimeout(capture.maximumTimer);
      capture.maximumTimer = undefined;
    }
  }

  #minimumCaptureDurationMs(capture: ActiveCapture): number {
    return this.#isInteractiveCapture(capture) ? minimumInteractiveCaptureMs : 0;
  }

  #maximumCaptureDurationMs(capture: ActiveCapture): number {
    return this.#isInteractiveCapture(capture) ? maximumInteractiveCaptureMs : maximumCaptureMs;
  }

  #isInteractiveCapture(capture: ActiveCapture): boolean {
    return (
      capture.preflight.canvasElements > 0 ||
      capture.preflight.webglResourceHints > 0 ||
      capture.preflight.wasmResourceHints > 0
    );
  }

  #notifyProgress(capture: ActiveCapture, state: CaptureProgress['state'], message: string): void {
    if (!capture.onProgress) {
      return;
    }

    try {
      capture.onProgress({
        jobId: capture.jobId,
        state,
        discoveredResources: capture.recorder.size,
        pendingRequests: capture.pendingRequests.size,
        message,
      });
    } catch {
      // Progress listeners must not affect CDP capture.
    }
  }

  #normalizePreflight(value: RuntimePreflightResult | undefined, origin: string): CapturePreflight {
    const nonNegativeInteger = (candidate: number | undefined): number =>
      Number.isSafeInteger(candidate) && Number(candidate) >= 0 ? Number(candidate) : 0;
    const nonNegativeNumber = (candidate: number | undefined): number =>
      typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? candidate : 0;

    return {
      origin,
      canvasElements: nonNegativeInteger(value?.canvasElements),
      iframeElements: nonNegativeInteger(value?.iframeElements),
      mediaElements: nonNegativeInteger(value?.mediaElements),
      serviceWorkerControlled: value?.serviceWorkerControlled === true,
      observedResourceCount: nonNegativeInteger(value?.observedResourceCount),
      observedTransferBytes: nonNegativeNumber(value?.observedTransferBytes),
      workerResourceHints: nonNegativeInteger(value?.workerResourceHints),
      webglResourceHints: nonNegativeInteger(value?.webglResourceHints),
      wasmResourceHints: nonNegativeInteger(value?.wasmResourceHints),
    };
  }

  #seedPerformanceResourceHints(
    capture: ActiveCapture,
    values: RuntimePreflightResult['observedResources'],
  ): number {
    if (!Array.isArray(values)) {
      return 0;
    }

    const seen = new Set<string>();
    let retained = 0;

    for (const [index, value] of values.slice(0, maximumPerformanceResourceHints).entries()) {
      if (!value || typeof value.url !== 'string') {
        continue;
      }

      const url = normalizedHttpUrl(value.url);
      const resourceType = url ? historicalStaticResourceType(url) : undefined;

      if (
        !url ||
        !resourceType ||
        seen.has(url) ||
        isImplicitDefaultFavicon(url, capture.sourceUrl, value.initiatorType)
      ) {
        continue;
      }

      seen.add(url);
      capture.recorder.requestWillBeSent(undefined, {
        requestId: `webmirror-performance-${index}`,
        type: resourceType,
        request: {
          url,
          method: 'GET',
          headers: {},
        },
        initiator: {
          type: 'performance',
        },
      });
      retained += 1;
    }

    return retained;
  }

  #preflightWarnings(preflight: CapturePreflight): string[] {
    const warnings: string[] = [];

    if (
      preflight.observedResourceCount > 500 ||
      preflight.observedTransferBytes > 100 * 1024 * 1024
    ) {
      warnings.push(
        'Preflight indicates that this page may exceed the 120-second performance target.',
      );
    }

    if (preflight.serviceWorkerControlled) {
      warnings.push(
        'The page is controlled by a Service Worker; WebMirror will attempt a read-only CacheStorage fallback for observed resources.',
      );
    }

    if (preflight.mediaElements > 0) {
      warnings.push('Audio or video may require a user gesture after the mirror opens.');
    }

    return warnings;
  }

  #browserInfo(userAgent: string | undefined): { name: string; version: string } | undefined {
    if (!userAgent) {
      return undefined;
    }

    const edge = /\bEdg\/([0-9.]+)/u.exec(userAgent);

    if (edge?.[1]) {
      return { name: 'Microsoft Edge', version: edge[1] };
    }

    const chrome = /\bChrome\/([0-9.]+)/u.exec(userAgent);
    return chrome?.[1] ? { name: 'Google Chrome', version: chrome[1] } : undefined;
  }
}
