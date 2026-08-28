import {
  capturedResponseBodyIntegrityError,
  capturedResponseBodyReuseScope,
  isHistoricalStaticGetCandidate,
  isIncompleteStaticGetCandidate,
  type CaptureManifest,
  type CapturedResource,
  type CapturedResponseBodyReuseScope,
} from '@webmirror/capture';
import {
  isKnownNonessentialExternalUrl,
  type NativeMirrorCaptureInput,
  type NativeMirrorResourceInput,
} from '@webmirror/shared';

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function canUseCapturedBody(resource: CapturedResource, sourceOrigin: string): boolean {
  if (!resource.body) {
    return false;
  }

  if (capturedResponseBodyIntegrityError(resource, resource.body.byteLength)) {
    return false;
  }

  const declaredScope: CapturedResponseBodyReuseScope = resource.body.reuseScope ?? 'same_origin';
  return capturedResponseBodyReuseScope(resource, sourceOrigin) === declaredScope;
}

function isResponseBackedDownload(resource: CapturedResource): boolean {
  const status = resource.response?.status ?? 0;
  const resourceType = resource.request.resourceType;
  const resourceUrl = resource.response?.url ?? resource.request.url;
  return (
    resource.request.method.toUpperCase() === 'GET' &&
    isHttpUrl(resourceUrl) &&
    !isKnownNonessentialExternalUrl(resourceUrl) &&
    (resource.state === 'complete' ||
      resource.state === 'response' ||
      (resource.state === 'failed' && resource.response !== undefined)) &&
    status >= 200 &&
    status < 400 &&
    resourceType !== 'WebSocket' &&
    resourceType !== 'EventSource' &&
    resourceType !== 'Ping'
  );
}

function resourceEvidenceScore(resource: NativeMirrorResourceInput): number {
  return (
    (resource.bodyId ? 4 : 0) +
    (resource.contentType ? 2 : 0) +
    (resource.expectedSize !== undefined ? 1 : 0)
  );
}

function mergeResourceEvidence(
  existing: NativeMirrorResourceInput,
  candidate: NativeMirrorResourceInput,
): NativeMirrorResourceInput {
  const preferred =
    resourceEvidenceScore(candidate) > resourceEvidenceScore(existing) ? candidate : existing;
  const alternate = preferred === existing ? candidate : existing;

  return {
    ...alternate,
    ...preferred,
    sourceUrl: preferred.sourceUrl,
    method: 'GET',
  };
}

export function toNativeCapture(manifest: CaptureManifest): NativeMirrorCaptureInput {
  const resources = new Map<string, NativeMirrorResourceInput>();
  const responseBackedUrls = new Set<string>();
  const retainedHistoricalUrls = new Set<string>();
  const retainedIncompleteUrls = new Set<string>();
  const sourceOrigin = new URL(manifest.sourceUrl).origin;
  const retainIncompleteStaticRequests = manifest.completionReason === 'maximum_duration';
  let skippedCapturedBodies = 0;

  for (const resource of manifest.resources) {
    const responseBacked = isResponseBackedDownload(resource);
    const historicalStatic = !responseBacked && isHistoricalStaticGetCandidate(resource);
    const incompleteStatic =
      !responseBacked &&
      !historicalStatic &&
      retainIncompleteStaticRequests &&
      isIncompleteStaticGetCandidate(resource, sourceOrigin);

    if (!responseBacked && !historicalStatic && !incompleteStatic) {
      continue;
    }

    const sourceUrl = resource.response?.url ?? resource.request.url;
    const contentType = resource.body?.contentType ?? resource.response?.mimeType;
    const capturedBody = canUseCapturedBody(resource, sourceOrigin) ? resource.body : undefined;

    if (resource.body && !capturedBody) {
      skippedCapturedBodies += 1;
    }

    const candidate: NativeMirrorResourceInput = {
      sourceUrl,
      method: 'GET',
      ...(contentType ? { contentType } : {}),
      ...(resource.request.resourceType ? { resourceType: resource.request.resourceType } : {}),
      ...(resource.request.initiatorType ? { initiatorType: resource.request.initiatorType } : {}),
      ...(resource.request.workerContext ? { workerContext: true } : {}),
      ...(capturedBody
        ? { expectedSize: capturedBody.byteLength, bodyId: capturedBody.id }
        : resource.encodedDataLength !== undefined
          ? { expectedSize: resource.encodedDataLength }
          : {}),
    };
    const existing = resources.get(sourceUrl);
    resources.set(sourceUrl, existing ? mergeResourceEvidence(existing, candidate) : candidate);

    if (responseBacked) {
      responseBackedUrls.add(sourceUrl);
      retainedHistoricalUrls.delete(sourceUrl);
      retainedIncompleteUrls.delete(sourceUrl);
    } else if (historicalStatic && !responseBackedUrls.has(sourceUrl)) {
      retainedHistoricalUrls.add(sourceUrl);
      retainedIncompleteUrls.delete(sourceUrl);
    } else if (!responseBackedUrls.has(sourceUrl)) {
      retainedIncompleteUrls.add(sourceUrl);
    }
  }

  if (!resources.has(manifest.sourceUrl)) {
    resources.set(manifest.sourceUrl, {
      sourceUrl: manifest.sourceUrl,
      method: 'GET',
      contentType: 'text/html',
    });
  }

  const sourceEntry = resources.get(manifest.sourceUrl);
  const orderedResources = [
    ...(sourceEntry ? [sourceEntry] : []),
    ...[...resources.entries()]
      .filter(([url]) => url !== manifest.sourceUrl)
      .map(([, resource]) => resource),
  ];

  return {
    sourceUrl: manifest.sourceUrl,
    title: manifest.title,
    capturedAt: manifest.completedAt,
    completionReason: manifest.completionReason,
    resources: orderedResources,
    warnings: [
      ...(manifest.completionReason === 'network_idle'
        ? manifest.warnings
        : [
            ...manifest.warnings,
            `Capture discovery ended with ${manifest.completionReason}; the resource list may be incomplete.`,
          ]),
      ...(retainedIncompleteUrls.size > 0
        ? [
            `Retained ${retainedIncompleteUrls.size} same-origin static GET request(s) that were still pending at the capture cutoff for anonymous Helper retrieval.`,
          ]
        : []),
      ...(retainedHistoricalUrls.size > 0
        ? [
            `Retained ${retainedHistoricalUrls.size} previously observed static resource URL(s) for anonymous Helper retrieval.`,
          ]
        : []),
      ...(skippedCapturedBodies > 0
        ? [
            `${skippedCapturedBodies} captured response body or bodies were not reused because the resource was not proven safe for local reuse.`,
          ]
        : []),
    ],
    ...(manifest.browser ? { browser: manifest.browser } : {}),
    ...(manifest.viewport ? { viewport: manifest.viewport } : {}),
    ...(manifest.runtimeCapabilities ? { runtimeCapabilities: manifest.runtimeCapabilities } : {}),
  };
}
