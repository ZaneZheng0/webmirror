import { createHash } from 'node:crypto';
import { isAbsolute, posix, resolve, sep, win32 } from 'node:path';

import { redactSensitiveUrl } from '@webmirror/shared';

import { MirrorSecurityError } from './errors.js';
import { extensionForContentType } from './mime.js';

export interface MapUrlOptions {
  sourceOrigin?: string;
  contentType?: string;
}

const windowsReservedNames = new Set([
  'aux',
  'clock$',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'con',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
  'nul',
  'prn',
]);

function hashText(value: string, length = 12): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function escapePathSegment(segment: string): string {
  const decoded = decodePathSegment(segment);
  const characters = [...decoded];
  const lastSeparatorIndex = Math.max(characters.lastIndexOf('/'), characters.lastIndexOf('\\'));
  let escaped = '';

  for (const [index, character] of characters.entries()) {
    const codePoint = character.codePointAt(0) ?? -1;
    const isAsciiLetterOrNumber =
      (codePoint >= 48 && codePoint <= 57) ||
      (codePoint >= 65 && codePoint <= 90) ||
      (codePoint >= 97 && codePoint <= 122);
    const isSafePunctuation =
      (character === '.' && index > lastSeparatorIndex) || character === '_' || character === '-';

    if (isAsciiLetterOrNumber || isSafePunctuation) {
      escaped += character;
      continue;
    }

    for (const byte of Buffer.from(character, 'utf8')) {
      escaped += `~${byte.toString(16)}`;
    }
  }

  if (!escaped || escaped === '.' || escaped === '..') {
    escaped = `_segment-${hashText(decoded, 8)}`;
  }

  const basename = escaped.split('.', 1)[0]?.toLowerCase();

  if (basename && windowsReservedNames.has(basename)) {
    escaped = `~r-${escaped}`;
  }

  if (escaped.length > 100) {
    const extension = posix.extname(escaped);
    const stemLength = Math.max(1, 80 - extension.length);
    escaped = `${escaped.slice(0, stemLength)}~${hashText(decoded, 12)}${extension}`;
  }

  return escaped;
}

function appendQueryHash(fileName: string, search: string): string {
  if (!search) {
    return fileName;
  }

  const extension = posix.extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  return `${stem}~q-${hashText(search)}${extension}`;
}

function appendContentExtension(fileName: string, contentType: string | undefined): string {
  if (posix.extname(fileName)) {
    return fileName;
  }

  return `${fileName}${extensionForContentType(contentType) ?? ''}`;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint < 32;
  });
}

export function parseResourceUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new MirrorSecurityError('DANGEROUS_PROTOCOL', `Invalid resource URL: ${value}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MirrorSecurityError(
      'DANGEROUS_PROTOCOL',
      `Only http and https resources can be mirrored: ${url.protocol}`,
    );
  }

  if (url.username || url.password) {
    throw new MirrorSecurityError(
      'URL_CREDENTIALS',
      'Resource URLs containing credentials are not allowed',
    );
  }

  url.hash = '';
  return url;
}

export function canonicalizeResourceUrl(value: string): string {
  return parseResourceUrl(value).toString();
}

export function mapUrlToLocalPath(value: string, options: MapUrlOptions = {}): string {
  const url = parseResourceUrl(value);
  const sourceOrigin = options.sourceOrigin
    ? parseResourceUrl(options.sourceOrigin).origin
    : undefined;
  const sameOrigin = sourceOrigin === url.origin;
  const scheme = url.protocol.slice(0, -1);
  const host = escapePathSegment(url.hostname);
  const originDirectory = url.port ? `${host}~p-${url.port}` : host;
  const prefix = sameOrigin
    ? ['site']
    : ['site', '_external', escapePathSegment(scheme), originDirectory];

  const rawSegments = url.pathname.split('/').filter(Boolean);
  const segments = rawSegments.map(escapePathSegment);
  const isDirectory = url.pathname.endsWith('/');

  if (segments.length === 0 || isDirectory) {
    segments.push('index');
  }

  const lastIndex = segments.length - 1;
  const currentFileName = segments[lastIndex];

  if (!currentFileName) {
    throw new MirrorSecurityError('INVALID_LOCAL_PATH', 'Could not derive a local file name');
  }

  const withExtension = appendContentExtension(
    currentFileName,
    options.contentType ?? (isDirectory ? 'text/html' : undefined),
  );
  const redactedSearch = new URL(redactSensitiveUrl(url.toString())).search;
  segments[lastIndex] = appendQueryHash(withExtension, redactedSearch);

  return posix.join(...prefix, ...segments);
}

export function resolvePathInsideRoot(rootDirectory: string, localPath: string): string {
  if (
    !localPath ||
    localPath.includes('\0') ||
    localPath.includes('\\') ||
    isAbsolute(localPath) ||
    win32.isAbsolute(localPath)
  ) {
    throw new MirrorSecurityError('INVALID_LOCAL_PATH', 'Local path must be a relative POSIX path');
  }

  const segments = localPath.split('/');

  if (
    segments.some((segment) => {
      const basename = segment.split('.', 1)[0]?.toLowerCase();
      return (
        !segment ||
        segment === '.' ||
        segment === '..' ||
        /[<>:"|?*]/u.test(segment) ||
        hasControlCharacter(segment) ||
        /[ .]$/u.test(segment) ||
        (basename !== undefined && windowsReservedNames.has(basename))
      );
    })
  ) {
    throw new MirrorSecurityError('INVALID_LOCAL_PATH', 'Local path contains unsafe segments');
  }

  const root = resolve(rootDirectory);
  const candidate = resolve(root, ...segments);
  const rootPrefix = `${root}${sep}`;

  if (candidate !== root && !candidate.startsWith(rootPrefix)) {
    throw new MirrorSecurityError('PATH_OUTSIDE_ROOT', 'Local path escapes the mirror root');
  }

  return candidate;
}
