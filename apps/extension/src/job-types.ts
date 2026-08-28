import type {
  JobState,
  NativeJobAction,
  NativeJobActionResult,
  NativeMirrorResultSummary,
} from '@webmirror/shared';

export interface ExtensionJobRecord {
  schemaVersion: 1;
  jobId: string;
  tabId: number;
  sourceUrl: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  state: JobState;
  message: string;
  discoveredResources: number;
  completedResources: number;
  downloadedBytes: number;
  warningCount: number;
  elapsedMs: number;
  result?: NativeMirrorResultSummary;
  error?: string;
}

export interface JobStartMessage {
  type: 'webmirror.job.start';
  tabId: number;
}

export interface JobGetMessage {
  type: 'webmirror.job.get';
  jobId?: string;
}

export interface JobCancelMessage {
  type: 'webmirror.job.cancel';
  jobId: string;
}

export interface JobActionMessage {
  type: 'webmirror.job.action';
  jobId: string;
  action: NativeJobAction;
}

export interface JobStartResponse {
  ok: boolean;
  jobId?: string;
  error?: string;
}

export interface JobGetResponse {
  ok: boolean;
  job?: ExtensionJobRecord;
  error?: string;
}

export interface JobActionResponse {
  ok: boolean;
  result?: NativeJobActionResult;
  error?: string;
}

export interface JobUpdatedMessage {
  type: 'webmirror.job.updated';
  job: ExtensionJobRecord;
}
