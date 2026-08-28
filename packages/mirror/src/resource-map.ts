import { posix } from 'node:path';

import { isSensitiveQueryName } from '@webmirror/shared';

import type { MirrorResourceManifest } from './types.js';
import { canonicalizeResourceUrl } from './url-mapper.js';

export const imageRenditionQueryParameterNames = [
  'dpr',
  'h',
  'height',
  'quality',
  'w',
  'width',
] as const;

export const imageRenditionNeutralQueryParameterValues: Readonly<
  Record<string, readonly string[]>
> = {
  crop: ['center', 'centre'],
};

const imageRenditionAliasStore = Symbol('webmirror.imageRenditionAliases');
const imageRenditionQueryParameterNameSet = new Set<string>(imageRenditionQueryParameterNames);
const imageRenditionNeutralQueryParameterValueSets = new Map(
  Object.entries(imageRenditionNeutralQueryParameterValues).map(([name, values]) => [
    name,
    new Set(values),
  ]),
);
const imageExtensions = new Set([
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

interface ResourceUrlMapWithImageRenditionAliases extends ReadonlyMap<string, string> {
  readonly [imageRenditionAliasStore]: ReadonlyMap<string, string>;
}

interface NormalizedImageRenditionUrl {
  canonicalUrl: string;
  identityUrl: string;
  transformed: boolean;
  effectiveWidth: number;
  effectiveHeight: number;
  pixelScore: number;
  maximumDimension: number;
  quality: number;
}

export interface ImageRenditionTarget {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

interface ImageRenditionCandidate extends NormalizedImageRenditionUrl {
  localPath: string;
  size: number;
}

interface ImageRenditionGroup {
  candidate?: ImageRenditionCandidate;
}

interface VolatileQueryCandidate {
  localPath: string;
  sha256?: string;
}

function positiveQueryNumber(url: URL, names: ReadonlySet<string>): number {
  let maximum = 0;

  for (const [name, value] of url.searchParams) {
    if (!names.has(name.toLowerCase())) {
      continue;
    }

    const parsed = Number.parseFloat(value);

    if (Number.isFinite(parsed) && parsed > maximum) {
      maximum = parsed;
    }
  }

  return maximum;
}

function isNeutralImageRenditionQueryParameter(name: string, value: string): boolean {
  const normalizedName = name.toLowerCase();

  return (
    imageRenditionQueryParameterNameSet.has(normalizedName) ||
    imageRenditionNeutralQueryParameterValueSets
      .get(normalizedName)
      ?.has(value.trim().toLowerCase()) === true
  );
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

function volatileQueryAliasKey(value: string): string | undefined {
  const url = new URL(value);

  if (!url.search || [...url.searchParams.keys()].some(isSensitiveQueryName)) {
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

function normalizeImageRenditionUrl(value: string): NormalizedImageRenditionUrl {
  const canonicalUrl = canonicalizeResourceUrl(value);
  const url = new URL(canonicalUrl);
  const width = positiveQueryNumber(url, new Set(['w', 'width']));
  const height = positiveQueryNumber(url, new Set(['h', 'height']));
  const dpr = positiveQueryNumber(url, new Set(['dpr'])) || 1;
  const quality = positiveQueryNumber(url, new Set(['quality']));
  let transformed = false;
  const retainedSearchParameters = new URLSearchParams();

  for (const [name, parameterValue] of url.searchParams) {
    if (!isNeutralImageRenditionQueryParameter(name, parameterValue)) {
      retainedSearchParameters.append(name, parameterValue);
      continue;
    }

    transformed = true;
  }

  if (transformed) {
    url.search = retainedSearchParameters.toString();
  }

  const effectiveWidth = width * dpr;
  const effectiveHeight = height * dpr;
  const maximumDimension = Math.max(effectiveWidth, effectiveHeight);
  const pixelScore =
    effectiveWidth > 0 && effectiveHeight > 0
      ? effectiveWidth * effectiveHeight
      : maximumDimension * maximumDimension;

  return {
    canonicalUrl,
    identityUrl: url.toString(),
    transformed,
    effectiveWidth,
    effectiveHeight,
    pixelScore,
    maximumDimension,
    quality,
  };
}

function isImageResource(
  resource: Pick<MirrorResourceManifest, 'contentType'>,
  value: string,
): boolean {
  const contentType = resource.contentType?.split(';', 1)[0]?.trim().toLowerCase();

  if (contentType?.startsWith('image/')) {
    return true;
  }

  return imageExtensions.has(posix.extname(new URL(value).pathname).toLowerCase());
}

function isBetterImageRenditionCandidate(
  candidate: ImageRenditionCandidate,
  existing: ImageRenditionCandidate | undefined,
  target?: ImageRenditionTarget,
): boolean {
  if (!existing) {
    return true;
  }

  if (target) {
    const scale = target.deviceScaleFactor ?? 1;
    const targetWidth = target.width * scale;
    const targetHeight = target.height * scale;
    const targetMaximumDimension = Math.max(targetWidth, targetHeight);
    const candidateHasDimensions = candidate.effectiveWidth > 0 || candidate.effectiveHeight > 0;
    const existingHasDimensions = existing.effectiveWidth > 0 || existing.effectiveHeight > 0;

    if (candidateHasDimensions !== existingHasDimensions) {
      return candidateHasDimensions;
    }

    if (candidateHasDimensions && existingHasDimensions) {
      const isSufficient = (value: ImageRenditionCandidate): boolean =>
        (value.effectiveWidth <= 0 || value.effectiveWidth >= targetWidth) &&
        (value.effectiveHeight <= 0 || value.effectiveHeight >= targetHeight);
      const candidateSufficient = isSufficient(candidate);
      const existingSufficient = isSufficient(existing);

      if (candidateSufficient !== existingSufficient) {
        return candidateSufficient;
      }

      const candidateDistance =
        candidate.effectiveWidth > 0 && candidate.effectiveHeight > 0
          ? Math.abs(candidate.pixelScore - targetWidth * targetHeight)
          : Math.abs(candidate.maximumDimension - targetMaximumDimension);
      const existingDistance =
        existing.effectiveWidth > 0 && existing.effectiveHeight > 0
          ? Math.abs(existing.pixelScore - targetWidth * targetHeight)
          : Math.abs(existing.maximumDimension - targetMaximumDimension);

      if (candidateDistance !== existingDistance) {
        return candidateDistance < existingDistance;
      }

      if (candidate.pixelScore !== existing.pixelScore) {
        return candidateSufficient
          ? candidate.pixelScore < existing.pixelScore
          : candidate.pixelScore > existing.pixelScore;
      }

      if (candidate.maximumDimension !== existing.maximumDimension) {
        return candidateSufficient
          ? candidate.maximumDimension < existing.maximumDimension
          : candidate.maximumDimension > existing.maximumDimension;
      }
    }
  }

  const candidateScores = [
    candidate.transformed ? 0 : 1,
    candidate.pixelScore,
    candidate.maximumDimension,
    candidate.quality,
    candidate.size,
  ];
  const existingScores = [
    existing.transformed ? 0 : 1,
    existing.pixelScore,
    existing.maximumDimension,
    existing.quality,
    existing.size,
  ];

  for (let index = 0; index < candidateScores.length; index += 1) {
    const candidateScore = candidateScores[index] ?? 0;
    const existingScore = existingScores[index] ?? 0;

    if (candidateScore !== existingScore) {
      return candidateScore > existingScore;
    }
  }

  return candidate.canonicalUrl.localeCompare(existing.canonicalUrl) < 0;
}

export function canonicalizeImageRenditionIdentity(value: string): string {
  return normalizeImageRenditionUrl(value).identityUrl;
}

export function imageRenditionIdentity(value: string): string {
  return normalizeImageRenditionUrl(value).identityUrl;
}

export function isPreferredImageRenditionUrl(
  candidateValue: string,
  existingValue: string,
  target?: ImageRenditionTarget,
): boolean {
  const candidate = normalizeImageRenditionUrl(candidateValue);
  const existing = normalizeImageRenditionUrl(existingValue);

  if (candidate.identityUrl !== existing.identityUrl) {
    throw new TypeError('Image rendition URLs must share the same normalized identity.');
  }

  return isBetterImageRenditionCandidate(
    {
      ...candidate,
      localPath: '',
      size: 0,
    },
    {
      ...existing,
      localPath: '',
      size: 0,
    },
    target,
  );
}

export function getImageRenditionAliases(
  mapping: unknown,
): ReadonlyMap<string, string> | undefined {
  if (!mapping || typeof mapping !== 'object') {
    return undefined;
  }

  return (mapping as Partial<ResourceUrlMapWithImageRenditionAliases>)[imageRenditionAliasStore];
}

export function createDownloadedResourceUrlMap(
  resources: readonly MirrorResourceManifest[],
): ReadonlyMap<string, string> {
  const mapping = new Map<string, string>();
  const renditionGroups = new Map<string, ImageRenditionGroup>();
  const volatileQueryGroups = new Map<string, Map<string, VolatileQueryCandidate>>();

  for (const resource of resources) {
    if (resource.status !== 'downloaded' || !resource.localPath) {
      continue;
    }

    const resourceUrls = new Set([resource.canonicalUrl]);

    if (resource.finalUrl) {
      resourceUrls.add(resource.finalUrl);
    }

    for (const value of resourceUrls) {
      const canonicalUrl = canonicalizeResourceUrl(value);
      mapping.set(canonicalUrl, resource.localPath);
      const volatileAliasKey = volatileQueryAliasKey(canonicalUrl);

      if (volatileAliasKey) {
        const candidates = volatileQueryGroups.get(volatileAliasKey) ?? new Map();
        candidates.set(canonicalUrl, {
          localPath: resource.localPath,
          ...(resource.sha256 ? { sha256: resource.sha256 } : {}),
        });
        volatileQueryGroups.set(volatileAliasKey, candidates);
      }

      if (!isImageResource(resource, canonicalUrl)) {
        continue;
      }

      const normalized = normalizeImageRenditionUrl(canonicalUrl);
      const group = renditionGroups.get(normalized.identityUrl) ?? {};
      const candidate: ImageRenditionCandidate = {
        ...normalized,
        localPath: resource.localPath,
        size: resource.size ?? 0,
      };

      if (isBetterImageRenditionCandidate(candidate, group.candidate)) {
        group.candidate = candidate;
      }

      renditionGroups.set(normalized.identityUrl, group);
    }
  }

  for (const candidates of volatileQueryGroups.values()) {
    const localPaths = new Set([...candidates.values()].map((candidate) => candidate.localPath));

    if (localPaths.size <= 1) {
      continue;
    }

    const candidateValues = [...candidates.values()];
    const hashes = new Set(
      candidateValues
        .map((candidate) => candidate.sha256)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    );

    if (hashes.size !== 1 || candidateValues.some((candidate) => !candidate.sha256)) {
      continue;
    }

    const preferred = [...candidates.entries()].sort(([leftUrl], [rightUrl]) =>
      leftUrl.localeCompare(rightUrl),
    )[0]?.[1];

    if (!preferred) {
      continue;
    }

    for (const candidateUrl of candidates.keys()) {
      mapping.set(candidateUrl, preferred.localPath);
    }
  }

  const imageRenditionAliases = new Map<string, string>();

  for (const [identityUrl, group] of renditionGroups) {
    if (group.candidate) {
      imageRenditionAliases.set(identityUrl, group.candidate.localPath);
    }
  }

  Object.defineProperty(mapping, imageRenditionAliasStore, {
    configurable: false,
    enumerable: false,
    value: imageRenditionAliases,
    writable: false,
  });

  return mapping;
}
