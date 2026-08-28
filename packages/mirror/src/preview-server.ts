import { createReadStream } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, posix, relative, resolve, sep } from 'node:path';

import { contentTypeForPath } from './mime.js';
import type {
  MirrorManifest,
  PreviewRouteAlias,
  PreviewServer,
  PreviewServerOptions,
} from './types.js';
import { resolvePathInsideRoot } from './url-mapper.js';

interface ByteRange {
  start: number;
  end: number;
}

interface ParsedRequestTarget {
  localPath: string;
  route: string;
}

const nonDocumentExtensions = new Set([
  '.3ds',
  '.aac',
  '.avif',
  '.basis',
  '.bin',
  '.bmp',
  '.cjs',
  '.css',
  '.csv',
  '.dae',
  '.dds',
  '.drc',
  '.eot',
  '.exr',
  '.fbx',
  '.flac',
  '.frag',
  '.gif',
  '.glb',
  '.gltf',
  '.glsl',
  '.gz',
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
  '.mov',
  '.mp3',
  '.mp4',
  '.oga',
  '.ogg',
  '.ogv',
  '.opus',
  '.otf',
  '.png',
  '.pvr',
  '.riv',
  '.srt',
  '.svg',
  '.ttf',
  '.txt',
  '.vert',
  '.vtt',
  '.wasm',
  '.wav',
  '.webm',
  '.webmanifest',
  '.webp',
  '.woff',
  '.woff2',
  '.xml',
  '.zip',
]);

const contentSecurityPolicy = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'self' 'unsafe-inline' data: blob:",
  "img-src 'self' data: blob: about:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "frame-src 'self' data: blob:",
  "object-src 'self' data: blob:",
  "form-action 'self'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ');
const runtimeNoopRoute = '/.webmirror/noop';
const runtimeNoopScriptRoute = '/.webmirror/noop.js';
const runtimeNoopStyleRoute = '/.webmirror/noop.css';
const runtimeUnavailableScriptRoute = '/.webmirror/unavailable.js';
const unavailableImageExtensions = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.webp',
]);
const transparentPixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X7xLAAAAAElFTkSuQmCC',
  'base64',
);
const neutralSubRipTrack = '1\n00:00:00,000 --> 00:00:00,001\n \n';
const neutralWebVttTrack = 'WEBVTT\n\n';
const offlineEmptyDataContract = JSON.stringify({
  available: false,
  collections: [],
  config: { enabled: false },
  configuration: { enabled: false },
  consent: { enabled: false },
  count: 0,
  data: {
    available: false,
    config: { enabled: false },
    configuration: { enabled: false },
    consent: { enabled: false },
    count: 0,
    data: {
      available: false,
      config: { enabled: false },
      configuration: { enabled: false },
      consent: { enabled: false },
      count: 0,
      enabled: false,
      entries: [],
      items: [],
      length: 0,
      list: [],
      metadata: {},
      recaptcha: { enabled: false, enforce: false, siteKeyId: '' },
      results: [],
      sessionTrackingConsent: { enabled: false },
      settings: { enabled: false },
      success: false,
      url: '',
    },
    enabled: false,
    entries: [],
    items: [],
    length: 0,
    list: [],
    metadata: {},
    recaptcha: { enabled: false, enforce: false, siteKeyId: '' },
    results: [],
    sessionTrackingConsent: { enabled: false },
    settings: { enabled: false },
    success: false,
    url: '',
  },
  enabled: false,
  entries: [],
  errors: [],
  item_count: 0,
  items: [],
  length: 0,
  list: [],
  meta: {},
  metadata: {},
  ok: false,
  products: [],
  recommendations: [],
  recaptcha: { enabled: false, enforce: false, siteKeyId: '' },
  results: [],
  sections: {},
  sessionTrackingConsent: { enabled: false },
  settings: { enabled: false },
  success: false,
  total: 0,
  total_count: 0,
  total_price: 0,
  url: '',
});

