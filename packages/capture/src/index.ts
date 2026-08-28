export { sanitizeHeaders } from './headers.js';
export {
  capturedResponseBodyIntegrityError,
  capturedResponseBodyReuseScope,
  historicalStaticResourceType,
  isHistoricalStaticGetCandidate,
  isIncompleteStaticGetCandidate,
} from './body-policy.js';
export { CaptureRecorder } from './recorder.js';
export type {
  CapturedResource,
  CapturePrivacyEvidence,
  CaptureManifest,
  CapturePreflight,
  CaptureRequestDetails,
  CaptureResourceState,
  CaptureResponseDetails,
  CapturedResponseBodyDescriptor,
  CapturedResponseBodyReuseScope,
  CapturedResponseBodySource,
  HeaderMap,
  LoadingFailedEvent,
  LoadingFinishedEvent,
  RequestWillBeSentEvent,
  RequestWillBeSentExtraInfoEvent,
  ResponseReceivedEvent,
  ResponseReceivedExtraInfoEvent,
} from './types.js';

export interface CaptureTarget {
  tabId: number;
  title: string;
  url: string;
}
