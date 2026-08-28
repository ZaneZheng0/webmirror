import { posix } from 'node:path';

import { isKnownNonessentialExternalUrl, isSensitiveQueryName } from '@webmirror/shared';

import { canonicalizeImageRenditionIdentity, getImageRenditionAliases } from './resource-map.js';

export type UrlToLocalPathMap = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

export interface RewriteTextInput {
  text: string;
  resourceUrl: string;
  urlToLocalPath: UrlToLocalPathMap;
  currentLocalPath: string;
  knownResourceUrls?: readonly string[];
  workerContext?: boolean;
}

export interface RewriteResult {
  text: string;
  unresolvedDependencies: string[];
  onlineDependencies: string[];
  workerDependencies?: string[];
}

export type LocalReferenceStyle = 'url' | 'module-specifier' | 'site-root-url';

const likelyStaticAssetExtensions = new Set([
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
  '.fs',
  '.gif',
  '.glb',
  '.gltf',
  '.glsl',
  '.gz',
  '.hdr',
  '.htm',
  '.html',
  '.ico',
  '.icon',
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
  '.mtl',
  '.obj',
  '.oga',
  '.ogg',
  '.ogv',
  '.opus',
  '.otf',
  '.pdf',
  '.ply',
  '.png',
  '.pvr',
  '.riv',
  '.shader',
  '.srt',
  '.stl',
  '.svg',
  '.tar',
  '.tif',
  '.tiff',
  '.ttf',
  '.txt',
  '.vert',
  '.vs',
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

interface ResolvedReference {
  canonicalUrl: string;
  fragment: string;
  origin: string;
}

interface LocalizedReference {
  localPath: string;
  suffix: string;
}

interface KnownReferenceMatch {
  canonicalUrl: string;
  suffix: string;
}

function isBarePathReference(value: string): boolean {
  const trimmed = value.trim();
  return (
    !trimmed.startsWith('http://') &&
    !trimmed.startsWith('https://') &&
    !trimmed.startsWith('//') &&
    !trimmed.startsWith('/') &&
    !trimmed.startsWith('./') &&
    !trimmed.startsWith('../')
  );
}

function parseHttpUrl(value: string, label: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute URL: ${value}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`${label} must use http or https: ${value}`);
  }

  if (url.username || url.password) {
    throw new TypeError(`${label} must not contain credentials`);
  }

  return url;
}

function validateLocalPath(value: string, label: string): string {
  if (
    !value ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    posix.isAbsolute(value)
  ) {
    throw new TypeError(`${label} must be a relative POSIX path`);
  }

  const segments = value.split('/');

  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        [...segment].some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint !== undefined && codePoint < 32;
        }),
    )
  ) {
    throw new TypeError(`${label} contains an unsafe path segment`);
  }

  return value;
}

function mappingEntries(mapping: UrlToLocalPathMap): Iterable<readonly [string, string]> {
  if (mapping instanceof Map) {
    return mapping.entries();
  }

  return Object.entries(mapping);
}

function canonicalUrl(value: string, label: string): string {
  const url = parseHttpUrl(value, label);
  url.hash = '';
  return url.toString();
}

function hasSensitiveQuery(value: string): boolean {
  const url = new URL(value);
  return [...url.searchParams.keys()].some(isSensitiveQueryName);
}

function hasExplicitUrlShape(value: string): boolean {
  const trimmed = value.trim();

  if (!trimmed || trimmed.startsWith('#')) {
    return false;
  }

  const lower = trimmed.toLowerCase();

  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../')
  ) {
    return true;
  }

  if ([...trimmed].some((character) => /\s/u.test(character))) {
    return false;
  }

  return trimmed.includes('/');
}

function hasUnsupportedUrlWhitespace(value: string): boolean {
  return [...value].some((character) => /\s/u.test(character) && character !== ' ');
}

