import { isSensitiveQueryName } from '@webmirror/shared';

import {
  createRewriteSession,
  hasLikelyStaticAssetShape,
  type RewriteResult,
  type RewriteSession,
  type RewriteTextInput,
} from './rewriter-core.js';

const assetReferenceKeys = new Set([
  'asset',
  'assets',
  'audio',
  'audios',
  'buffer',
  'buffers',
  'file',
  'files',
  'font',
  'fonts',
  'image',
  'images',
  'manifest',
  'model',
  'models',
  'resource',
  'resources',
  'sound',
  'sounds',
  'source',
  'sources',
  'src',
  'texture',
  'textures',
  'uri',
  'video',
  'videos',
  'wasm',
  'worker',
  'workers',
]);
const runtimeManifestReferenceKeys = new Set([
  'chunk',
  'chunks',
  'css',
  'import',
  'imports',
  'module',
  'modules',
  'stylesheet',
  'stylesheets',
]);
const maxJsonRewriteDepth = 256;
const navigationReferenceKeys = new Set(['href', 'link', 'route', 'url', 'website']);
const structuredAssetDescriptorKeys = new Set([
  'compressed',
  'hotreload',
  'prefix',
  'relative',
  'usecompressed',
]);

function isExplicitAbsoluteStaticAssetReference(value: string): boolean {
  const trimmed = value.trim();

  if (
    (!trimmed.startsWith('http://') &&
      !trimmed.startsWith('https://') &&
      !trimmed.startsWith('//')) ||
    !hasLikelyStaticAssetShape(trimmed)
  ) {
    return false;
  }

  try {
    const url = new URL(trimmed, 'https://webmirror.invalid/');
    const extension = url.pathname.slice(url.pathname.lastIndexOf('.')).toLowerCase();
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      extension !== '.htm' &&
      extension !== '.html' &&
      ![...url.searchParams.keys()].some(isSensitiveQueryName)
    );
  } catch {
    return false;
  }
}

function isAssetReferenceKey(value: string): boolean {
  const normalized = value.toLowerCase().replaceAll('-', '').replaceAll('_', '');

  if (assetReferenceKeys.has(normalized)) {
    return true;
  }

  return (
    normalized.endsWith('url') && [...assetReferenceKeys].some((key) => normalized.startsWith(key))
  );
}

function isNavigationReferenceKey(value: string): boolean {
  return navigationReferenceKeys.has(value.toLowerCase().replaceAll('-', '').replaceAll('_', ''));
}

function isRuntimeManifestReferenceKey(value: string): boolean {
  return runtimeManifestReferenceKeys.has(
    value.toLowerCase().replaceAll('-', '').replaceAll('_', ''),
  );
}

function isStructuredAssetDescriptor(value: Record<string, unknown>): boolean {
  return (
    typeof value.src === 'string' &&
    Object.keys(value).some((key) =>
      structuredAssetDescriptorKeys.has(key.toLowerCase().replaceAll('-', '').replaceAll('_', '')),
    )
  );
}

function rewriteJsonValue(
  value: unknown,
  session: RewriteSession,
  assetReference = false,
  runtimeManifestReference = false,
  depth = 0,
): unknown {
  if (depth > maxJsonRewriteDepth) {
    throw new TypeError(`JSON nesting exceeds the ${maxJsonRewriteDepth}-level rewrite limit`);
  }

  if (typeof value === 'string') {
    if (runtimeManifestReference) {
      return session.rewriteRuntimeManifestString(value);
    }

    if (assetReference) {
      return session.rewriteManifestStaticString(value);
    }

    return isExplicitAbsoluteStaticAssetReference(value)
      ? session.rewriteStaticString(value)
      : session.rewriteMappedStaticString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      rewriteJsonValue(item, session, assetReference, runtimeManifestReference, depth + 1),
    );
  }

  if (value !== null && typeof value === 'object') {
    const rewritten: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const entries = Object.entries(value);
    const structuredAssetDescriptor = isStructuredAssetDescriptor(value as Record<string, unknown>);

    for (const [key, item] of entries) {
      if (
        structuredAssetDescriptor &&
        key.toLowerCase().replaceAll('-', '').replaceAll('_', '') === 'src' &&
        typeof item === 'string'
      ) {
        rewritten[key] = session.rewriteProvenManifestStaticString(item);
        continue;
      }

      const nestedContainer = item !== null && typeof item === 'object';
      const directRuntimeManifestReference = isRuntimeManifestReferenceKey(key);
      const directAssetReference =
        isAssetReferenceKey(key) ||
        (assetReference && (nestedContainer || !isNavigationReferenceKey(key)));
      rewritten[key] = rewriteJsonValue(
        item,
        session,
        directAssetReference,
        directRuntimeManifestReference,
        depth + 1,
      );
    }

    return rewritten;
  }

  return value;
}

export function rewriteJsonTextWithSession(text: string, session: RewriteSession): string {
  const parsed: unknown = JSON.parse(text);
  const rewritten = JSON.stringify(rewriteJsonValue(parsed, session));
  const trailingNewline = text.endsWith('\n') ? '\n' : '';
  return `${rewritten}${trailingNewline}`;
}

export function rewriteJson(input: RewriteTextInput): RewriteResult {
  const session = createRewriteSession(input);
  return session.result(rewriteJsonTextWithSession(input.text, session));
}
