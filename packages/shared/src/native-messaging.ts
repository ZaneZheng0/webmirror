import { jobStates, type JobState } from './job-state.js';
import { isRuntimeCapabilities, type RuntimeCapabilities } from './runtime-capabilities.js';

export const nativeMessagingProtocolVersion = 2 as const;

export const nativeMessagingMaxMessageBytes = 1024 * 1024;

export const nativeResourceBodyChunkBytes = 512 * 1024;

export const nativeResourceBodyMaxBytes = 20 * 1024 * 1024;

export const nativeResourceBodiesMaxBytes = 50 * 1024 * 1024;

export const nativeResourceBodiesMaxCount = 5_000;

export const nativeResourceBodyReuseScopes = ['same_origin', 'public_cross_origin'] as const;

export type NativeResourceBodyReuseScope = (typeof nativeResourceBodyReuseScopes)[number];

export const nativeMessagingCapabilities = [
  'framed-json-v1',
  'mirror-create-v1',
  'mirror-cancel-v1',
  'job-actions-v1',
  'fast-validation-v1',
  'resource-body-chunks-v2',
  'public-cross-origin-body-v1',
  'runtime-capability-profile-v1',
] as const;

export const nativeCaptureCompletionReasons = [
  'network_idle',
  'maximum_duration',
  'detached',
  'cancelled',
  'failed',
] as const;

export type NativeCaptureCompletionReason = (typeof nativeCaptureCompletionReasons)[number];