function hasLikelyStaticAssetShapeWithOptions(
  value: string,
  allowUnencodedSpaces: boolean,
): boolean {
  const trimmed = value.trim();

  if (
    !trimmed ||
    hasUnsupportedUrlWhitespace(trimmed) ||
    (!allowUnencodedSpaces && trimmed.includes(' '))
  ) {
    return false;
  }

  let url: URL;

  try {
    url = new URL(trimmed, 'https://webmirror.invalid/');
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }

  const fileName = posix.basename(url.pathname);
  const extension = posix.extname(fileName).toLowerCase();
  return fileName.length > extension.length && likelyStaticAssetExtensions.has(extension);
}

export function hasLikelyStaticAssetShape(value: string): boolean {
  return hasLikelyStaticAssetShapeWithOptions(value, false);
}

export function hasLikelyStaticAssetShapeWithUnencodedSpaces(value: string): boolean {
  return hasLikelyStaticAssetShapeWithOptions(value, true);
}

function relativeLocalReference(
  currentLocalPath: string,
  targetLocalPath: string,
  style: LocalReferenceStyle,
): string {
  if (style === 'site-root-url') {
    return `/${targetLocalPath.startsWith('site/') ? targetLocalPath.slice('site/'.length) : targetLocalPath}`;
  }

  let relativePath = posix.relative(posix.dirname(currentLocalPath), targetLocalPath);

  if (!relativePath) {
    relativePath = posix.basename(targetLocalPath);
  }

  if (
    style === 'module-specifier' &&
    !relativePath.startsWith('./') &&
    !relativePath.startsWith('../')
  ) {
    return `./${relativePath}`;
  }

  return relativePath;
}