function securityHeaders(): Record<string, string> {
  return {
    'content-security-policy': contentSecurityPolicy,
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy':
      'accelerometer=(self), camera=(), geolocation=(), microphone=(), payment=(), serial=(), usb=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
  };
}

function isDocumentContentType(contentType: string): boolean {
  const essence = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return essence === 'text/html' || essence === 'application/xhtml+xml';
}

function resourceSecurityHeaders(contentType: string): Record<string, string> {
  const headers = securityHeaders();

  if (!isDocumentContentType(contentType)) {
    // Sandboxed frames have an opaque `null` origin. Their scripts, modules,
    // styles, fonts, images, WASM, and other immutable mirror assets still
    // need to load from the loopback preview. Keep documents same-origin-only,
    // but make non-document responses explicitly reusable by those frames.
    headers['access-control-allow-origin'] = '*';
    headers['cross-origin-resource-policy'] = 'cross-origin';
  }

  return headers;
}

function sendText(response: ServerResponse, statusCode: number, message: string): void {
  response.writeHead(statusCode, {
    ...securityHeaders(),
    'content-length': Buffer.byteLength(message),
    'content-type': 'text/plain; charset=utf-8',
  });
  response.end(message);
}

function sendRuntimeNoop(response: ServerResponse, contentType: string, body = ''): void {
  response.writeHead(200, {
    ...resourceSecurityHeaders(contentType),
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': contentType,
  });
  response.end(body);
}

function sendRuntimeNoopBytes(response: ServerResponse, contentType: string, body: Buffer): void {
  response.writeHead(200, {
    ...resourceSecurityHeaders(contentType),
    'cache-control': 'no-store',
    'content-length': body.byteLength,
    'content-type': contentType,
  });
  response.end(body);
}

function sendOfflineEmptyData(response: ServerResponse): void {
  response.writeHead(200, {
    ...resourceSecurityHeaders('application/json; charset=utf-8'),
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(offlineEmptyDataContract),
    'content-type': 'application/json; charset=utf-8',
    'x-webmirror-unavailable': '1',
  });
  response.end(offlineEmptyDataContract);
}

function sendUnavailableScript(response: ServerResponse): void {
  response.writeHead(404, {
    ...resourceSecurityHeaders('application/javascript; charset=utf-8'),
    'cache-control': 'no-store',
    'content-length': 0,
    'content-type': 'application/javascript; charset=utf-8',
    'x-webmirror-unavailable': '1',
  });
  response.end();
}

function requestHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(',') : (value ?? '');
}

function isProgrammaticDataRequest(request: IncomingMessage): boolean {
  const destination = requestHeader(request, 'sec-fetch-dest').trim().toLowerCase();

  if (destination) {
    return destination === 'empty';
  }

  const accept = requestHeader(request, 'accept').toLowerCase();
  return accept.includes('application/json') || accept.includes('text/json');
}

function canUseOfflineEmptyData(extension: string): boolean {
  return (
    extension === '' ||
    extension === '.js' ||
    extension === '.json' ||
    extension === '.map' ||
    extension === '.webmanifest'
  );
}

function shouldUseOfflineEmptyData(request: IncomingMessage, extension: string): boolean {
  return isProgrammaticDataRequest(request) && canUseOfflineEmptyData(extension);
}

function sendUnavailableRoute(request: IncomingMessage, response: ServerResponse): void {
  if (shouldUseHistoryFallback(request)) {
    sendRuntimeNoop(
      response,
      'text/html; charset=utf-8',
      '<!doctype html><meta charset="utf-8"><title>Unavailable offline frame</title>',
    );
    return;
  }

  let extension = '';

  try {
    extension = extname(new URL(request.url ?? '/', 'http://127.0.0.1/').pathname).toLowerCase();
  } catch {
    // Invalid request targets are rejected before this helper is reached.
  }

  if (shouldUseOfflineEmptyData(request, extension)) {
    sendOfflineEmptyData(response);
    return;
  }

  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    sendUnavailableScript(response);
    return;
  }

  if (extension === '.css') {
    sendRuntimeNoop(response, 'text/css; charset=utf-8');
    return;
  }

  if (extension === '.json' || extension === '.map' || extension === '.webmanifest') {
    sendOfflineEmptyData(response);
    return;
  }

  if (extension === '.srt') {
    sendRuntimeNoop(response, 'application/x-subrip; charset=utf-8', neutralSubRipTrack);
    return;
  }

  if (extension === '.vtt') {
    sendRuntimeNoop(response, 'text/vtt; charset=utf-8', neutralWebVttTrack);
    return;
  }

  if (unavailableImageExtensions.has(extension)) {
    sendRuntimeNoopBytes(response, 'image/png', transparentPixelPng);
    return;
  }

  response.writeHead(204, {
    ...resourceSecurityHeaders('application/octet-stream'),
    'cache-control': 'no-store',
    'content-length': 0,
  });
  response.end();
}