export const nativeHostErrorCodes = [
  'HANDSHAKE_REQUIRED',
  'UNSUPPORTED_PROTOCOL_VERSION',
  'INVALID_MESSAGE',
  'INVALID_JSON',
  'MESSAGE_TOO_LARGE',
  'UNEXPECTED_EOF',
  'JOB_ALREADY_RUNNING',
  'JOB_NOT_FOUND',
  'INVALID_ACTION',
  'MIRROR_FAILED',
  'RESOURCE_BODY_INVALID',
  'RESOURCE_BODY_NOT_FOUND',
  'RESOURCE_BODY_LIMIT_EXCEEDED',
  'RESOURCE_BODY_HASH_MISMATCH',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export type NativeHostErrorCode = (typeof nativeHostErrorCodes)[number];

export interface NativeHostErrorDetail {
  code: NativeHostErrorCode;
  message: string;
}

export interface NativeHandshakeRequest {
  type: 'handshake';
  requestId: string;
  protocolVersion: number;
  extensionVersion: string;
}

export type NativeHandshakeResult =
  | {
      type: 'handshake_result';
      requestId: string;
      accepted: true;
      protocolVersion: typeof nativeMessagingProtocolVersion;
      helperVersion: string;
      capabilities: readonly string[];
      error: null;
    }
  | {
      type: 'handshake_result';
      requestId: string;
      accepted: false;
      protocolVersion: typeof nativeMessagingProtocolVersion;
      helperVersion: string;
      capabilities: readonly [];
      error: NativeHostErrorDetail;
    };

export interface NativeMirrorResourceInput {
  sourceUrl: string;
  method: string;
  contentType?: string;
  expectedSize?: number;
  bodyId?: string;
  resourceType?: string;
  initiatorType?: string;
  workerContext?: boolean;
}

export interface NativeMirrorCaptureInput {
  sourceUrl: string;
  title?: string;
  capturedAt: string;
  completionReason?: NativeCaptureCompletionReason;
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
  resources: readonly NativeMirrorResourceInput[];
  warnings: readonly string[];
}

export interface NativeMirrorCreateRequest {
  type: 'mirror_create';
  requestId: string;
  protocolVersion: typeof nativeMessagingProtocolVersion;
  jobId: string;
  capture: NativeMirrorCaptureInput;
}

export interface NativeMirrorCancelRequest {
  type: 'mirror_cancel';
  requestId: string;
  protocolVersion: typeof nativeMessagingProtocolVersion;
  jobId: string;
}

export const nativeResourceBodyStages = ['start', 'chunk', 'end'] as const;

export type NativeResourceBodyStage = (typeof nativeResourceBodyStages)[number];

export interface NativeResourceBodyStartRequest {
  type: 'resource_body_start';
  requestId: string;
  protocolVersion: typeof nativeMessagingProtocolVersion;
  jobId: string;
  bodyId: string;
  sourceUrl: string;
  sourceOrigin: string;
  reuseScope?: NativeResourceBodyReuseScope;
  byteLength: number;
  sha256: string;
}

export interface NativeResourceBodyChunkRequest {
  type: 'resource_body_chunk';
  requestId: string;
  protocolVersion: typeof nativeMessagingProtocolVersion;
  jobId: string;
  bodyId: string;
  offset: number;
  data: string;
}

export interface NativeResourceBodyEndRequest {
  type: 'resource_body_end';
  requestId: string;
  protocolVersion: typeof nativeMessagingProtocolVersion;
  jobId: string;
  bodyId: string;
  byteLength: number;
  sha256: string;
}

export type NativeResourceBodyRequest =
  NativeResourceBodyStartRequest | NativeResourceBodyChunkRequest | NativeResourceBodyEndRequest;

export const nativeJobActions = [
  'open_preview',
  'open_output',
  'open_report',
  'export_zip',
  'retry_failed',
  'revalidate',
] as const;

export type NativeJobAction = (typeof nativeJobActions)[number];

export interface NativeJobActionRequest {
  type: 'job_action';
  requestId: string;
  protocolVersion: typeof nativeMessagingProtocolVersion;
  jobId: string;
  action: NativeJobAction;
}

export type NativePostHandshakeRequest =
  | NativeMirrorCreateRequest
  | NativeMirrorCancelRequest
  | NativeResourceBodyRequest
  | NativeJobActionRequest;

export type NativeHostRequest = NativeHandshakeRequest | NativePostHandshakeRequest;

export interface NativeMirrorProgressEvent {
  type: 'mirror_progress';
  protocolVersion: typeof nativeMessagingProtocolVersion;
  jobId: string;
  state: JobState;
  discoveredResources: number;
  completedResources: number;
  downloadedBytes: number;
  warningCount: number;
  elapsedMs: number;
  message: string;
}

export type NativeMirrorResultStatus = 'complete' | 'partial' | 'failed' | 'cancelled';

export interface NativeMirrorResultSummary {
  status: NativeMirrorResultStatus;
  outputDirectory: string;
  previewUrl?: string;
  entryUrl?: string;
  manifestPath: string;
  validationPath?: string;
  reportUrl?: string;
  zipPath?: string;
  totalResources: number;
  downloadedResources: number;
  failedResources: number;
  downloadedBytes: number;
  warningCount: number;
  elapsedMs: number;
  completenessScore?: number;
  onlineDependencies: readonly string[];
}

export type NativeMirrorResult =
  | {
      type: 'mirror_result';
      requestId: string;
      protocolVersion: typeof nativeMessagingProtocolVersion;
      jobId: string;
      success: true;
      result: NativeMirrorResultSummary;
      error: null;
    }
  | {
      type: 'mirror_result';
      requestId: string;
      protocolVersion: typeof nativeMessagingProtocolVersion;
      jobId: string;
      success: false;
      result: null;
      error: NativeHostErrorDetail;
    };

export interface NativeMirrorCancelResult {
  type: 'mirror_cancel_result';
  requestId: string;
  protocolVersion: typeof nativeMessagingProtocolVersion;
  jobId: string;
  accepted: boolean;
  error: NativeHostErrorDetail | null;
}

export type NativeResourceBodyResult =
  | {
      type: 'resource_body_result';
      requestId: string;
      protocolVersion: typeof nativeMessagingProtocolVersion;
      jobId: string;
      bodyId: string;
      stage: NativeResourceBodyStage;
      accepted: true;
      nextOffset: number;
      complete: boolean;
      error: null;
    }
  | {
      type: 'resource_body_result';
      requestId: string;
      protocolVersion: typeof nativeMessagingProtocolVersion;
      jobId: string;
      bodyId: string;
      stage: NativeResourceBodyStage;
      accepted: false;
      nextOffset: number;
      complete: false;
      error: NativeHostErrorDetail;
    };

export type NativeJobActionResult =
  | {
      type: 'job_action_result';
      requestId: string;
      protocolVersion: typeof nativeMessagingProtocolVersion;
      jobId: string;
      action: NativeJobAction;
      success: true;
      path?: string;
      url?: string;
      result?: NativeMirrorResultSummary;
      error: null;
    }
  | {
      type: 'job_action_result';
      requestId: string;
      protocolVersion: typeof nativeMessagingProtocolVersion;
      jobId: string;
      action: NativeJobAction;
      success: false;
      error: NativeHostErrorDetail;
    };

export interface NativeHostErrorResponse {
  type: 'error';
  requestId: string | null;
  protocolVersion: typeof nativeMessagingProtocolVersion;
  error: NativeHostErrorDetail;
}

export type NativeHostResponse =
  | NativeHandshakeResult
  | NativeMirrorProgressEvent
  | NativeMirrorResult
  | NativeMirrorCancelResult
  | NativeResourceBodyResult
  | NativeJobActionResult
  | NativeHostErrorResponse;

const maxRequestIdLength = 128;
const maxJobIdLength = 128;
const maxBodyIdLength = 128;
const maxVersionLength = 128;
const maxUrlLength = 8192;
const maxTitleLength = 2048;
const maxContentTypeLength = 256;
const maxRuntimeEvidenceTypeLength = 128;
const maxWarningLength = 2048;
const maxResources = 5_000;
const maxWarnings = 1_000;
const maxPathLength = 32_768;
const maxMessageLength = 2_048;
const maxResourceBodyChunkBase64Length = Math.ceil(nativeResourceBodyChunkBytes / 3) * 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isOptionalBoundedString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= maxLength);
}

