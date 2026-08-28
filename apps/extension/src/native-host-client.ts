import {
  isNativeHostResponse,
  nativeMessagingProtocolVersion,
  nativeResourceBodyChunkBytes,
  type NativeHostResponse,
  type NativeJobAction,
  type NativeJobActionResult,
  type NativeMirrorCancelResult,
  type NativeMirrorCaptureInput,
  type NativeMirrorProgressEvent,
  type NativeMirrorResult,
  type NativeMirrorResultSummary,
  type NativeResourceBodyStartRequest,
  type NativeResourceBodyResult,
} from '@webmirror/shared';

import type { CapturedResponseBody } from './capture-controller.js';

export const nativeHostName = 'com.webmirror.helper';

export interface NativeHostInfo {
  helperVersion: string;
  protocolVersion: number;
  capabilities: readonly string[];
}

type CorrelatedResponse =
  | Extract<NativeHostResponse, { type: 'handshake_result' }>
  | NativeMirrorResult
  | NativeMirrorCancelResult
  | NativeResourceBodyResult
  | NativeJobActionResult;

interface PendingRequest {
  expectedType: CorrelatedResponse['type'];
  resolve: (response: CorrelatedResponse) => void;
  reject: (error: Error) => void;
  clearTimeout: () => void;
  progressJobId?: string;
  refreshTimeout?: () => void;
}

export type NativeProgressListener = (event: NativeMirrorProgressEvent) => void;

type NativeResourceBodyReuseScope = NonNullable<NativeResourceBodyStartRequest['reuseScope']>;

class NativeHostRequestTimeoutError extends Error {
  constructor(
    readonly requestType: string,
    readonly timeoutMs: number,
    progressAware: boolean,
  ) {
    super(
      progressAware
        ? `The WebMirror helper reported no progress for ${Math.round(timeoutMs / 1000)} seconds while handling ${requestType}.`
        : `The WebMirror helper did not answer ${requestType}.`,
    );
    this.name = 'NativeHostRequestTimeoutError';
  }
}

function runtimeLastErrorMessage(): string | undefined {
  return chrome.runtime.lastError?.message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const stringChunkBytes = 32 * 1024;

  for (let offset = 0; offset < bytes.byteLength; offset += stringChunkBytes) {
    const end = Math.min(offset + stringChunkBytes, bytes.byteLength);

    for (let index = offset; index < end; index += 1) {
      binary += String.fromCharCode(bytes[index] ?? 0);
    }
  }

  return btoa(binary);
}

function capturedBodyReuseScope(body: CapturedResponseBody): NativeResourceBodyReuseScope {
  const reuseScope = (
    body.descriptor as CapturedResponseBody['descriptor'] & { reuseScope?: unknown }
  ).reuseScope;

  if (reuseScope === undefined || reuseScope === 'same_origin') {
    return 'same_origin';
  }

  if (reuseScope === 'public_cross_origin') {
    return reuseScope;
  }

  throw new Error(`Captured response body ${body.descriptor.id} has an invalid reuse scope.`);
}

export class NativeHostClient {
  #port: chrome.runtime.Port | undefined;
  #info: NativeHostInfo | undefined;
  #connectPromise: Promise<NativeHostInfo> | undefined;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #progressListeners = new Set<NativeProgressListener>();
  readonly #cancelRequested = new Set<string>();

  get info(): NativeHostInfo | undefined {
    return this.#info;
  }

