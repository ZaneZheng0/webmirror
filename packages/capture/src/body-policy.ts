import { isKnownNonessentialExternalUrl, isSensitiveQueryName } from '@webmirror/shared';

import type { CapturedResource, CapturedResponseBodyReuseScope } from './types.js';

const sameOriginBodyResourceTypes = new Set([
  'Document',
  'Font',
  'Image',
  'Manifest',
  'Media',
  'Other',
  'Script',
  'Stylesheet',
  'TextTrack',
]);

const publicCrossOriginBodyResourceTypes = new Set([
  'Font',
  'Image',
  'Manifest',
  'Media',
  'Other',
  'Script',
  'Stylesheet',
  'TextTrack',
]);

const staticFetchExtensions = new Set([
  '.aac',
  '.avif',
  '.basis',
  '.bin',
  '.bmp',
  '.cjs',
  '.css',
  '.dds',
  '.drc',
  '.eot',
  '.exr',
  '.frag',
  '.flac',
  '.gif',
  '.glb',
  '.gltf',
  '.glsl',
  '.hdr',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.ktx',
  '.ktx2',
  '.m4a',
  '.m4v',
  '.map',
  '.mjs',
  '.mp3',
  '.mp4',
  '.ogg',
  '.otf',
  '.png',
  '.riv',
  '.srt',
  '.svg',
  '.ttf',
  '.txt',
  '.vert',
  '.vtt',
  '.wav',
  '.webm',
  '.webmanifest',
  '.webp',
  '.wasm',
  '.wgsl',
  '.woff',
  '.woff2',
  '.xml',
]);

const staticFetchMimeTypes = new Set([
  'application/javascript',
  'application/json',
  'application/octet-stream',
  'application/wasm',
  'model/gltf-binary',
  'model/gltf+json',
  'text/css',
  'text/javascript',
]);

const apiPathSegments = new Set(['api', 'auth', 'graphql', 'session', 'token']);
const incompleteStaticResourceTypes = new Set([
  'Fetch',
  'Font',
  'Image',
  'Manifest',
  'Media',
  'Other',
  'Script',
  'Stylesheet',
  'TextTrack',
  'XHR',
]);
const scriptExtensions = new Set(['.cjs', '.js', '.mjs']);
const styleExtensions = new Set(['.css']);
const fontExtensions = new Set(['.eot', '.otf', '.ttf', '.woff', '.woff2']);
const imageExtensions = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
]);
const mediaExtensions = new Set([
  '.aac',
  '.flac',
  '.m4a',
  '.m4v',
  '.mp3',
  '.mp4',
  '.ogg',
  '.wav',
  '.webm',
]);
const textTrackExtensions = new Set(['.srt', '.vtt']);

function responseHeader(resource: CapturedResource, name: string): string | undefined {
  const target = name.toLowerCase();
  const entry = Object.entries(resource.response?.headers ?? {}).find(
    ([headerName]) => headerName.toLowerCase() === target,
  );
  return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

function declaredResponseBodyLength(resource: CapturedResource): number | undefined {
  const value = responseHeader(resource, 'content-length');

  if (value === undefined || !/^\d+$/u.test(value.trim())) {
    return undefined;
  }

  const length = Number(value.trim());
  return Number.isSafeInteger(length) ? length : undefined;
}

export function capturedResponseBodyIntegrityError(
  resource: CapturedResource,
  byteLength: number,
): string | undefined {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    return 'Captured response body length is invalid.';
  }

  if (byteLength > 0) {
    return undefined;
  }

  const responseStatus = resource.response?.status;

  if (responseStatus === 204 || responseStatus === 205 || responseStatus === 304) {
    return undefined;
  }

  const declaredLength = declaredResponseBodyLength(resource);

  if (declaredLength !== undefined && declaredLength > 0) {
    return `Captured response body is empty despite Content-Length ${declaredLength}.`;
  }

  if (resource.encodedDataLength !== undefined && resource.encodedDataLength > 0) {
    return `Captured response body is empty after ${resource.encodedDataLength} encoded response bytes were observed.`;
  }

  return undefined;
}

function hasPrivateCacheDirective(value: string | undefined): boolean {
  return (
    value
      ?.toLowerCase()
      .split(/[,\r\n]+/u)
      .some((directive) => {
        const name = directive.trim().split('=', 1)[0];
        return name === 'private' || name === 'no-store';
      }) ?? false
  );
}

function variesByCredential(value: string | undefined): boolean {
  return (
    value
      ?.toLowerCase()
      .split(/[,\r\n]+/u)
      .some((header) => {
        const normalized = header.trim();
        return normalized === '*' || normalized === 'cookie' || normalized === 'authorization';
      }) ?? false
  );
}