function isOptionalNonEmptyBoundedString(
  value: unknown,
  maxLength: number,
): value is string | undefined {
  return value === undefined || isBoundedString(value, maxLength);
}

function isProtocolVersion(value: unknown): value is typeof nativeMessagingProtocolVersion {
  return value === nativeMessagingProtocolVersion;
}

function isRequestEnvelope(
  value: Record<string, unknown>,
  expectedType: NativePostHandshakeRequest['type'],
): boolean {
  return (
    value.type === expectedType &&
    isBoundedString(value.requestId, maxRequestIdLength) &&
    isProtocolVersion(value.protocolVersion) &&
    isBoundedString(value.jobId, maxJobIdLength)
  );
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isBase64Chunk(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxResourceBodyChunkBase64Length &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  );
}

function isHttpUrl(value: unknown): value is string {
  if (!isBoundedString(value, maxUrlLength)) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function isHttpOrigin(value: unknown): value is string {
  if (!isHttpUrl(value)) {
    return false;
  }

  const url = new URL(value);
  return url.href === `${url.origin}/`;
}

function isLoopbackHttpUrl(value: unknown): value is string {
  if (!isHttpUrl(value)) {
    return false;
  }

  const hostname = new URL(value).hostname.toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '');
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '::1' ||
    hostname === '0:0:0:0:0:0:0:1' ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}

function isMirrorResourceInput(value: unknown): value is NativeMirrorResourceInput {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasOnlyKeys(value, [
      'sourceUrl',
      'method',
      'contentType',
      'expectedSize',
      'bodyId',
      'resourceType',
      'initiatorType',
      'workerContext',
    ]) &&
    isHttpUrl(value.sourceUrl) &&
    isBoundedString(value.method, 16) &&
    isOptionalBoundedString(value.contentType, maxContentTypeLength) &&
    (value.expectedSize === undefined || isFiniteNonNegativeNumber(value.expectedSize)) &&
    (value.bodyId === undefined || isBoundedString(value.bodyId, maxBodyIdLength)) &&
    isOptionalNonEmptyBoundedString(value.resourceType, maxRuntimeEvidenceTypeLength) &&
    isOptionalNonEmptyBoundedString(value.initiatorType, maxRuntimeEvidenceTypeLength) &&
    (value.workerContext === undefined || typeof value.workerContext === 'boolean')
  );
}