function parseByteRange(value: string | undefined, size: number): ByteRange | undefined | null {
  if (!value) {
    return undefined;
  }

  if (size === 0) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());

  if (!match) {
    return null;
  }

  const startText = match[1] ?? '';
  const endText = match[2] ?? '';

  if (!startText && !endText) {
    return null;
  }

  if (!startText) {
    const suffixLength = Number.parseInt(endText, 10);

    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }

    return {
      start: Math.max(0, size - suffixLength),
      end: Math.max(0, size - 1),
    };
  }

  const start = Number.parseInt(startText, 10);
  const requestedEnd = endText ? Number.parseInt(endText, 10) : size - 1;

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return null;
  }

  return {
    start,
    end: Math.min(requestedEnd, size - 1),
  };
}

function normalizedRoute(value: string): string {
  const url = new URL(value, 'http://127.0.0.1/');

  if (url.origin !== 'http://127.0.0.1' || url.username || url.password || url.hash) {
    throw new Error('Invalid preview route');
  }

  const decodedPath = decodeURIComponent(url.pathname);

  if (
    !decodedPath.startsWith('/') ||
    decodedPath.includes('\\') ||
    decodedPath.includes('\0') ||
    decodedPath.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid preview route');
  }

  return `${url.pathname}${url.search}`;
}

function requestTarget(request: IncomingMessage): ParsedRequestTarget {
  const rawTarget = request.url ?? '/';
  const queryIndex = rawTarget.indexOf('?');
  const rawPath = queryIndex >= 0 ? rawTarget.slice(0, queryIndex) : rawTarget;

  if (!rawPath.startsWith('/') || rawPath.includes('\\') || rawPath.includes('\0')) {
    throw new Error('Invalid request path');
  }

  const decoded = decodeURIComponent(rawPath);

  if (decoded.includes('\\') || decoded.includes('\0')) {
    throw new Error('Invalid request path');
  }

  const segments = decoded.split('/');

  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Path traversal is not allowed');
  }

  const normalized = posix.normalize(decoded);
  const normalizedLocalPath =
    normalized === '/'
      ? 'index.html'
      : normalized.endsWith('/')
        ? `${normalized.replace(/^\/+/, '')}index.html`
        : normalized.replace(/^\/+/, '');
  return {
    localPath: normalizedLocalPath,
    route: normalizedRoute(rawTarget),
  };
}

function manifestContentTypes(
  manifest: PreviewServerOptions['manifest'],
): ReadonlyMap<string, string> {
  const contentTypes = new Map<string, string>();

  for (const resource of manifest?.resources ?? []) {
    if (!resource.localPath || !resource.contentType) {
      continue;
    }

    const pathWithinSite = resource.localPath.startsWith('site/')
      ? resource.localPath.slice('site/'.length)
      : resource.localPath;
    contentTypes.set(pathWithinSite.replaceAll('\\', '/'), resource.contentType);
  }

  return contentTypes;
}

function isInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function resolveRequestedFile(root: string, localPath: string): Promise<string | undefined> {
  try {
    let candidate = resolvePathInsideRoot(root, localPath);
    let metadata = await stat(candidate);

    if (metadata.isDirectory()) {
      candidate = resolve(candidate, 'index.html');
      metadata = await stat(candidate);
    }

    if (!metadata.isFile()) {
      return undefined;
    }

    const realCandidate = await realpath(candidate);
    return isInsideRoot(root, realCandidate) ? realCandidate : undefined;
  } catch {
    return undefined;
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  contentTypes: ReadonlyMap<string, string>,
  fallbackPath: string | undefined,
  routeAliases: ReadonlyMap<string, string>,
  unavailableRoutes: ReadonlySet<string>,
  port: number,
): Promise<void> {
  if (!isAllowedHost(request, port)) {
    sendText(response, 421, 'Misdirected request');
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('allow', 'GET, HEAD');
    sendText(response, 405, 'Method not allowed');
    return;
  }

  let target: ParsedRequestTarget;

  try {
    target = requestTarget(request);
  } catch {
    sendText(response, 400, 'Invalid path');
    return;
  }

  const requestPathname = new URL(request.url ?? '/', 'http://127.0.0.1/').pathname;

  if (requestPathname === runtimeNoopRoute) {
    // A programmatic offline fetch needs a successful loopback response so
    // that Response.url identifies the local no-op endpoint. Preserve the
    // human-readable HTML response for direct/browser-style navigation.
    if (!shouldUseHistoryFallback(request)) {
      sendOfflineEmptyData(response);
    } else {
      sendUnavailableRoute(request, response);
    }
    return;
  }

  if (requestPathname === runtimeNoopScriptRoute) {
    sendRuntimeNoop(response, 'application/javascript; charset=utf-8');
    return;
  }

  if (requestPathname === runtimeUnavailableScriptRoute) {
    sendUnavailableScript(response);
    return;
  }

  if (requestPathname === runtimeNoopStyleRoute) {
    sendRuntimeNoop(response, 'text/css; charset=utf-8');
    return;
  }

  let filePath = await resolveRequestedFile(root, target.localPath);

  if (!filePath) {
    const aliasPath = routeAliases.get(target.route);

    if (aliasPath) {
      filePath = await resolveRequestedFile(root, aliasPath);
    }
  }

  if (!filePath && unavailableRoutes.has(target.route)) {
    sendUnavailableRoute(request, response);
    return;
  }

  if (!filePath && shouldUseOfflineEmptyData(request, extname(requestPathname).toLowerCase())) {
    sendOfflineEmptyData(response);
    return;
  }

  if (!filePath && fallbackPath && shouldUseHistoryFallback(request)) {
    filePath = await resolveRequestedFile(root, fallbackPath);
  }

  if (!filePath) {
    sendText(response, 404, 'Not found');
    return;
  }

  const metadata = await stat(filePath);
  const range = parseByteRange(
    Array.isArray(request.headers.range) ? request.headers.range[0] : request.headers.range,
    metadata.size,
  );

  if (range === null) {
    response.writeHead(416, {
      ...securityHeaders(),
      'accept-ranges': 'bytes',
      'content-range': `bytes */${metadata.size}`,
      'content-type': 'text/plain; charset=utf-8',
    });
    response.end();
    return;
  }

  const relativePath = relative(root, filePath).split(sep).join('/');
  const contentType = contentTypeForPath(filePath, contentTypes.get(relativePath));
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, metadata.size - 1);
  const contentLength = metadata.size === 0 ? 0 : end - start + 1;
  const statusCode = range ? 206 : 200;
  const headers: Record<string, string | number> = {
    ...resourceSecurityHeaders(contentType),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'content-length': contentLength,
    'content-type': contentType,
    'last-modified': metadata.mtime.toUTCString(),
  };

  if (range) {
    headers['content-range'] = `bytes ${start}-${end}/${metadata.size}`;
  }

  response.writeHead(statusCode, headers);

  if (request.method === 'HEAD' || metadata.size === 0) {
    response.end();
    return;
  }

  const stream = createReadStream(filePath, { start, end });
  stream.once('error', () => {
    if (!response.headersSent) {
      sendText(response, 500, 'Could not read file');
    } else {
      response.destroy();
    }
  });
  stream.pipe(response);
}