function hasPublicCaching(value: string | undefined): boolean {
  return (
    value
      ?.toLowerCase()
      .split(/[,\r\n]+/u)
      .some((directive) => {
        const name = directive.trim().split('=', 1)[0];
        return (
          name === 'public' || name === 'immutable' || name === 'max-age' || name === 's-maxage'
        );
      }) ?? false
  );
}

function allowsCredentialFreeCors(resource: CapturedResource, sourceOrigin: string): boolean {
  const allowedOrigin = responseHeader(resource, 'access-control-allow-origin')?.trim();
  const allowCredentials = responseHeader(resource, 'access-control-allow-credentials')
    ?.trim()
    .toLowerCase();

  if (!allowedOrigin || allowCredentials === 'true') {
    return false;
  }

  if (allowedOrigin === '*') {
    return true;
  }

  try {
    return new URL(allowedOrigin).origin === sourceOrigin;
  } catch {
    return false;
  }
}

function hasCompletePrivacyEvidence(resource: CapturedResource, responseStatus: number): boolean {
  const privacy = resource.privacy;

  return (
    privacy?.requestExtraInfoReceived === true &&
    privacy.responseExtraInfoReceived === true &&
    privacy.responseStatusCode === responseStatus
  );
}

function hasUnsafePrivacyEvidence(resource: CapturedResource, responseStatus: number): boolean {
  const privacy = resource.privacy;

  return (
    resource.response?.hasSetCookie === true ||
    hasPrivateCacheDirective(responseHeader(resource, 'cache-control')) ||
    variesByCredential(responseHeader(resource, 'vary')) ||
    privacy?.requestHasCookie === true ||
    privacy?.requestHasAuthorization === true ||
    privacy?.responseHasSetCookie === true ||
    privacy?.responsePrivateOrNoStore === true ||
    privacy?.responseVariesByCredential === true ||
    privacy?.responseCookiePolicyAffected === true ||
    privacy?.ambiguousRedirect === true ||
    (privacy?.responseExtraInfoReceived === true && privacy.responseStatusCode !== responseStatus)
  );
}

function isStaticFetchResource(resource: CapturedResource, url: URL): boolean {
  const path = url.pathname.toLowerCase();
  const extension = path.slice(path.lastIndexOf('.'));
  const contentType = (
    (responseHeader(resource, 'content-type') ?? resource.response?.mimeType ?? '').split(
      ';',
      1,
    )[0] ?? ''
  )
    .trim()
    .toLowerCase();
  const pathSegments = path.split('/').filter(Boolean);

  return (
    !pathSegments.some((segment) => apiPathSegments.has(segment)) &&
    hasPublicCaching(responseHeader(resource, 'cache-control')) &&
    (staticFetchExtensions.has(extension) ||
      staticFetchMimeTypes.has(contentType) ||
      contentType.startsWith('font/') ||
      contentType.startsWith('image/') ||
      contentType.startsWith('audio/') ||
      contentType.startsWith('video/'))
  );
}

function isLongLivedResource(resourceType: string | undefined): boolean {
  return resourceType === 'WebSocket' || resourceType === 'EventSource' || resourceType === 'Ping';
}

function hasStaticAssetExtension(url: URL): boolean {
  const fileName = url.pathname.split('/').at(-1)?.toLowerCase() ?? '';
  const extensionIndex = fileName.lastIndexOf('.');
  return extensionIndex > 0 && staticFetchExtensions.has(fileName.slice(extensionIndex));
}

export function historicalStaticResourceType(value: string): string | undefined {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  const pathSegments = decodedPathSegments(url);

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    isKnownNonessentialExternalUrl(url.href) ||
    [...url.searchParams.keys()].some(isSensitiveQueryName) ||
    pathSegments.some((segment) => apiPathSegments.has(segment)) ||
    !hasStaticAssetExtension(url)
  ) {
    return undefined;
  }

  const fileName = url.pathname.split('/').at(-1)?.toLowerCase() ?? '';
  const extensionIndex = fileName.lastIndexOf('.');
  const extension = extensionIndex > 0 ? fileName.slice(extensionIndex) : '';

  if (scriptExtensions.has(extension)) {
    return 'Script';
  }

  if (styleExtensions.has(extension)) {
    return 'Stylesheet';
  }

  if (fontExtensions.has(extension)) {
    return 'Font';
  }

  if (imageExtensions.has(extension)) {
    return 'Image';
  }

  if (mediaExtensions.has(extension)) {
    return 'Media';
  }

  if (textTrackExtensions.has(extension)) {
    return 'TextTrack';
  }

  if (extension === '.webmanifest') {
    return 'Manifest';
  }

  return 'Fetch';
}