  async connect(): Promise<NativeHostInfo> {
    if (this.#info) {
      return this.#info;
    }

    if (this.#connectPromise) {
      return this.#connectPromise;
    }

    const port = this.#port ?? this.#createPort();
    const requestId = crypto.randomUUID();
    const promise = this.#request<Extract<NativeHostResponse, { type: 'handshake_result' }>>(
      port,
      {
        type: 'handshake',
        requestId,
        protocolVersion: nativeMessagingProtocolVersion,
        extensionVersion: chrome.runtime.getManifest().version,
      },
      'handshake_result',
      5_000,
    )
      .then((result) => {
        if (!result.accepted) {
          throw new Error(result.error.message);
        }

        const info: NativeHostInfo = {
          helperVersion: result.helperVersion,
          protocolVersion: result.protocolVersion,
          capabilities: [...result.capabilities],
        };
        this.#info = info;
        return info;
      })
      .catch((error: unknown) => {
        const normalized = new Error(errorMessage(error));

        if (this.#port === port) {
          this.#reset(normalized);
        }

        try {
          port.disconnect();
        } catch {
          // The failed Native Messaging port may already be disconnected.
        }

        throw normalized;
      })
      .finally(() => {
        this.#connectPromise = undefined;
      });
    this.#connectPromise = promise;
    return promise;
  }

  async connectCurrentVersion(): Promise<NativeHostInfo> {
    const expectedVersion = chrome.runtime.getManifest().version;
    const connected = await this.connect();

    if (connected.helperVersion === expectedVersion) {
      return connected;
    }

    this.disconnect();
    const reconnected = await this.connect();

    if (reconnected.helperVersion === expectedVersion) {
      return reconnected;
    }

    this.disconnect();
    throw new Error(
      `WebMirror extension v${expectedVersion} requires Helper v${expectedVersion}, but Helper v${reconnected.helperVersion} is installed. Upgrade the WebMirror Helper and try again.`,
    );
  }

  async createMirror(
    jobId: string,
    capture: NativeMirrorCaptureInput,
    bodies: readonly CapturedResponseBody[] = [],
  ): Promise<NativeMirrorResultSummary> {
    const info = await this.connectCurrentVersion();
    const port = this.#requirePort();

    try {
      this.#throwIfCancelRequested(jobId);
      const referencedBodyIds = new Set(
        capture.resources.flatMap((resource) => (resource.bodyId ? [resource.bodyId] : [])),
      );
      const bodySourceUrls = new Map(
        capture.resources.flatMap((resource) =>
          resource.bodyId ? [[resource.bodyId, resource.sourceUrl] as const] : [],
        ),
      );
      const referencedBodies = bodies.filter((body) => referencedBodyIds.has(body.descriptor.id));

      if (referencedBodyIds.size !== referencedBodies.length) {
        throw new Error('One or more captured response bodies are missing from extension memory.');
      }

      if (referencedBodies.length > 0 && !info.capabilities.includes('resource-body-chunks-v2')) {
        throw new Error(
          'The installed WebMirror helper does not support captured response bodies.',
        );
      }

      const bodyReuseScopes = new Map(
        referencedBodies.map((body) => [body.descriptor.id, capturedBodyReuseScope(body)] as const),
      );

      if (
        [...bodyReuseScopes.values()].includes('public_cross_origin') &&
        !info.capabilities.includes('public-cross-origin-body-v1')
      ) {
        throw new Error(
          'The installed WebMirror helper cannot reuse public cross-origin response bodies. Upgrade the WebMirror helper and try again.',
        );
      }

      if (
        capture.runtimeCapabilities &&
        !info.capabilities.includes('runtime-capability-profile-v1')
      ) {
        throw new Error(
          'The installed WebMirror helper cannot preserve the capture browser rendering profile. Upgrade the WebMirror helper and try again.',
        );
      }

      try {
        for (const body of referencedBodies) {
          const sourceUrl = bodySourceUrls.get(body.descriptor.id);
          const reuseScope = bodyReuseScopes.get(body.descriptor.id);

          if (!sourceUrl || !reuseScope) {
            throw new Error(`Captured response body ${body.descriptor.id} has no source URL.`);
          }

          await this.#uploadResourceBody(
            port,
            jobId,
            body,
            sourceUrl,
            new URL(capture.sourceUrl).origin,
            reuseScope,
          );
        }
        this.#throwIfCancelRequested(jobId);
      } catch (error) {
        await this.cancel(jobId).catch(() => false);
        throw error;
      }

      const requestId = crypto.randomUUID();
      let result: NativeMirrorResult;

      try {
        result = await this.#request<NativeMirrorResult>(
          port,
          {
            type: 'mirror_create',
            requestId,
            protocolVersion: nativeMessagingProtocolVersion,
            jobId,
            capture,
          },
          'mirror_result',
          10 * 60_000,
          jobId,
        );
      } catch (error) {
        if (error instanceof NativeHostRequestTimeoutError) {
          await this.cancel(jobId).catch(() => false);
        }

        throw error;
      }

      if (!result.success) {
        throw new Error(result.error.message);
      }

      return result.result;
    } finally {
      this.#cancelRequested.delete(jobId);
    }
  }

  async cancel(jobId: string): Promise<boolean> {
    this.#cancelRequested.add(jobId);
    await this.connect();
    const result = await this.#request<NativeMirrorCancelResult>(
      this.#requirePort(),
      {
        type: 'mirror_cancel',
        requestId: crypto.randomUUID(),
        protocolVersion: nativeMessagingProtocolVersion,
        jobId,
      },
      'mirror_cancel_result',
      10_000,
    );
    return result.accepted;
  }

  async runAction(jobId: string, action: NativeJobAction): Promise<NativeJobActionResult> {
    await this.connect();
    const result = await this.#request<NativeJobActionResult>(
      this.#requirePort(),
      {
        type: 'job_action',
        requestId: crypto.randomUUID(),
        protocolVersion: nativeMessagingProtocolVersion,
        jobId,
        action,
      },
      'job_action_result',
      action === 'export_zip' ? 5 * 60_000 : 30_000,
    );

    if (!result.success) {
      throw new Error(result.error.message);
    }

    return result;
  }

  onProgress(listener: NativeProgressListener): () => void {
    this.#progressListeners.add(listener);
    return () => {
      this.#progressListeners.delete(listener);
    };
  }

  disconnect(): void {
    const port = this.#port;
    this.#reset(new Error('The WebMirror helper connection was closed.'));
    port?.disconnect();
  }

  async #uploadResourceBody(
    port: chrome.runtime.Port,
    jobId: string,
    body: CapturedResponseBody,
    sourceUrl: string,
    sourceOrigin: string,
    reuseScope: NativeResourceBodyReuseScope,
  ): Promise<void> {
    const { descriptor, bytes } = body;

    this.#throwIfCancelRequested(jobId);

    if (bytes.byteLength !== descriptor.byteLength) {
      throw new Error(`Captured response body ${descriptor.id} has an invalid byte length.`);
    }

    const start = await this.#request<NativeResourceBodyResult>(
      port,
      {
        type: 'resource_body_start',
        requestId: crypto.randomUUID(),
        protocolVersion: nativeMessagingProtocolVersion,
        jobId,
        bodyId: descriptor.id,
        sourceUrl,
        sourceOrigin: `${sourceOrigin}/`,
        ...(reuseScope === 'public_cross_origin' ? { reuseScope } : {}),
        byteLength: descriptor.byteLength,
        sha256: descriptor.sha256,
      },
      'resource_body_result',
      30_000,
    );
    this.#assertBodyResult(start, jobId, descriptor.id, 'start', 0, false);

    let offset = 0;

    while (offset < bytes.byteLength) {
      this.#throwIfCancelRequested(jobId);
      const chunk = bytes.subarray(
        offset,
        Math.min(offset + nativeResourceBodyChunkBytes, bytes.byteLength),
      );
      const nextOffset = offset + chunk.byteLength;
      const result = await this.#request<NativeResourceBodyResult>(
        port,
        {
          type: 'resource_body_chunk',
          requestId: crypto.randomUUID(),
          protocolVersion: nativeMessagingProtocolVersion,
          jobId,
          bodyId: descriptor.id,
          offset,
          data: encodeBase64(chunk),
        },
        'resource_body_result',
        30_000,
      );
      this.#assertBodyResult(result, jobId, descriptor.id, 'chunk', nextOffset, false);
      offset = nextOffset;
    }

    this.#throwIfCancelRequested(jobId);
    const end = await this.#request<NativeResourceBodyResult>(
      port,
      {
        type: 'resource_body_end',
        requestId: crypto.randomUUID(),
        protocolVersion: nativeMessagingProtocolVersion,
        jobId,
        bodyId: descriptor.id,
        byteLength: descriptor.byteLength,
        sha256: descriptor.sha256,
      },
      'resource_body_result',
      30_000,
    );
    this.#assertBodyResult(end, jobId, descriptor.id, 'end', descriptor.byteLength, true);
  }

  #throwIfCancelRequested(jobId: string): void {
    if (this.#cancelRequested.has(jobId)) {
      const error = new Error('The WebMirror job was cancelled.');
      error.name = 'AbortError';
      throw error;
    }
  }

  #assertBodyResult(
    result: NativeResourceBodyResult,
    jobId: string,
    bodyId: string,
    stage: NativeResourceBodyResult['stage'],
    nextOffset: number,
    complete: boolean,
  ): void {
    if (!result.accepted) {
      throw new Error(result.error.message);
    }

    if (
      result.jobId !== jobId ||
      result.bodyId !== bodyId ||
      result.stage !== stage ||
      result.nextOffset !== nextOffset ||
      result.complete !== complete
    ) {
      throw new Error('The WebMirror helper returned an invalid response-body acknowledgement.');
    }
  }

  #createPort(): chrome.runtime.Port {
    const port = chrome.runtime.connectNative(nativeHostName);
    this.#port = port;
    port.onMessage.addListener((message: unknown) => {
      if (this.#port !== port) {
        return;
      }

      this.#handleMessage(message);
    });
    port.onDisconnect.addListener(() => {
      if (this.#port !== port) {
        return;
      }

      const message = runtimeLastErrorMessage() ?? 'The WebMirror helper disconnected.';
      this.#reset(new Error(message));
    });
    return port;
  }

  #requirePort(): chrome.runtime.Port {
    if (!this.#port) {
      throw new Error('The WebMirror helper is not connected.');
    }

    return this.#port;
  }

  #request<T extends CorrelatedResponse>(
    port: chrome.runtime.Port,
    message: { requestId: string } & Record<string, unknown>,
    expectedType: T['type'],
    timeoutMs: number,
    progressJobId?: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const expire = (): void => {
        this.#pending.delete(message.requestId);
        reject(
          new NativeHostRequestTimeoutError(
            String(message.type ?? 'the request'),
            timeoutMs,
            progressJobId !== undefined,
          ),
        );
      };
      const clearRequestTimeout = (): void => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
          timeout = undefined;
        }
      };
      const refreshTimeout = (): void => {
        clearRequestTimeout();
        timeout = setTimeout(expire, timeoutMs);
      };
      refreshTimeout();
      this.#pending.set(message.requestId, {
        expectedType,
        resolve: (response) => resolve(response as T),
        reject,
        clearTimeout: clearRequestTimeout,
        ...(progressJobId ? { progressJobId, refreshTimeout } : {}),
      });

      try {
        port.postMessage(message);
      } catch (error) {
        clearRequestTimeout();
        this.#pending.delete(message.requestId);
        reject(new Error(errorMessage(error)));
      }
    });
  }

  #handleMessage(message: unknown): void {
    if (!isNativeHostResponse(message)) {
      return;
    }

    if (message.type === 'mirror_progress') {
      for (const pending of this.#pending.values()) {
        if (pending.progressJobId === message.jobId) {
          pending.refreshTimeout?.();
        }
      }

      for (const listener of this.#progressListeners) {
        try {
          listener(message);
        } catch {
          // One UI listener must not break the native connection.
        }
      }
      return;
    }

    if (message.type === 'error') {
      if (message.requestId) {
        const pending = this.#pending.get(message.requestId);

        if (pending) {
          pending.clearTimeout();
          this.#pending.delete(message.requestId);
          pending.reject(new Error(message.error.message));
        }
      }
      return;
    }

    const pending = this.#pending.get(message.requestId);

    if (!pending || message.type !== pending.expectedType) {
      return;
    }

    pending.clearTimeout();
    this.#pending.delete(message.requestId);
    pending.resolve(message);
  }

  #reset(error: Error): void {
    this.#port = undefined;
    this.#info = undefined;
    this.#connectPromise = undefined;

    for (const pending of this.#pending.values()) {
      pending.clearTimeout();
      pending.reject(error);
    }

    this.#pending.clear();
  }
}