function hasUniqueBodyIds(resources: readonly NativeMirrorResourceInput[]): boolean {
  const bodyIds = resources.flatMap((resource) => (resource.bodyId ? [resource.bodyId] : []));
  return new Set(bodyIds).size === bodyIds.length;
}

function isBrowserInfo(value: unknown): value is NonNullable<NativeMirrorCaptureInput['browser']> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['name', 'version']) &&
    isBoundedString(value.name, maxVersionLength) &&
    isBoundedString(value.version, maxVersionLength)
  );
}

function isViewport(value: unknown): value is NonNullable<NativeMirrorCaptureInput['viewport']> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['width', 'height', 'deviceScaleFactor']) &&
    Number.isSafeInteger(value.width) &&
    Number(value.width) > 0 &&
    Number.isSafeInteger(value.height) &&
    Number(value.height) > 0 &&
    isFiniteNonNegativeNumber(value.deviceScaleFactor) &&
    Number(value.deviceScaleFactor) > 0
  );
}

function isMirrorCaptureInput(value: unknown): value is NativeMirrorCaptureInput {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasOnlyKeys(value, [
      'sourceUrl',
      'title',
      'capturedAt',
      'completionReason',
      'browser',
      'viewport',
      'runtimeCapabilities',
      'resources',
      'warnings',
    ]) &&
    isHttpUrl(value.sourceUrl) &&
    isOptionalBoundedString(value.title, maxTitleLength) &&
    isBoundedString(value.capturedAt, maxVersionLength) &&
    (value.completionReason === undefined ||
      nativeCaptureCompletionReasons.includes(
        value.completionReason as NativeCaptureCompletionReason,
      )) &&
    (value.browser === undefined || isBrowserInfo(value.browser)) &&
    (value.viewport === undefined || isViewport(value.viewport)) &&
    (value.runtimeCapabilities === undefined || isRuntimeCapabilities(value.runtimeCapabilities)) &&
    Array.isArray(value.resources) &&
    value.resources.length <= maxResources &&
    value.resources.every(isMirrorResourceInput) &&
    hasUniqueBodyIds(value.resources as NativeMirrorResourceInput[]) &&
    Array.isArray(value.warnings) &&
    value.warnings.length <= maxWarnings &&
    value.warnings.every(
      (warning) => typeof warning === 'string' && warning.length <= maxWarningLength,
    )
  );
}

export function isNativeHandshakeRequest(value: unknown): value is NativeHandshakeRequest {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasOnlyKeys(value, ['type', 'requestId', 'protocolVersion', 'extensionVersion']) &&
    value.type === 'handshake' &&
    isBoundedString(value.requestId, maxRequestIdLength) &&
    typeof value.protocolVersion === 'number' &&
    Number.isSafeInteger(value.protocolVersion) &&
    value.protocolVersion > 0 &&
    isBoundedString(value.extensionVersion, maxVersionLength)
  );
}

export function isNativeMirrorCreateRequest(value: unknown): value is NativeMirrorCreateRequest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'requestId', 'protocolVersion', 'jobId', 'capture']) &&
    isRequestEnvelope(value, 'mirror_create') &&
    isMirrorCaptureInput(value.capture)
  );
}

export function isNativeMirrorCancelRequest(value: unknown): value is NativeMirrorCancelRequest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'requestId', 'protocolVersion', 'jobId']) &&
    isRequestEnvelope(value, 'mirror_cancel')
  );
}

