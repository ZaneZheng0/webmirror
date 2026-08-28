import { extname } from 'node:path';

import { normalizeContentType } from './mime.js';
import type { MirrorResourceManifest } from './types.js';
import type { RewriteResourceType } from './rewriter.js';

export function rewriteTypeForResource(
  resource: Pick<MirrorResourceManifest, 'contentType' | 'localPath'>,
): RewriteResourceType | undefined {
  const contentType = normalizeContentType(resource.contentType);
  const extension = extname(resource.localPath ?? '').toLowerCase();

  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
    return 'html';
  }

  if (contentType === 'text/css') {
    return 'css';
  }

  if (
    contentType === 'application/json' ||
    contentType === 'application/manifest+json' ||
    contentType === 'model/gltf+json' ||
    contentType?.endsWith('+json') ||
    extension === '.json' ||
    extension === '.gltf'
  ) {
    return 'json';
  }

  if (
    contentType === 'application/javascript' ||
    contentType === 'application/ecmascript' ||
    contentType === 'text/javascript' ||
    contentType === 'text/ecmascript' ||
    extension === '.js' ||
    extension === '.mjs' ||
    extension === '.cjs'
  ) {
    return 'javascript';
  }

  if (extension === '.html' || extension === '.htm') {
    return 'html';
  }

  return extension === '.css' ? 'css' : undefined;
}