function isAllowedHost(request: IncomingMessage, port: number): boolean {
  const value = Array.isArray(request.headers.host)
    ? request.headers.host[0]
    : request.headers.host;

  if (!value) {
    return false;
  }

  const host = value.trim().toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function shouldUseHistoryFallback(request: IncomingMessage): boolean {
  const accept = Array.isArray(request.headers.accept)
    ? request.headers.accept.join(',')
    : (request.headers.accept ?? '');

  if (
    (request.method !== 'GET' && request.method !== 'HEAD') ||
    !accept.toLowerCase().includes('text/html')
  ) {
    return false;
  }

  const destination = requestHeader(request, 'sec-fetch-dest').trim().toLowerCase();

  if (destination && destination !== 'document' && destination !== 'iframe') {
    return false;
  }

  try {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1/').pathname;
    return !nonDocumentExtensions.has(extname(pathname).toLowerCase());
  } catch {
    return false;
  }
}

function routeAliasMap(
  root: string,
  aliases: readonly PreviewRouteAlias[] | undefined,
): ReadonlyMap<string, string> {
  const mapping = new Map<string, string>();

  for (const alias of aliases ?? []) {
    const route = normalizedRoute(alias.route);
    resolvePathInsideRoot(root, alias.localPath);
    const existing = mapping.get(route);

    if (existing && existing !== alias.localPath) {
      throw new Error(`Preview route alias is ambiguous: ${route}`);
    }

    mapping.set(route, alias.localPath);
  }

  return mapping;
}

function unavailableRouteSet(routes: readonly string[] | undefined): ReadonlySet<string> {
  const values = new Set<string>();

  for (const route of routes ?? []) {
    values.add(normalizedRoute(route));
  }

  return values;
}

function isHtmlResource(resource: MirrorManifest['resources'][number]): boolean {
  const resourceType = resource.resourceType?.trim().toLowerCase();

  if (
    resourceType === 'font' ||
    resourceType === 'image' ||
    resourceType === 'manifest' ||
    resourceType === 'media' ||
    resourceType === 'script' ||
    resourceType === 'stylesheet' ||
    resourceType === 'texttrack' ||
    resourceType === 'worker' ||
    resourceType === 'xhr' ||
    resourceType === 'fetch'
  ) {
    return false;
  }

  const contentType = resource.contentType?.split(';', 1)[0]?.trim().toLowerCase();
  let extension = extname(resource.localPath ?? '').toLowerCase();

  try {
    extension = extname(new URL(resource.finalUrl ?? resource.canonicalUrl).pathname).toLowerCase();
  } catch {
    // The manifest URL is validated separately before it can become an alias.
  }

  if (nonDocumentExtensions.has(extension)) {
    return false;
  }

  return (
    contentType === 'text/html' ||
    contentType === 'application/xhtml+xml' ||
    extension === '.html' ||
    extension === '.htm'
  );
}

function sourceRoutePathPrefix(value: string): string | undefined {
  const pathname = new URL(value).pathname;
  const normalized = pathname === '/' ? '/' : pathname.replace(/\/+$/u, '');

  return normalized === '/' ? undefined : normalized;
}

function routePathname(value: string): string {
  return new URL(value, 'http://127.0.0.1/').pathname;
}

function externalResourceRoutes(value: string): string[] {
  const url = new URL(value);
  const routes = new Set([previewRouteForSourceUrl(url.toString())]);
  const segments = url.pathname.split('/').filter(Boolean);
  const firstSegment = segments[0];

  // Object stores commonly encode a dotted bucket or host name as their first
  // path segment. Runtime data often omits that transport-only prefix.
  if (firstSegment?.includes('.') && segments.length > 1) {
    url.pathname = `/${segments.slice(1).join('/')}`;
    routes.add(previewRouteForSourceUrl(url.toString()));
  }

  return [...routes];
}

const maximumEscapedPathDelimiterAliases = 4;

function escapedPathVariants(pathSegments: readonly string[]): string[][] {
  let markerCount = 0;

  for (const segment of pathSegments) {
    markerCount += [...segment.matchAll(/~[0-9a-f]{2}/giu)].length;
  }

  if (markerCount === 0) {
    return [[...pathSegments]];
  }

  const masks =
    markerCount <= maximumEscapedPathDelimiterAliases
      ? Array.from({ length: 1 << markerCount }, (_, index) => index)
      : [
          0,
          ...Array.from({ length: maximumEscapedPathDelimiterAliases }, (_, index) => 1 << index),
        ];
  const variants = new Map<string, string[]>();

  for (const mask of masks) {
    let markerIndex = 0;
    const variant = pathSegments.map((segment) =>
      segment.replace(/~(?=[0-9a-f]{2})/giu, () => {
        const removeDelimiter = (mask & (1 << markerIndex)) !== 0;
        markerIndex += 1;
        return removeDelimiter ? '' : '~';
      }),
    );
    variants.set(variant.join('/'), variant);
  }

  return [...variants.values()];
}

function routesForEscapedPathSegments(pathSegments: readonly string[]): string[] {
  return escapedPathVariants(pathSegments).map((segments) => `/${segments.join('/')}`);
}

function externalLocalResourceRoutes(localPath: string): string[] {
  const segments = localPath.replaceAll('\\', '/').split('/').filter(Boolean);

  if (
    segments[0] !== 'site' ||
    segments[1] !== '_external' ||
    (segments[2] !== 'http' && segments[2] !== 'https') ||
    !segments[3] ||
    segments.length < 5
  ) {
    return [];
  }

  const pathSegments = segments.slice(4);
  const routes = new Set(routesForEscapedPathSegments(pathSegments));
  const firstSegment = pathSegments[0];

  // Keep the same object-store bucket stripping rule as source URL aliases.
  // The physical local-path form is required when a runtime composes escaped
  // file-name segments instead of the original encoded URL.
  if (firstSegment?.includes('.') && pathSegments.length > 1) {
    for (const route of routesForEscapedPathSegments(pathSegments.slice(1))) {
      routes.add(route);
    }
  }

  return [...routes];
}

function sameOriginLocalResourceRoutes(localPath: string): string[] {
  const segments = localPath.replaceAll('\\', '/').split('/').filter(Boolean);

  if (segments[0] !== 'site' || segments[1] === '_external' || segments.length < 2) {
    return [];
  }

  return routesForEscapedPathSegments(segments.slice(1));
}

function addUniqueRouteCandidate(
  candidates: Map<string, string | undefined>,
  route: string,
  localPath: string,
): void {
  if (!candidates.has(route)) {
    candidates.set(route, localPath);
    return;
  }

  if (candidates.get(route) !== localPath) {
    candidates.set(route, undefined);
  }
}

export function previewRouteForSourceUrl(value: string): string {
  const url = new URL(value);

  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new TypeError('Preview source URL must use HTTP or HTTPS without credentials');
  }

  // A URL pathname may legally begin with multiple slashes (for example,
  // `https://api.example.test//v1/config.json`). Passing that pathname back to
  // `new URL(route, loopbackOrigin)` would reinterpret it as a scheme-relative
  // URL and therefore as a different host. Preview routes always belong to the
  // loopback origin, so collapse only the leading slash run and validate the
  // resulting local route before it can enter the alias/no-op tables.
  const pathname = `/${url.pathname.replace(/^\/+/u, '')}`;
  return normalizedRoute(`${pathname}${url.search}`);
}