export function isNativeResourceBodyStartRequest(
  value: unknown,
): value is NativeResourceBodyStartRequest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'type',
      'requestId',
      'protocolVersion',
      'jobId',
      'bodyId',
      'sourceUrl',
      'sourceOrigin',
      'reuseScope',
      'byteLength',
      'sha256',
    ]) ||
    !isRequestEnvelope(value, 'resource_body_start') ||
    !isBoundedString(value.bodyId, maxBodyIdLength) ||
    !isHttpUrl(value.sourceUrl) ||
    !isHttpOrigin(value.sourceOrigin) ||
    (value.reuseScope !== undefined &&
      !nativeResourceBodyReuseScopes.includes(value.reuseScope as NativeResourceBodyReuseScope)) ||
    !isSafeNonNegativeInteger(value.byteLength) ||
    Number(value.byteLength) > nativeResourceBodyMaxBytes ||
    !isSha256(value.sha256)
  ) {
    return false;
  }

  const sourceUrl = new URL(value.sourceUrl);
  const sourceOrigin = new URL(value.sourceOrigin).origin;
  const reuseScope = value.reuseScope ?? 'same_origin';

  return reuseScope === 'same_origin'
    ? sourceUrl.origin === sourceOrigin
    : sourceUrl.protocol === 'https:' && sourceUrl.origin !== sourceOrigin;
}

export function isNativeResourceBodyChunkRequest(
  value: unknown,
): value is NativeResourceBodyChunkRequest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'type',
      'requestId',
      'protocolVersion',
      'jobId',
      'bodyId',
      'offset',
      'data',
    ]) &&
    isRequestEnvelope(value, 'resource_body_chunk') &&
    isBoundedString(value.bodyId, maxBodyIdLength) &&
    isSafeNonNegativeInteger(value.offset) &&
    isBase64Chunk(value.data)
  );
}

export function isNativeResourceBodyEndRequest(
  value: unknown,
): value is NativeResourceBodyEndRequest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'type',
      'requestId',
      'protocolVersion',
      'jobId',
      'bodyId',
      'byteLength',
      'sha256',
    ]) &&
    isRequestEnvelope(value, 'resource_body_end') &&
    isBoundedString(value.bodyId, maxBodyIdLength) &&
    isSafeNonNegativeInteger(value.byteLength) &&
    Number(value.byteLength) <= nativeResourceBodyMaxBytes &&
    isSha256(value.sha256)
  );
}

export function isNativeResourceBodyRequest(value: unknown): value is NativeResourceBodyRequest {
  return (
    isNativeResourceBodyStartRequest(value) ||
    isNativeResourceBodyChunkRequest(value) ||
    isNativeResourceBodyEndRequest(value)
  );
}

export function isNativeJobActionRequest(value: unknown): value is NativeJobActionRequest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'requestId', 'protocolVersion', 'jobId', 'action']) &&
    isRequestEnvelope(value, 'job_action') &&
    nativeJobActions.includes(value.action as NativeJobAction)
  );
}

export function isNativePostHandshakeRequest(value: unknown): value is NativePostHandshakeRequest {
  return (
    isNativeMirrorCreateRequest(value) ||
    isNativeMirrorCancelRequest(value) ||
    isNativeResourceBodyRequest(value) ||
    isNativeJobActionRequest(value)
  );
}

function isNativeHostErrorDetail(value: unknown): value is NativeHostErrorDetail {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['code', 'message']) &&
    nativeHostErrorCodes.includes(value.code as NativeHostErrorCode) &&
    isBoundedString(value.message, maxMessageLength)
  );
}

