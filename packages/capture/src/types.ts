import type { RuntimeCapabilities } from '@webmirror/shared';

export type HeaderMap = Readonly<Record<string, string>>;

export type CaptureResourceState = 'discovered' | 'response' | 'complete' | 'failed';

export type CapturedResponseBodyReuseScope = 'same_origin' | 'public_cross_origin';

export interface CaptureRequestDetails {
  url: string;
  method: string;
  headers: HeaderMap;
  resourceType?: string;
  frameId?: string;
  loaderId?: string;
  initiatorType?: string;
  workerContext?: boolean;
}

export interface CapturePrivacyEvidence {
  requestExtraInfoReceived: boolean;
  responseExtraInfoReceived: boolean;
  requestHasCookie: boolean;
  requestHasAuthorization: boolean;
  responseHasSetCookie: boolean;
  responsePrivateOrNoStore: boolean;
  responseVariesByCredential: boolean;
  responseCookiePolicyAffected: boolean;
  responseStatusCode?: number;
  ambiguousRedirect: boolean;
}

export interface CaptureResponseDetails {
  url: string;
  status: number;
  statusText: string;
  mimeType: string;
  protocol: string;
  headers: HeaderMap;
  hasSetCookie: boolean;
  fromDiskCache: boolean;
  fromPrefetchCache: boolean;
  fromServiceWorker: boolean;
}

export type CapturedResponseBodySource = 'network' | 'cache_storage';

export interface CapturedResponseBodyDescriptor {
  id: string;
  byteLength: number;
  sha256: string;
  source: CapturedResponseBodySource;
  reuseScope: CapturedResponseBodyReuseScope;
  contentType: string;
  httpStatus: number;
}

export interface CapturedResource {
  id: string;
  sessionId?: string;
  requestId: string;
  redirectIndex: number;
  state: CaptureResourceState;
  request: CaptureRequestDetails;
  response?: CaptureResponseDetails;
  privacy?: CapturePrivacyEvidence;
  encodedDataLength?: number;
  body?: CapturedResponseBodyDescriptor;
  failureReason?: string;
  blockedReason?: string;
  canceled?: boolean;
}

export interface CapturePreflight {
  origin: string;
  canvasElements: number;
  iframeElements: number;
  mediaElements: number;
  serviceWorkerControlled: boolean;
  observedResourceCount: number;
  observedTransferBytes: number;
  workerResourceHints: number;
  webglResourceHints: number;
  wasmResourceHints: number;
}

export interface CaptureManifest {
  schemaVersion: 1;
  jobId: string;
  tabId: number;
  sourceUrl: string;
  title: string;
  startedAt: string;
  completedAt: string;
  completionReason: 'network_idle' | 'maximum_duration' | 'detached' | 'cancelled' | 'failed';
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
  resources: CapturedResource[];
  warnings: string[];
}

export interface RequestWillBeSentEvent {
  requestId: string;
  loaderId?: string;
  frameId?: string;
  type?: string;
  request: {
    url: string;
    method: string;
    headers?: Record<string, unknown>;
  };
  initiator?: {
    type?: string;
  };
  redirectResponse?: ResponsePayload;
}

export interface ResponseReceivedEvent {
  requestId: string;
  type?: string;
  response: ResponsePayload;
}

export interface LoadingFinishedEvent {
  requestId: string;
  encodedDataLength?: number;
}

export interface LoadingFailedEvent {
  requestId: string;
  errorText?: string;
  blockedReason?: string;
  canceled?: boolean;
}

export interface RequestWillBeSentExtraInfoEvent {
  requestId: string;
  headers?: Record<string, unknown>;
  associatedCookies?: readonly {
    blockedReasons?: readonly string[];
  }[];
}

export interface ResponseReceivedExtraInfoEvent {
  requestId: string;
  headers?: Record<string, unknown>;
  statusCode?: number;
  blockedCookies?: readonly unknown[];
  exemptedCookies?: readonly unknown[];
}

export interface ResponsePayload {
  url?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  protocol?: string;
  headers?: Record<string, unknown>;
  fromDiskCache?: boolean;
  fromPrefetchCache?: boolean;
  fromServiceWorker?: boolean;
}
