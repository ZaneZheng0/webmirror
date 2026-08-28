import type { RuntimeCapabilities } from '@webmirror/shared';

export const validationSchemaVersion = 2 as const;

export type ValidationStatus = 'complete' | 'partial' | 'failed';

export interface ValidationViewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

export interface ValidationPerceptualOptions {
  threshold?: number;
  maxDifferenceRatio?: number;
  partialDifferenceRatio?: number;
  includeAntialiasing?: boolean;
}

export interface ValidationPoint {
  x: number;
  y: number;
}

interface ValidationActionBase {
  id: string;
  label?: string;
  timeoutMs?: number;
  settleTimeMs?: number;
  perceptual?: ValidationPerceptualOptions;
}

export interface ValidationClickAction extends ValidationActionBase {
  type: 'click';
  selector: string;
  button?: 'left' | 'middle' | 'right';
  clickCount?: number;
}

export interface ValidationScrollAction extends ValidationActionBase {
  type: 'scroll';
  selector?: string;
  deltaX?: number;
  deltaY?: number;
}

export interface ValidationKeyAction extends ValidationActionBase {
  type: 'key';
  key: string;
  selector?: string;
}

export interface ValidationDragAction extends ValidationActionBase {
  type: 'drag';
  selector: string;
  from: ValidationPoint;
  to: ValidationPoint;
  steps?: number;
}

export type ValidationAction =
  ValidationClickAction | ValidationScrollAction | ValidationKeyAction | ValidationDragAction;

export interface RunValidationOptions {
  entryUrl: string;
  outputDirectory: string;
  sourceUrl?: string;
  browser?: {
    name: string;
    version: string;
  };
  runtimeCapabilities?: RuntimeCapabilities;
  allowedRemoteOrigins?: readonly string[];
  timeoutMs?: number;
  settleTimeMs?: number;
  canvasSettleTimeoutMs?: number;
  viewport?: ValidationViewport;
  actions?: readonly ValidationAction[];
  actionTimeoutMs?: number;
  actionSettleTimeMs?: number;
  visualReferences?: Readonly<Record<string, Uint8Array>>;
  perceptual?: ValidationPerceptualOptions;
  signal?: AbortSignal;
}

export interface ValidationEntryResult {
  requestedUrl: string;
  ok: boolean;
  finalUrl?: string;
  httpStatus?: number;
  contentType?: string;
  error?: string;
}

export interface ValidationHttpFailure {
  kind: 'http-error' | 'request-failed';
  url: string;
  method: string;
  resourceType: string;
  local: boolean;
  status?: number;
  statusText?: string;
  errorText?: string;
}

export interface ValidationConsoleError {
  text: string;
  blocking: boolean;
  recoverableCandidate?: boolean;
  location?: {
    url?: string;
    lineNumber: number;
    columnNumber: number;
  };
}

export interface ValidationPageError {
  message: string;
  stack?: string;
  recoverableCandidate?: boolean;
}

export interface ValidationRemoteDependency {
  url: string;
  origin: string;
  reason: 'source-origin' | 'unexpected-remote';
  resourceType: string;
  method?: string;
  allowed: boolean;
  blocked: boolean;
}

export type ValidationDiagnosticCategory =
  'httpFailures' | 'consoleErrors' | 'pageErrors' | 'remoteDependencies';

export interface ValidationDiagnosticCategoryResult {
  recorded: number;
  dropped: number;
  droppedBlocking: number;
  eventLimit: number;
}

export interface ValidationDiagnosticsResult {
  passed: boolean;
  truncated: boolean;
  estimatedRecordedEventBytes: number;
  eventByteBudget: number;
  droppedEvents: number;
  categories: Record<ValidationDiagnosticCategory, ValidationDiagnosticCategoryResult>;
}

export type ValidationCanvasContext =
  '2d' | 'webgl' | 'webgl2' | 'bitmaprenderer' | 'none' | 'unknown';