export function createPreviewRouteAliases(
  manifest: Pick<MirrorManifest, 'source' | 'resources'>,
): PreviewRouteAlias[] {
  const sourceUrl = new URL(manifest.source.url);
  const sourceOrigin = sourceUrl.origin;
  const sourceRoute = previewRouteForSourceUrl(manifest.source.url);
  const sourceRoutePrefix = sourceRoutePathPrefix(manifest.source.url);
  const aliases = new Map<string, string>();
  const knownSameOriginRoutes = new Set<string>();
  const routePrefixedCandidates = new Map<string, string | undefined>();
  const externalRouteCandidates = new Map<string, string | undefined>();
  const sameOriginLocalRouteCandidates = new Map<string, string | undefined>();

  for (const resource of manifest.resources) {
    const resourceUrls = new Set(
      [resource.canonicalUrl, resource.finalUrl].filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      ),
    );

    for (const value of resourceUrls) {
      try {
        const resourceUrl = new URL(value);

        const route = previewRouteForSourceUrl(resourceUrl.toString());

        if (resourceUrl.origin === sourceOrigin) {
          knownSameOriginRoutes.add(route);

          if (resource.localPath) {
            for (const localRoute of sameOriginLocalResourceRoutes(resource.localPath)) {
              knownSameOriginRoutes.add(localRoute);
            }
          }
        }

        if (resource.status !== 'downloaded' || !resource.localPath?.startsWith('site/')) {
          continue;
        }

        const localPath = resource.localPath.slice('site/'.length);

        if (resourceUrl.origin === sourceOrigin) {
          if (isHtmlResource(resource)) {
            if (!aliases.has(route)) {
              aliases.set(route, localPath);
            }
            continue;
          }

          addUniqueRouteCandidate(routePrefixedCandidates, route, localPath);
          const localRoutes = sameOriginLocalResourceRoutes(resource.localPath);
          const directLocalRoute = localRoutes[0];

          for (const localRoute of localRoutes) {
            addUniqueRouteCandidate(routePrefixedCandidates, localRoute, localPath);

            if (localRoute !== directLocalRoute) {
              addUniqueRouteCandidate(sameOriginLocalRouteCandidates, localRoute, localPath);
            }
          }
          continue;
        }

        if (!isHtmlResource(resource)) {
          for (const externalRoute of externalResourceRoutes(resourceUrl.toString())) {
            addUniqueRouteCandidate(externalRouteCandidates, externalRoute, localPath);
          }

          for (const externalRoute of externalLocalResourceRoutes(resource.localPath)) {
            addUniqueRouteCandidate(externalRouteCandidates, externalRoute, localPath);
          }
        }
      } catch {
        // Malformed manifest URLs stay visible to validation instead of becoming aliases.
      }
    }
  }

  for (const [route, localPath] of externalRouteCandidates) {
    if (!localPath || knownSameOriginRoutes.has(route) || aliases.has(route)) {
      continue;
    }

    aliases.set(route, localPath);
    addUniqueRouteCandidate(routePrefixedCandidates, route, localPath);
  }

  for (const [route, localPath] of sameOriginLocalRouteCandidates) {
    if (!localPath || aliases.has(route)) {
      continue;
    }

    aliases.set(route, localPath);
  }

  if (sourceRoutePrefix) {
    for (const [resourceRoute, localPath] of routePrefixedCandidates) {
      if (!localPath) {
        continue;
      }

      const resourcePathname = routePathname(resourceRoute);

      // A genuine source asset below the entry route must keep its own path. The
      // alias only repairs runtimes that concatenate the entry route with a
      // captured root resource path.
      if (
        resourcePathname === sourceRoutePrefix ||
        resourcePathname.startsWith(`${sourceRoutePrefix}/`)
      ) {
        continue;
      }

      const route = `${sourceRoutePrefix}${resourceRoute}`;

      if (!knownSameOriginRoutes.has(route) && !aliases.has(route)) {
        aliases.set(route, localPath);
      }
    }
  }

  return [...aliases.entries()]
    .sort(([left], [right]) => {
      if (left === sourceRoute) {
        return -1;
      }

      if (right === sourceRoute) {
        return 1;
      }

      return left.localeCompare(right);
    })
    .map(([route, localPath]) => ({ route, localPath }));
}

