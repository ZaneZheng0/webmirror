import type { RuntimeCapabilities } from '@webmirror/shared';

import type { CacheResponseMetadata } from './cache.js';

export const mirrorManifestVersion = 1 as const;

export interface CapturedBodyFile {
  filePath: string;
  byteLength: number;
  sha256: string;
  contentType?: string;
  httpStatus?: number;
}

export interface CaptureResourceInput {
  sourceUrl: string;
  method?: string;
  contentType?: string;
  expectedSize?: number;
  resourceType?: string;
  initiatorType?: string;
  workerContext?: boolean;
  capturedBody?: CapturedBodyFile;
}

export interface PlannedMirrorResource extends CaptureResourceInput {
  canonicalUrl: string;
  localPath: string;
}

export interface MirrorCaptureInput {
  sourceUrl: string;
  title?: string;
  capturedAt?: string;
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
  resources: readonly CaptureResourceInput[];
  warnings?: readonly string[];
}

export type MirrorResourceStatus = 'pending' | 'downloaded' | 'failed' | 'skipped' | 'cancelled';
export type MirrorStatus = 'complete' | 'partial' | 'failed' | 'cancelled';

export interface MirrorResourceManifest {
  sourceUrl: string;
  canonicalUrl: string;
  status: MirrorResourceStatus;
  localPath?: string;
  finalUrl?: string;
  contentType?: string;
  resourceType?: string;
  httpStatus?: number;
  size?: number;
  sha256?: string;
  attempts?: number;
  bodySource?: 'browser' | 'network' | 'network_verified' | 'cache' | 'cache_revalidated';
  workerContext?: boolean;
  credentialsRedacted?: boolean;
  securityIssue?: 'sensitive_content';
  retryable?: boolean;
  rewritten?: boolean;
  error?: string;
}

export interface MirrorManifest {
  schemaVersion: typeof mirrorManifestVersion;
  source: {
    url: string;
    origin: string;
    capturedAt: string;
    title?: string;
  };
  createdAt: string;
  status: MirrorStatus;
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
  summary: {
    totalResources: number;
    downloadedResources: number;
    failedResources: number;
    skippedResources: number;
    cancelledResources: number;
    totalBytes: number;
  };
  timings: {
    totalMs: number;
    downloadMs: number;
    localizationMs: number;
  };
  resources: MirrorResourceManifest[];
  onlineDependencies: string[];
  warnings: string[];
}

export interface MirrorProgress {
  phase: 'downloading' | 'localizing';
  totalResources: number;
  completedResources: number;
  downloadedResources: number;
  failedResources: number;
  skippedResources: number;
  cancelledResources: number;
  downloadedBytes: number;
  localizedResources: number;
  totalTextResources: number;
  currentUrl?: string;
}

export interface DownloadResourceOptions {
  rootDirectory: string;
  localPath: string;
  expectedContentType?: string;
  expectedResourceType?: string;
  expectedSize?: number;
  maxBytes?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  capturedBody?: CapturedBodyFile;
  cacheDirectory?: string;
}

export interface DownloadResourceResult {
  sourceUrl: string;
  finalUrl: string;
  localPath: string;
  contentType: string;
  httpStatus: number;
  size: number;
  sha256: string;
  attempts: number;
  bodySource: 'browser' | 'network' | 'network_verified' | 'cache' | 'cache_revalidated';
  cacheCandidate?: CacheResponseMetadata;
}

export interface CreateMirrorOptions {
  outputDirectory: string;
  concurrency?: number;
  maxResourceBytes?: number;
  maxTotalBytes?: number;
  maxDeferredMediaBytes?: number;
  maxDiscoveryRounds?: number;
  maxNavigationPages?: number;
  maxResources?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  maxRedirects?: number;
  cacheDirectory?: string;
  signal?: AbortSignal;
  now?: () => Date;
  writeManifest?: boolean;
  onProgress?: (progress: MirrorProgress) => void;
  onResourcePlanned?: (resource: PlannedMirrorResource) => void;
}

export interface PreviewServerOptions {
  rootDirectory: string;
  port?: number;
  manifest?: Pick<MirrorManifest, 'resources'>;
  fallbackPath?: string;
  routeAliases?: readonly PreviewRouteAlias[];
  unavailableRoutes?: readonly string[];
}

export interface PreviewRouteAlias {
  route: string;
  localPath: string;
}

export interface PreviewServer {
  host: '127.0.0.1';
  port: number;
  url: string;
  close: () => Promise<void>;
}
