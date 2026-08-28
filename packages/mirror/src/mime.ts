import { extname } from 'node:path';

const extensionToMime: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.bin': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.dds': 'image/vnd-ms.dds',
  '.eot': 'application/vnd.ms-fontobject',
  '.gif': 'image/gif',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.hdr': 'image/vnd.radiance',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ktx': 'image/ktx',
  '.ktx2': 'image/ktx2',
  '.m4a': 'audio/mp4',
  '.mjs': 'application/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.srt': 'application/x-subrip; charset=utf-8',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
};

const mimeToExtension: Readonly<Record<string, string>> = {
  'application/javascript': '.js',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/srt': '.srt',
  'application/wasm': '.wasm',
  'application/x-srt': '.srt',
  'application/x-subrip': '.srt',
  'application/xml': '.xml',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'font/otf': '.otf',
  'font/ttf': '.ttf',
  'font/woff': '.woff',
  'font/woff2': '.woff2',
  'image/avif': '.avif',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/ktx': '.ktx',
  'image/ktx2': '.ktx2',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/vnd-ms.dds': '.dds',
  'image/vnd.radiance': '.hdr',
  'image/webp': '.webp',
  'model/gltf+json': '.gltf',
  'model/gltf-binary': '.glb',
  'text/css': '.css',
  'text/html': '.html',
  'text/javascript': '.js',
  'text/plain': '.txt',
  'text/vtt': '.vtt',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

export function normalizeContentType(contentType: string | undefined): string | undefined {
  const normalized = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}

export function extensionForContentType(contentType: string | undefined): string | undefined {
  const normalized = normalizeContentType(contentType);
  return normalized ? mimeToExtension[normalized] : undefined;
}

export function contentTypeForPath(filePath: string, manifestType?: string): string {
  if (manifestType) {
    return manifestType;
  }

  return extensionToMime[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}