export function isHistoricalStaticGetCandidate(resource: CapturedResource): boolean {
  return (
    resource.state === 'discovered' &&
    resource.request.method.toUpperCase() === 'GET' &&
    resource.request.initiatorType === 'performance' &&
    Object.keys(resource.request.headers).length === 0 &&
    resource.redirectIndex === 0 &&
    historicalStaticResourceType(resource.request.url) === resource.request.resourceType
  );
}

function decodedPathSegments(url: URL): string[] {
  return url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment).toLowerCase();
      } catch {
        return segment.toLowerCase();
      }
    });
}

function hasUnsafeIncompleteResourceEvidence(resource: CapturedResource): boolean {
  const privacy = resource.privacy;

  return (
    privacy?.requestExtraInfoReceived !== true ||
    privacy?.requestHasAuthorization === true ||
    privacy?.responseHasSetCookie === true ||
    privacy?.responsePrivateOrNoStore === true ||
    privacy?.responseVariesByCredential === true ||
    privacy?.responseCookiePolicyAffected === true ||
    privacy?.ambiguousRedirect === true
  );
}

export function isIncompleteStaticGetCandidate(
  resource: CapturedResource,
  sourceOrigin: string,
): boolean {
  if (resource.state !== 'discovered' || resource.request.method.toUpperCase() !== 'GET') {
    return false;
  }

  const rawUrl = resource.response?.url ?? resource.request.url;
  let url: URL;
  let source: URL;

  try {
    url = new URL(rawUrl);
    source = new URL(sourceOrigin);
  } catch {
    return false;
  }

  const resourceType = resource.request.resourceType;
  const observedStatus = resource.response?.status ?? resource.privacy?.responseStatusCode;
  const pathSegments = decodedPathSegments(url);

  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    !url.username &&
    !url.password &&
    url.origin === source.origin &&
    resource.redirectIndex === 0 &&
    !isKnownNonessentialExternalUrl(url.href) &&
    !isLongLivedResource(resourceType) &&
    ![...url.searchParams.keys()].some(isSensitiveQueryName) &&
    !pathSegments.some((segment) => apiPathSegments.has(segment)) &&
    !hasUnsafeIncompleteResourceEvidence(resource) &&
    (observedStatus === undefined || (observedStatus >= 200 && observedStatus < 300)) &&
    incompleteStaticResourceTypes.has(resourceType ?? '') &&
    hasStaticAssetExtension(url)
  );
}

export function capturedResponseBodyReuseScope(
  resource: CapturedResource,
  sourceOrigin: string,
): CapturedResponseBodyReuseScope | undefined {
  const responseStatus = resource.response?.status;
  const rawUrl = resource.response?.url ?? resource.request.url;
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }

  const resourceType = resource.request.resourceType;
  const sameOriginType = sameOriginBodyResourceTypes.has(resourceType ?? '');
  const publicCrossOriginType =
    publicCrossOriginBodyResourceTypes.has(resourceType ?? '') ||
    (resourceType === 'Fetch' && isStaticFetchResource(resource, url));

  if (
    resource.request.method.toUpperCase() !== 'GET' ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    isKnownNonessentialExternalUrl(url.href) ||
    isLongLivedResource(resourceType) ||
    responseStatus === undefined ||
    responseStatus < 200 ||
    responseStatus > 203
  ) {
    return undefined;
  }

  if (url.origin === sourceOrigin) {
    return sameOriginType ? 'same_origin' : undefined;
  }

  const completePrivacyEvidence = hasCompletePrivacyEvidence(resource, responseStatus);
  const explicitPublicCors =
    hasPublicCaching(responseHeader(resource, 'cache-control')) &&
    allowsCredentialFreeCors(resource, sourceOrigin);

  if (
    !publicCrossOriginType ||
    resource.redirectIndex !== 0 ||
    url.protocol !== 'https:' ||
    [...url.searchParams.keys()].some(isSensitiveQueryName) ||
    resource.response?.fromDiskCache === true ||
    resource.response?.fromPrefetchCache === true ||
    resource.response?.fromServiceWorker === true ||
    (!completePrivacyEvidence && !explicitPublicCors) ||
    hasUnsafePrivacyEvidence(resource, responseStatus)
  ) {
    return undefined;
  }

  return 'public_cross_origin';
}