function resourcePathAliasKeys(value: string): string[] {
  const url = new URL(value);
  const fileName = posix.basename(url.pathname);
  const extension = posix.extname(fileName).toLowerCase();

  if (!fileName || !likelyStaticAssetExtensions.has(extension)) {
    return [];
  }

  const pathname = url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`;
  return pathname === `/${fileName}` ? [pathname] : [pathname, `/${fileName}`];
}

function volatileQueryValueIdentity(value: string): string | undefined {
  const match = /^(?<prefix>[A-Za-z][A-Za-z0-9_-]{0,63}[_-])?(?<timestamp>\d{11,})$/u.exec(
    value.trim(),
  );

  if (!match?.groups?.timestamp) {
    return undefined;
  }

  return `${match.groups.prefix ?? ''}<timestamp>`;
}

function hasCacheLikeReferenceQuery(url: URL): boolean {
  if (!url.search || [...url.searchParams.keys()].some(isSensitiveQueryName)) {
    return false;
  }

  const cacheParameterNames = new Set([
    'cache',
    'cachebust',
    'cachebuster',
    'cb',
    't',
    'timestamp',
    'ts',
    'v',
    'ver',
    'version',
  ]);

  return [...url.searchParams].every(([name, value]) => {
    const normalizedName = name.trim();
    const normalizedValue = value.trim();

    if (
      (!normalizedValue && /^\d{8,}(?:-[A-Za-z][A-Za-z0-9_-]{0,63})?$/u.test(normalizedName)) ||
      volatileQueryValueIdentity(normalizedName) ||
      volatileQueryValueIdentity(normalizedValue)
    ) {
      return true;
    }

    return (
      cacheParameterNames.has(normalizedName.toLowerCase()) &&
      /^[A-Za-z0-9._-]{1,128}$/u.test(normalizedValue)
    );
  });
}

function volatileQueryAliasKey(value: string): string | undefined {
  const url = new URL(value);

  if (!url.search || hasSensitiveQuery(value)) {
    return undefined;
  }

  let hasVolatileValue = false;
  const parameters = [...url.searchParams]
    .map(([name, parameterValue]) => {
      const volatileValue = volatileQueryValueIdentity(parameterValue);

      if (volatileValue) {
        hasVolatileValue = true;
      }

      return [name, volatileValue ?? parameterValue] as const;
    })
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      const nameComparison = leftName.localeCompare(rightName);
      return nameComparison === 0 ? leftValue.localeCompare(rightValue) : nameComparison;
    });

  return hasVolatileValue ? JSON.stringify([url.origin, url.pathname, parameters]) : undefined;
}

export class RewriteSession {
  readonly #currentResourceUrl: URL;
  readonly #currentLocalPath: string;
  readonly #urlToLocalPath = new Map<string, string>();
  readonly #imageRenditionAliases = new Map<string, string>();
  readonly #pathAliases = new Map<string, string>();
  readonly #ambiguousPathAliases = new Set<string>();
  readonly #volatileQueryAliases = new Map<string, string>();
  readonly #ambiguousVolatileQueryAliases = new Set<string>();
  readonly #localPaths = new Set<string>();
  readonly #knownResourceUrls = new Set<string>();
  readonly #unresolvedDependencies = new Set<string>();
  readonly #onlineDependencies = new Set<string>();
  readonly #workerDependencies = new Set<string>();

  constructor(input: RewriteTextInput) {
    this.#currentResourceUrl = parseHttpUrl(input.resourceUrl, 'resourceUrl');
    this.#currentLocalPath = validateLocalPath(input.currentLocalPath, 'currentLocalPath');

    for (const [sourceUrl, localPath] of mappingEntries(input.urlToLocalPath)) {
      const normalizedUrl = canonicalUrl(sourceUrl, 'URL mapping key');
      const normalizedLocalPath = validateLocalPath(
        localPath,
        `Local path mapped from ${normalizedUrl}`,
      );
      const existingPath = this.#urlToLocalPath.get(normalizedUrl);

      if (existingPath && existingPath !== normalizedLocalPath) {
        throw new TypeError(`URL mapping contains conflicting local paths for ${normalizedUrl}`);
      }

      this.#urlToLocalPath.set(normalizedUrl, normalizedLocalPath);
      this.#knownResourceUrls.add(normalizedUrl);
      this.#recordPathAlias(normalizedUrl, normalizedLocalPath);
      this.#recordVolatileQueryAlias(normalizedUrl, normalizedLocalPath);
      this.#localPaths.add(normalizedLocalPath);
    }

    for (const sourceUrl of input.knownResourceUrls ?? []) {
      this.#knownResourceUrls.add(canonicalUrl(sourceUrl, 'Known resource URL'));
    }

    for (const [identityUrl, localPath] of getImageRenditionAliases(input.urlToLocalPath) ?? []) {
      const normalizedUrl = canonicalUrl(identityUrl, 'Image rendition alias key');
      const normalizedLocalPath = validateLocalPath(
        localPath,
        `Local path mapped from image rendition ${normalizedUrl}`,
      );
      const existingPath = this.#imageRenditionAliases.get(normalizedUrl);

      if (existingPath && existingPath !== normalizedLocalPath) {
        throw new TypeError(
          `Image rendition aliases contain conflicting local paths for ${normalizedUrl}`,
        );
      }

      this.#imageRenditionAliases.set(normalizedUrl, normalizedLocalPath);
      this.#localPaths.add(normalizedLocalPath);
    }
  }

  rewriteKnownUrl(reference: string, style: LocalReferenceStyle = 'url'): string {
    return this.#rewriteReference(reference, true, true, style);
  }

  rewriteMappedUrl(reference: string, style: LocalReferenceStyle = 'url'): string {
    return this.#rewriteReference(reference, false, true, style);
  }

  hasMappedUrl(reference: string): boolean {
    if (this.#shouldIgnoreReference(reference)) {
      return false;
    }

    if (this.#alreadyLocalizedReference(reference)) {
      return true;
    }

    const resolved = this.#resolveReference(reference);
    return Boolean(
      resolved &&
      (this.#mappedLocalPathForCanonicalUrl(resolved.canonicalUrl) ||
        this.#mappedPathAliasForReference(reference)),
    );
  }

  rewriteMappedStaticString(value: string, style: LocalReferenceStyle = 'url'): string {
    return hasLikelyStaticAssetShape(value)
      ? this.#rewriteReference(value, false, false, style)
      : value;
  }

  /**
   * Keep absolute HTTP(S) values in data attributes parseable by code that
   * calls `new URL(value)` without supplying a base. The runtime URL map will
   * localize the value when it is later consumed by fetch/XHR/element APIs.
   */
  rewriteMappedDataAttribute(value: string, style: LocalReferenceStyle = 'url'): string {
    const trimmed = value.trim();

    try {
      const url = new URL(trimmed);

      if (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        !url.username &&
        !url.password
      ) {
        return value;
      }
    } catch {
      // Fall through to the ordinary mapped-static-string behavior.
    }

    return this.rewriteMappedStaticString(value, style);
  }

  rewriteMappedJavaScriptLiteral(value: string, style: LocalReferenceStyle = 'url'): string {
    return hasLikelyStaticAssetShape(value)
      ? this.#rewriteReference(value, false, false, style, false)
      : value;
  }

  rewriteStaticString(value: string, style: LocalReferenceStyle = 'url'): string {
    return hasLikelyStaticAssetShape(value)
      ? this.#rewriteReference(value, true, false, style)
      : value;
  }

  rewriteManifestStaticString(value: string, style: LocalReferenceStyle = 'url'): string {
    const trimmed = value.trim();
    const likelyAsset = hasLikelyStaticAssetShape(value);

    if (
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('./') ||
      trimmed.startsWith('../')
    ) {
      return likelyAsset || this.hasMappedUrl(value)
        ? this.#rewriteReference(value, likelyAsset, false, style)
        : value;
    }

    if (trimmed.startsWith('/')) {
      return likelyAsset || Boolean(this.#mappedLocalPath(trimmed))
        ? this.#rewriteReference(value, likelyAsset, false, 'site-root-url')
        : value;
    }

    const rootReference = `/${trimmed}`;
    const relativeMappedPath = this.#mappedLocalPath(trimmed);
    const rootMappedPath = this.#mappedLocalPath(rootReference);

    if (relativeMappedPath && !rootMappedPath) {
      return this.#rewriteReference(value, false, false, style);
    }

    if (rootMappedPath && !relativeMappedPath) {
      return this.#rewriteReference(rootReference, false, false, 'site-root-url');
    }

    if (relativeMappedPath && rootMappedPath) {
      return this.#rewriteReference(value, false, false, style);
    }

    if (!likelyAsset) {
      return value;
    }

    const referenceSegments = (trimmed.split(/[?#]/u, 1)[0] ?? '').split('/').filter(Boolean);
    const resourceSegments = this.#currentResourceUrl.pathname
      .replace(/^\/+/u, '')
      .split('/')
      .slice(0, -1)
      .filter(Boolean);
    let commonSegments = 0;

    while (
      commonSegments < referenceSegments.length &&
      commonSegments < resourceSegments.length &&
      referenceSegments[commonSegments] === resourceSegments[commonSegments]
    ) {
      commonSegments += 1;
    }

    return commonSegments >= 2
      ? this.#rewriteReference(rootReference, true, false, 'site-root-url')
      : this.#rewriteReference(value, true, false, style);
  }

  rewriteProvenManifestStaticString(value: string, style: LocalReferenceStyle = 'url'): string {
    if (!hasLikelyStaticAssetShape(value) || this.#shouldIgnoreReference(value)) {
      return value;
    }

    const resolved = this.#resolveReference(value);

    if (!resolved) {
      return value;
    }

    const mapped =
      this.#mappedLocalPathForCanonicalUrl(resolved.canonicalUrl) ??
      this.#mappedPathAliasForReference(value);
    const knownReference = this.#knownUrlForReference(value, resolved.canonicalUrl, true);

    if (!mapped && !this.#knownResourceUrls.has(resolved.canonicalUrl) && !knownReference) {
      return value;
    }

    return this.#rewriteReference(value, true, false, style, true, true);
  }

  rewriteRuntimeManifestString(
    value: string,
    style: LocalReferenceStyle = 'site-root-url',
  ): string {
    const trimmed = value.trim();

    if (
      !trimmed ||
      [...trimmed].some((character) => /\s/u.test(character)) ||
      (!hasLikelyStaticAssetShape(trimmed) &&
        !trimmed.startsWith('http://') &&
        !trimmed.startsWith('https://') &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('/') &&
        !trimmed.startsWith('./') &&
        !trimmed.startsWith('../'))
    ) {
      return value;
    }

    return this.#rewriteReference(value, true, false, style);
  }

  runtimeUrlMappings(): Array<readonly [string, string]> {
    return [...this.#urlToLocalPath.entries()]
      .filter(([sourceUrl]) => !hasSensitiveQuery(sourceUrl))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([sourceUrl, localPath]) =>
          [
            sourceUrl,
            relativeLocalReference(this.#currentLocalPath, localPath, 'site-root-url'),
          ] as const,
      );
  }

  runtimeImageRenditionMappings(): Array<readonly [string, string]> {
    return [...this.#imageRenditionAliases.entries()]
      .filter(([sourceUrl]) => !hasSensitiveQuery(sourceUrl))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([sourceUrl, localPath]) =>
          [
            sourceUrl,
            relativeLocalReference(this.#currentLocalPath, localPath, 'site-root-url'),
          ] as const,
      );
  }

  runtimePathMappings(): Array<readonly [string, string]> {
    return [...this.#pathAliases.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([pathAlias, localPath]) =>
          [
            pathAlias,
            relativeLocalReference(this.#currentLocalPath, localPath, 'site-root-url'),
          ] as const,
      );
  }

  runtimeSuffixMappings(): Array<readonly [string, string]> {
    const candidates = new Map<string, string | undefined>();

    for (const [sourceUrl, localPath] of this.#urlToLocalPath) {
      if (hasSensitiveQuery(sourceUrl)) {
        continue;
      }

      const url = new URL(sourceUrl);

      if (url.search) {
        continue;
      }

      const segments = url.pathname.split('/').filter(Boolean);

      for (let index = 1; index < segments.length; index += 1) {
        const suffix = `/${segments.slice(index).join('/')}`;
        const existingPath = candidates.get(suffix);

        if (existingPath === undefined && candidates.has(suffix)) {
          continue;
        }

        if (!existingPath || existingPath === localPath) {
          candidates.set(suffix, localPath);
        } else {
          candidates.set(suffix, undefined);
        }
      }
    }

    return [...candidates.entries()]
      .filter((candidate): candidate is [string, string] => typeof candidate[1] === 'string')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([pathSuffix, localPath]) =>
          [
            pathSuffix,
            relativeLocalReference(this.#currentLocalPath, localPath, 'site-root-url'),
          ] as const,
      );
  }

  runtimeVolatileQueryMappings(): Array<readonly [string, string]> {
    return [...this.#volatileQueryAliases.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([aliasKey, localPath]) =>
          [
            aliasKey,
            relativeLocalReference(this.#currentLocalPath, localPath, 'site-root-url'),
          ] as const,
      );
  }

  mappedResourceUrls(): string[] {
    return [...this.#knownResourceUrls].filter((sourceUrl) => !hasSensitiveQuery(sourceUrl)).sort();
  }

  runtimeMapSourceOrigin(): string {
    return this.#currentResourceUrl.origin;
  }

  runtimeMapResourceUrl(): string {
    const resourceUrl = new URL(this.#currentResourceUrl);
    resourceUrl.search = '';
    resourceUrl.hash = '';
    return resourceUrl.toString();
  }

  markWorkerDependency(reference: string): void {
    if (this.#shouldIgnoreReference(reference)) {
      return;
    }

    const resolved = this.#resolveReference(reference);

    if (resolved) {
      this.#workerDependencies.add(resolved.canonicalUrl);
    }
  }

  result(text: string): RewriteResult {
    return {
      text,
      unresolvedDependencies: [...this.#unresolvedDependencies],
      onlineDependencies: [...this.#onlineDependencies],
      ...(this.#workerDependencies.size > 0
        ? { workerDependencies: [...this.#workerDependencies].sort() }
        : {}),
    };
  }

  #rewriteReference(
    reference: string,
    reportUnmapped: boolean,
    knownUrl: boolean,
    style: LocalReferenceStyle,
    allowPathAlias = true,
    allowBasenameMatch = false,
  ): string {
    if (this.#shouldIgnoreReference(reference)) {
      return reference;
    }

    const alreadyLocalized = this.#alreadyLocalizedReference(reference);

    if (alreadyLocalized) {
      return `${relativeLocalReference(
        this.#currentLocalPath,
        alreadyLocalized.localPath,
        style,
      )}${alreadyLocalized.suffix}`;
    }

    const resolved = this.#resolveReference(reference);

    if (!resolved) {
      if (reportUnmapped && knownUrl && hasExplicitUrlShape(reference)) {
        this.#unresolvedDependencies.add(reference.trim());
      }

      return reference;
    }

    const localPath =
      this.#mappedLocalPathForCanonicalUrl(resolved.canonicalUrl) ??
      (allowPathAlias ? this.#mappedPathAliasForReference(reference) : undefined);

    if (localPath) {
      return `${relativeLocalReference(
        this.#currentLocalPath,
        localPath,
        style,
      )}${resolved.fragment}`;
    }

    const knownReference = this.#knownUrlForReference(
      reference,
      resolved.canonicalUrl,
      allowBasenameMatch,
    );

    if (knownReference) {
      const knownReferencePath = this.#mappedLocalPathForCanonicalUrl(knownReference.canonicalUrl);

      if (knownReferencePath) {
        return `${relativeLocalReference(
          this.#currentLocalPath,
          knownReferencePath,
          style,
        )}${knownReference.suffix}${resolved.fragment}`;
      }

      if (reportUnmapped && (knownUrl || hasLikelyStaticAssetShape(reference))) {
        this.#unresolvedDependencies.add(knownReference.canonicalUrl);
      }

      return reference;
    }

    if (reportUnmapped && (knownUrl || hasLikelyStaticAssetShape(reference))) {
      if (resolved.origin === this.#currentResourceUrl.origin) {
        this.#unresolvedDependencies.add(resolved.canonicalUrl);
      } else {
        this.#onlineDependencies.add(resolved.canonicalUrl);
      }
    }

    return reference;
  }

  #shouldIgnoreReference(reference: string): boolean {
    const trimmed = reference.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      return true;
    }

    if (isKnownNonessentialExternalUrl(trimmed, this.#currentResourceUrl.toString())) {
      return true;
    }

    try {
      const url = new URL(trimmed, this.#currentResourceUrl);
      return (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        Boolean(url.username) ||
        Boolean(url.password)
      );
    } catch {
      return false;
    }
  }

  #alreadyLocalizedReference(reference: string): LocalizedReference | undefined {
    const trimmed = reference.trim();

    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) {
      return undefined;
    }

    try {
      const absolute = new URL(trimmed);

      if (
        (absolute.protocol === 'http:' || absolute.protocol === 'https:') &&
        !absolute.username &&
        !absolute.password &&
        absolute.origin === this.#currentResourceUrl.origin
      ) {
        const siteRootPath = absolute.pathname.replace(/^\/+/u, '');

        if (siteRootPath) {
          const suffix = `${absolute.search}${absolute.hash}`;

          if (this.#localPaths.has(siteRootPath)) {
            return { localPath: siteRootPath, suffix };
          }

          const siteLocalPath = `site/${siteRootPath}`;

          if (this.#localPaths.has(siteLocalPath)) {
            return { localPath: siteLocalPath, suffix };
          }
        }
      }
    } catch {
      // Relative references continue through the normal local-path checks.
    }

    const suffixIndex = trimmed.search(/[?#]/u);
    const path = suffixIndex === -1 ? trimmed : trimmed.slice(0, suffixIndex);
    const suffix = suffixIndex === -1 ? '' : trimmed.slice(suffixIndex);

    if (!path) {
      return undefined;
    }

    if (path.startsWith('/')) {
      const siteRootPath = path.slice(1);

      if (!siteRootPath) {
        return undefined;
      }

      if (this.#localPaths.has(siteRootPath)) {
        return { localPath: siteRootPath, suffix };
      }

      const siteLocalPath = `site/${siteRootPath}`;
      return this.#localPaths.has(siteLocalPath) ? { localPath: siteLocalPath, suffix } : undefined;
    }

    const candidate = posix.normalize(posix.join(posix.dirname(this.#currentLocalPath), path));

    if (
      candidate === '..' ||
      candidate.startsWith('../') ||
      posix.isAbsolute(candidate) ||
      !this.#localPaths.has(candidate)
    ) {
      return undefined;
    }

    return {
      localPath: candidate,
      suffix,
    };
  }

  #mappedLocalPath(reference: string): string | undefined {
    const resolved = this.#resolveReference(reference);
    return resolved ? this.#mappedLocalPathForCanonicalUrl(resolved.canonicalUrl) : undefined;
  }

  #mappedLocalPathForCanonicalUrl(canonicalUrlValue: string): string | undefined {
    const exactPath = this.#urlToLocalPath.get(canonicalUrlValue);

    if (exactPath) {
      return exactPath;
    }

    const identityUrl = canonicalizeImageRenditionIdentity(canonicalUrlValue);
    const renditionPath = identityUrl ? this.#imageRenditionAliases.get(identityUrl) : undefined;

    if (renditionPath) {
      return renditionPath;
    }

    return undefined;
  }

  #mappedPathAliasForReference(reference: string): string | undefined {
    const trimmed = reference.trim();

    if (trimmed.includes('?')) {
      return undefined;
    }

    let path: string;

    try {
      if (
        trimmed.startsWith('http://') ||
        trimmed.startsWith('https://') ||
        trimmed.startsWith('//')
      ) {
        const absoluteUrl = new URL(trimmed, this.#currentResourceUrl);

        if (absoluteUrl.origin !== this.#currentResourceUrl.origin) {
          return undefined;
        }

        path = absoluteUrl.pathname;
      } else {
        path = trimmed.split(/[?#]/u, 1)[0] ?? '';

        if (path.startsWith('./') || path.startsWith('../')) {
          return undefined;
        }
      }
    } catch {
      return undefined;
    }

    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const exactPath = this.#pathAliases.get(normalizedPath);

    if (exactPath) {
      return exactPath;
    }

    const segments = normalizedPath.split('/').filter(Boolean);
    return segments.length === 1 ? this.#pathAliases.get(`/${segments[0]}`) : undefined;
  }

  #knownUrlForReference(
    reference: string,
    standardResolvedUrl: string,
    allowBasenameMatch = false,
  ): KnownReferenceMatch | undefined {
    const trimmed = reference.trim();

    if (!isBarePathReference(trimmed) || hasSensitiveQuery(standardResolvedUrl)) {
      return undefined;
    }

    let referenceUrl: URL;

    try {
      referenceUrl = new URL(trimmed, this.#currentResourceUrl.origin);
    } catch {
      return undefined;
    }

    const referencePath = referenceUrl.pathname.replace(/^\/+/, '');

    if (referencePath.split('/').filter(Boolean).length < 2) {
      return undefined;
    }

    const exactPathCandidates = new Map<string, string>();
    const basenameCandidates = new Map<string, string>();
    const referenceBasename = posix.basename(referenceUrl.pathname);
    const cacheLikeReferenceQuery = hasCacheLikeReferenceQuery(referenceUrl);

    for (const knownResourceUrl of this.#knownResourceUrls) {
      let known: URL;

      try {
        known = new URL(knownResourceUrl);
      } catch {
        continue;
      }

      const knownPath = known.pathname.replace(/^\/+/, '');

      if (known.origin !== this.#currentResourceUrl.origin) {
        continue;
      }

      const exactSearch = known.search === referenceUrl.search;
      const cacheQueryAlias =
        known.search === '' && referenceUrl.search !== '' && cacheLikeReferenceQuery;

      if (!exactSearch && !cacheQueryAlias) {
        continue;
      }

      known.hash = '';
      const canonicalKnownUrl = known.toString();
      const suffix = cacheQueryAlias ? referenceUrl.search : '';

      if (knownPath === referencePath || knownPath.endsWith(`/${referencePath}`)) {
        exactPathCandidates.set(canonicalKnownUrl, suffix);
        continue;
      }

      if (
        allowBasenameMatch &&
        referenceBasename &&
        posix.basename(known.pathname) === referenceBasename
      ) {
        basenameCandidates.set(canonicalKnownUrl, suffix);
      }
    }

    const candidates = exactPathCandidates.size > 0 ? exactPathCandidates : basenameCandidates;

    if (candidates.size !== 1) {
      return undefined;
    }

    const candidate = [...candidates.entries()][0];

    if (!candidate || (candidate[0] === standardResolvedUrl && !candidate[1])) {
      return undefined;
    }

    return {
      canonicalUrl: candidate[0],
      suffix: candidate[1],
    };
  }

  #recordPathAlias(sourceUrl: string, localPath: string): void {
    if (hasSensitiveQuery(sourceUrl)) {
      return;
    }

    for (const aliasKey of resourcePathAliasKeys(sourceUrl)) {
      if (this.#ambiguousPathAliases.has(aliasKey)) {
        continue;
      }

      const existingPath = this.#pathAliases.get(aliasKey);

      if (!existingPath || existingPath === localPath) {
        this.#pathAliases.set(aliasKey, localPath);
        continue;
      }

      this.#pathAliases.delete(aliasKey);
      this.#ambiguousPathAliases.add(aliasKey);
    }
  }

  #recordVolatileQueryAlias(sourceUrl: string, localPath: string): void {
    const aliasKey = volatileQueryAliasKey(sourceUrl);

    if (!aliasKey || this.#ambiguousVolatileQueryAliases.has(aliasKey)) {
      return;
    }

    const existingPath = this.#volatileQueryAliases.get(aliasKey);

    if (!existingPath || existingPath === localPath) {
      this.#volatileQueryAliases.set(aliasKey, localPath);
      return;
    }

    this.#volatileQueryAliases.delete(aliasKey);
    this.#ambiguousVolatileQueryAliases.add(aliasKey);
  }

  #resolveReference(reference: string): ResolvedReference | undefined {
    const trimmed = reference.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      return undefined;
    }

    let url: URL;

    try {
      url = new URL(trimmed, this.#currentResourceUrl);
    } catch {
      return undefined;
    }

    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return undefined;
    }

    const fragment = url.hash;
    url.hash = '';

    return {
      canonicalUrl: url.toString(),
      fragment,
      origin: url.origin,
    };
  }
}

export function createRewriteSession(input: RewriteTextInput): RewriteSession {
  return new RewriteSession(input);
}