function isNativeMirrorResultSummary(value: unknown): value is NativeMirrorResultSummary {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'status',
      'outputDirectory',
      'previewUrl',
      'entryUrl',
      'manifestPath',
      'validationPath',
      'reportUrl',
      'zipPath',
      'totalResources',
      'downloadedResources',
      'failedResources',
      'downloadedBytes',
      'warningCount',
      'elapsedMs',
      'completenessScore',
      'onlineDependencies',
    ])
  ) {
    return false;
  }

  return (
    ['complete', 'partial', 'failed', 'cancelled'].includes(value.status as string) &&
    isBoundedString(value.outputDirectory, maxPathLength) &&
    (value.previewUrl === undefined || isLoopbackHttpUrl(value.previewUrl)) &&
    (value.entryUrl === undefined || isLoopbackHttpUrl(value.entryUrl)) &&
    isBoundedString(value.manifestPath, maxPathLength) &&
    isOptionalNonEmptyBoundedString(value.validationPath, maxPathLength) &&
    (value.reportUrl === undefined || isLoopbackHttpUrl(value.reportUrl)) &&
    isOptionalNonEmptyBoundedString(value.zipPath, maxPathLength) &&
    isSafeNonNegativeInteger(value.totalResources) &&
    isSafeNonNegativeInteger(value.downloadedResources) &&
    isSafeNonNegativeInteger(value.failedResources) &&
    isFiniteNonNegativeNumber(value.downloadedBytes) &&
    isSafeNonNegativeInteger(value.warningCount) &&
    isFiniteNonNegativeNumber(value.elapsedMs) &&
    (value.completenessScore === undefined ||
      (isFiniteNonNegativeNumber(value.completenessScore) &&
        Number(value.completenessScore) <= 100)) &&
    Array.isArray(value.onlineDependencies) &&
    value.onlineDependencies.length <= maxResources &&
    value.onlineDependencies.every(isHttpUrl)
  );
}

export function isNativeHandshakeResult(value: unknown): value is NativeHandshakeResult {
  if (!isRecord(value)) {
    return false;
  }

  if (
    !hasOnlyKeys(value, [
      'type',
      'requestId',
      'accepted',
      'protocolVersion',
      'helperVersion',
      'capabilities',
      'error',
    ]) ||
    value.type !== 'handshake_result' ||
    !isBoundedString(value.requestId, maxRequestIdLength) ||
    value.protocolVersion !== nativeMessagingProtocolVersion ||
    !isBoundedString(value.helperVersion, maxVersionLength) ||
    typeof value.accepted !== 'boolean' ||
    !Array.isArray(value.capabilities)
  ) {
    return false;
  }

  if (value.accepted) {
    return (
      value.error === null &&
      value.capabilities.every(
        (item) =>
          typeof item === 'string' &&
          nativeMessagingCapabilities.includes(
            item as (typeof nativeMessagingCapabilities)[number],
          ),
      )
    );
  }

  return isNativeHostErrorDetail(value.error) && value.capabilities.length === 0;
}

export function isNativeHostErrorResponse(value: unknown): value is NativeHostErrorResponse {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'requestId', 'protocolVersion', 'error']) &&
    value.type === 'error' &&
    (value.requestId === null || isBoundedString(value.requestId, maxRequestIdLength)) &&
    value.protocolVersion === nativeMessagingProtocolVersion &&
    isNativeHostErrorDetail(value.error)
  );
}

export function isNativeMirrorProgressEvent(value: unknown): value is NativeMirrorProgressEvent {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'type',
      'protocolVersion',
      'jobId',
      'state',
      'discoveredResources',
      'completedResources',
      'downloadedBytes',
      'warningCount',
      'elapsedMs',
      'message',
    ]) &&
    value.type === 'mirror_progress' &&
    value.protocolVersion === nativeMessagingProtocolVersion &&
    isBoundedString(value.jobId, maxJobIdLength) &&
    jobStates.includes(value.state as JobState) &&
    isSafeNonNegativeInteger(value.discoveredResources) &&
    isSafeNonNegativeInteger(value.completedResources) &&
    isFiniteNonNegativeNumber(value.downloadedBytes) &&
    isSafeNonNegativeInteger(value.warningCount) &&
    isFiniteNonNegativeNumber(value.elapsedMs) &&
    isBoundedString(value.message, maxMessageLength)
  );
}