export function createPreviewUnavailableRoutes(
  manifest: Pick<MirrorManifest, 'source' | 'resources'>,
): string[] {
  const sourceUrl = new URL(manifest.source.url);
  const sourceOrigin = sourceUrl.origin;
  const sourceRoutePrefix = sourceRoutePathPrefix(manifest.source.url);
  const availableRoutes = new Set<string>();
  const unavailableRoutes = new Set<string>();
  const sameOriginUnavailableRoutes = new Set<string>();

  for (const resource of manifest.resources) {
    const resourceUrls = new Set(
      [resource.canonicalUrl, resource.finalUrl].filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      ),
    );
    const resourceRoutes = new Set<string>();
    let hasSameOriginUrl = false;

    for (const value of resourceUrls) {
      try {
        const resourceUrl = new URL(value);

        if (resourceUrl.origin === sourceOrigin) {
          hasSameOriginUrl = true;
          resourceRoutes.add(previewRouteForSourceUrl(resourceUrl.toString()));
        } else {
          for (const route of externalResourceRoutes(resourceUrl.toString())) {
            resourceRoutes.add(route);
          }
        }
      } catch {
        // Invalid manifest URLs cannot become local no-op routes.
      }
    }

    if (resource.localPath) {
      const localRoutes = resource.localPath.startsWith('site/_external/')
        ? externalLocalResourceRoutes(resource.localPath)
        : sameOriginLocalResourceRoutes(resource.localPath);

      for (const route of localRoutes) {
        resourceRoutes.add(route);
      }
    }

    if (resource.status === 'downloaded' && resource.localPath?.startsWith('site/')) {
      for (const route of resourceRoutes) {
        availableRoutes.add(route);
      }
      continue;
    }

    if (
      resource.status !== 'failed' &&
      resource.status !== 'skipped' &&
      resource.status !== 'pending'
    ) {
      continue;
    }

    for (const route of resourceRoutes) {
      unavailableRoutes.add(route);

      if (hasSameOriginUrl) {
        sameOriginUnavailableRoutes.add(route);
      }
    }
  }

  const routes = new Set<string>();

  for (const route of unavailableRoutes) {
    if (availableRoutes.has(route) && !sameOriginUnavailableRoutes.has(route)) {
      continue;
    }

    routes.add(route);

    if (!sourceRoutePrefix) {
      continue;
    }

    const routePath = routePathname(route);

    if (routePath === sourceRoutePrefix || routePath.startsWith(`${sourceRoutePrefix}/`)) {
      continue;
    }

    routes.add(`${sourceRoutePrefix}${route}`);
  }

  return [...routes].sort((left, right) => left.localeCompare(right));
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();

      if (!address || typeof address === 'string') {
        reject(new Error('Preview server did not expose a TCP address'));
        return;
      }

      resolveListen(address.port);
    });
  });
}