export type ValidationCanvasOutcome = 'non-empty' | 'empty' | 'unreadable' | 'skipped';

export interface ValidationCanvasDetail {
  frameUrl: string;
  index: number;
  width: number;
  height: number;
  cssWidth: number;
  cssHeight: number;
  context: ValidationCanvasContext;
  outcome: ValidationCanvasOutcome;
  sampledPixels: number;
  error?: string;
}

export interface ValidationCanvasResult {
  checked: boolean;
  present: boolean;
  passed: boolean;
  truncated: boolean;
  omitted: number;
  inspected: number;
  nonEmpty: number;
  empty: number;
  unreadable: number;
  details: ValidationCanvasDetail[];
}

export interface ValidationScreenshotResult {
  passed: boolean;
  path?: string;
  maskedSensitiveControls?: boolean;
  error?: string;
}

export interface ValidationPerceptualSettings {
  threshold: number;
  maxDifferenceRatio: number;
  partialDifferenceRatio: number;
  includeAntialiasing: boolean;
}

export type ValidationPerceptualOutcome =
  'not-compared' | 'match' | 'partial' | 'mismatch' | 'error';

export interface ValidationPerceptualComparison {
  outcome: ValidationPerceptualOutcome;
  actualPath: string;
  referencePath?: string;
  diffPath?: string;
  actualWidth?: number;
  actualHeight?: number;
  referenceWidth?: number;
  referenceHeight?: number;
  differingPixels?: number;
  totalPixels?: number;
  differenceRatio?: number;
  similarity?: number;
  settings?: ValidationPerceptualSettings;
  reason?: string;
}

export interface ValidationCheckpointResult {
  id: string;
  label: string;
  actionId?: string;
  screenshot: ValidationScreenshotResult;
  comparison: ValidationPerceptualComparison;
}

export type ValidationActionStatus = 'passed' | 'failed' | 'skipped';

export interface ValidationActionResult {
  id: string;
  label: string;
  type: ValidationAction['type'];
  status: ValidationActionStatus;
  durationMs: number;
  checkpointId?: string;
  error?: string;
  httpFailures: ValidationHttpFailure[];
  pageErrors: ValidationPageError[];
  consoleErrors: ValidationConsoleError[];
  remoteDependencies: ValidationRemoteDependency[];
}

export interface ValidationInteractionResult {
  checked: boolean;
  passed: boolean;
  attempted: number;
  completed: number;
  failed: number;
  skipped: number;
  actions: ValidationActionResult[];
  errors: string[];
}

export interface ValidationPerceptualResult {
  checked: boolean;
  passed: boolean;
  compared: number;
  matched: number;
  partial: number;
  mismatched: number;
  errors: number;
  checkpoints: ValidationCheckpointResult[];
}

export interface ValidationResult {
  schemaVersion: typeof validationSchemaVersion;
  status: ValidationStatus;
  score: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  sourceUrl?: string;
  entry: ValidationEntryResult;
  checks: {
    http: {
      passed: boolean;
      failures: ValidationHttpFailure[];
      local404s: ValidationHttpFailure[];
    };
    runtime: {
      passed: boolean;
      pageErrors: ValidationPageError[];
      consoleErrors: ValidationConsoleError[];
      blockingConsoleErrors: ValidationConsoleError[];
    };
    remoteDependencies: {
      passed: boolean;
      dependencies: ValidationRemoteDependency[];
    };
    diagnostics?: ValidationDiagnosticsResult;
    screenshot: ValidationScreenshotResult;
    canvas: ValidationCanvasResult;
    interactions: ValidationInteractionResult;
    perceptual: ValidationPerceptualResult;
  };
  errors: string[];
  warnings: string[];
  artifacts: {
    validationJson: 'validation.json';
    reportHtml: 'report.html';
    screenshot?: string;
    interactionScreenshots?: string[];
    referenceScreenshots?: string[];
    perceptualDiffs?: string[];
  };
}
