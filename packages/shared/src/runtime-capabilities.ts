export const webGLCompressedTextureFamilies = [
  'astc',
  'atc',
  'bptc',
  'etc',
  'etc1',
  'pvrtc',
  'rgtc',
  's3tc',
  's3tc-srgb',
] as const;

export type WebGLCompressedTextureFamily = (typeof webGLCompressedTextureFamilies)[number];

export interface WebGLRuntimeCapabilities {
  compressedTextureFamilies: readonly WebGLCompressedTextureFamily[];
}

export interface RuntimeCapabilities {
  webgl: WebGLRuntimeCapabilities;
  webgl2: WebGLRuntimeCapabilities;
}

interface RuntimeCapabilityProbe {
  webgl?: {
    extensions?: unknown;
  };
  webgl2?: {
    extensions?: unknown;
  };
}

const webGLCompressedTextureFamilySet = new Set<string>(webGLCompressedTextureFamilies);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

export function compressedTextureFamilyForExtension(
  extensionName: string,
): WebGLCompressedTextureFamily | undefined {
  const normalized = extensionName.trim().toLowerCase();

  if (
    normalized === 'webgl_compressed_texture_astc' ||
    normalized === 'webkit_webgl_compressed_texture_astc'
  ) {
    return 'astc';
  }

  if (normalized === 'webgl_compressed_texture_atc') {
    return 'atc';
  }

  if (normalized === 'ext_texture_compression_bptc') {
    return 'bptc';
  }

  if (
    normalized === 'webgl_compressed_texture_etc' ||
    normalized === 'webgl_compressed_texture_es3_0'
  ) {
    return 'etc';
  }

  if (normalized === 'webgl_compressed_texture_etc1') {
    return 'etc1';
  }

  if (
    normalized === 'webgl_compressed_texture_pvrtc' ||
    normalized === 'webkit_webgl_compressed_texture_pvrtc'
  ) {
    return 'pvrtc';
  }

  if (normalized === 'ext_texture_compression_rgtc') {
    return 'rgtc';
  }

  if (
    normalized === 'webgl_compressed_texture_s3tc' ||
    normalized === 'webkit_webgl_compressed_texture_s3tc' ||
    normalized === 'moz_webgl_compressed_texture_s3tc'
  ) {
    return 's3tc';
  }

  if (normalized === 'webgl_compressed_texture_s3tc_srgb') {
    return 's3tc-srgb';
  }

  return undefined;
}

function normalizedFamilies(value: unknown): WebGLCompressedTextureFamily[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const families = new Set<WebGLCompressedTextureFamily>();

  for (const item of value.slice(0, 128)) {
    if (typeof item !== 'string' || item.length > 128) {
      continue;
    }

    const family = compressedTextureFamilyForExtension(item);

    if (family) {
      families.add(family);
    }
  }

  return [...families].sort();
}

export function runtimeCapabilitiesFromProbe(value: unknown): RuntimeCapabilities | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const probe = value as RuntimeCapabilityProbe;
  const webgl = isRecord(probe.webgl) ? probe.webgl.extensions : undefined;
  const webgl2 = isRecord(probe.webgl2) ? probe.webgl2.extensions : undefined;

  if (webgl === undefined && webgl2 === undefined) {
    return undefined;
  }

  return {
    webgl: {
      compressedTextureFamilies: normalizedFamilies(webgl),
    },
    webgl2: {
      compressedTextureFamilies: normalizedFamilies(webgl2),
    },
  };
}

function isWebGLRuntimeCapabilities(value: unknown): value is WebGLRuntimeCapabilities {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['compressedTextureFamilies']) &&
    Array.isArray(value.compressedTextureFamilies) &&
    value.compressedTextureFamilies.length <= webGLCompressedTextureFamilies.length &&
    value.compressedTextureFamilies.every(
      (family) => typeof family === 'string' && webGLCompressedTextureFamilySet.has(family),
    ) &&
    new Set(value.compressedTextureFamilies).size === value.compressedTextureFamilies.length
  );
}

export function isRuntimeCapabilities(value: unknown): value is RuntimeCapabilities {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['webgl', 'webgl2']) &&
    isWebGLRuntimeCapabilities(value.webgl) &&
    isWebGLRuntimeCapabilities(value.webgl2)
  );
}