export async function startPreviewServer(options: PreviewServerOptions): Promise<PreviewServer> {
  const configuredRoot = resolve(options.rootDirectory);
  const configuredRootMetadata = await lstat(configuredRoot);

  if (configuredRootMetadata.isSymbolicLink()) {
    throw new Error('Preview root must not be a symbolic link or junction');
  }

  const root = await realpath(configuredRoot);
  const rootMetadata = await stat(root);

  if (!rootMetadata.isDirectory()) {
    throw new Error('Preview root must be a directory');
  }

  const contentTypes = manifestContentTypes(options.manifest);
  const fallbackPath = options.fallbackPath;

  if (fallbackPath) {
    resolvePathInsideRoot(root, fallbackPath);
  }
  const routeAliases = routeAliasMap(root, options.routeAliases);
  const unavailableRoutes = unavailableRouteSet(options.unavailableRoutes);

  let port = 0;
  const server = createServer((request, response) => {
    void handleRequest(
      request,
      response,
      root,
      contentTypes,
      fallbackPath,
      routeAliases,
      unavailableRoutes,
      port,
    ).catch(() => {
      if (!response.headersSent) {
        sendText(response, 500, 'Preview server error');
      } else {
        response.destroy();
      }
    });
  });
  port = await listen(server, options.port ?? 0);

  return {
    host: '127.0.0.1',
    port,
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolveClose();
          }
        });
      }),
  };
}