export function isNativeMirrorResult(value: unknown): value is NativeMirrorResult {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'type',
      'requestId',
      'protocolVersion',
      'jobId',
      'success',
      'result',
      'error',
    ]) ||
    value.type !== 'mirror_result' ||
    !isBoundedString(value.requestId, maxRequestIdLength) ||
    value.protocolVersion !== nativeMessagingProtocolVersion ||
    !isBoundedString(value.jobId, maxJobIdLength) ||
    typeof value.success !== 'boolean'
  ) {
    return false;
  }

  if (value.success) {
    return isNativeMirrorResultSummary(value.result) && value.error === null;
  }

  return value.result === null && isNativeHostErrorDetail(value.error);
}

export function isNativeMirrorCancelResult(value: unknown): value is NativeMirrorCancelResult {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['type', 'requestId', 'protocolVersion', 'jobId', 'accepted', 'error']) ||
    value.type !== 'mirror_cancel_result' ||
    !isBoundedString(value.requestId, maxRequestIdLength) ||
    value.protocolVersion !== nativeMessagingProtocolVersion ||
    !isBoundedString(value.jobId, maxJobIdLength) ||
    typeof value.accepted !== 'boolean'
  ) {
    return false;
  }

  return value.accepted ? value.error === null : isNativeHostErrorDetail(value.error);
}

export function isNativeResourceBodyResult(value: unknown): value is NativeResourceBodyResult {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'type',
      'requestId',
      'protocolVersion',
      'jobId',
      'bodyId',
      'stage',
      'accepted',
      'nextOffset',
      'complete',
      'error',
    ]) ||
    value.type !== 'resource_body_result' ||
    !isBoundedString(value.requestId, maxRequestIdLength) ||
    value.protocolVersion !== nativeMessagingProtocolVersion ||
    !isBoundedString(value.jobId, maxJobIdLength) ||
    !isBoundedString(value.bodyId, maxBodyIdLength) ||
    !nativeResourceBodyStages.includes(value.stage as NativeResourceBodyStage) ||
    typeof value.accepted !== 'boolean' ||
    !isSafeNonNegativeInteger(value.nextOffset) ||
    typeof value.complete !== 'boolean'
  ) {
    return false;
  }

  if (value.accepted) {
    return value.error === null && value.complete === (value.stage === 'end');
  }

  return value.complete === false && isNativeHostErrorDetail(value.error);
}

export function isNativeJobActionResult(value: unknown): value is NativeJobActionResult {
  if (
    !isRecord(value) ||
    value.type !== 'job_action_result' ||
    !isBoundedString(value.requestId, maxRequestIdLength) ||
    value.protocolVersion !== nativeMessagingProtocolVersion ||
    !isBoundedString(value.jobId, maxJobIdLength) ||
    !nativeJobActions.includes(value.action as NativeJobAction) ||
    typeof value.success !== 'boolean'
  ) {
    return false;
  }

  if (value.success) {
    return (
      hasOnlyKeys(value, [
        'type',
        'requestId',
        'protocolVersion',
        'jobId',
        'action',
        'success',
        'path',
        'url',
        'result',
        'error',
      ]) &&
      isOptionalNonEmptyBoundedString(value.path, maxPathLength) &&
      (value.url === undefined || isLoopbackHttpUrl(value.url)) &&
      (value.result === undefined || isNativeMirrorResultSummary(value.result)) &&
      value.error === null
    );
  }

  return (
    hasOnlyKeys(value, [
      'type',
      'requestId',
      'protocolVersion',
      'jobId',
      'action',
      'success',
      'error',
    ]) && isNativeHostErrorDetail(value.error)
  );
}

export function isNativeHostResponse(value: unknown): value is NativeHostResponse {
  return (
    isNativeHandshakeResult(value) ||
    isNativeHostErrorResponse(value) ||
    isNativeMirrorProgressEvent(value) ||
    isNativeMirrorResult(value) ||
    isNativeMirrorCancelResult(value) ||
    isNativeResourceBodyResult(value) ||
    isNativeJobActionResult(value)
  );
}
