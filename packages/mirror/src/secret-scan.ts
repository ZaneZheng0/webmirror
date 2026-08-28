import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { parse, type DefaultTreeAdapterTypes } from 'parse5';

import { normalizeContentType } from './mime.js';

export const maximumSecretScanBytes = 20 * 1024 * 1024;

export type SecretFindingKind =
  | 'private_key'
  | 'authorization_credential'
  | 'jwt'
  | 'cloud_or_provider_token'
  | 'structured_credential'
  | 'password_form_value'
  | 'scan_limit_exceeded';

export interface SecretScanResult {
  scanned: boolean;
  findings: readonly SecretFindingKind[];
}

const textExtensions = new Set([
  '.css',
  '.frag',
  '.glsl',
  '.htm',
  '.html',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.svg',
  '.txt',
  '.vert',
  '.webmanifest',
  '.xml',
]);

const structuredCredentialKeys = new Set([
  'accesskey',
  'accesskeyid',
  'accesstoken',
  'apikey',
  'authorization',
  'clientsecret',
  'cookie',
  'credential',
  'idtoken',
  'password',
  'passwd',
  'privatekey',
  'refreshtoken',
  'session',
  'sessionid',
]);

const ambiguousPublicClientCredentialKeys = new Set([
  'accesskey',
  'accesskeyid',
  'accesstoken',
  'apikey',
]);

const publicConfigurationMarkers = new Set([
  'apiendpoint',
  'apiurl',
  'appid',
  'clientid',
  'domain',
  'endpoint',
  'environment',
  'host',
  'locale',
  'origin',
  'projectid',
  'publickey',
  'region',
  'shopid',
  'siteid',
  'storefront',
  'storefrontid',
  'storefronturl',
  'tenantid',
  'version',
]);

const privateResponseMarkers = new Set([
  'authorization',
  'clientsecret',
  'cookie',
  'expiresin',
  'password',
  'passwd',
  'privatekey',
  'refreshtoken',
  'session',
  'sessionid',
  'tokentype',
]);

const placeholderValues = new Set([
  'changeme',
  'demo',
  'example',
  'placeholder',
  'redacted',
  'replace-me',
  'secret',
  'test',
  'your-token-here',
]);

function normalizedKey(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/gu, '');
}

function looksLikePlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    placeholderValues.has(normalized) ||
    normalized.includes('${') ||
    normalized.includes('<token>') ||
    normalized.includes('process.env') ||
    normalized.startsWith('your_')
  );
}

function looksLikePublicBrowserClientIdentifier(value: string): boolean {
  return (
    /^AIza[0-9A-Za-z_-]{30,}$/u.test(value) ||
    /^pk\.[0-9A-Za-z._-]{20,}$/u.test(value) ||
    /^pk_(?:live|test)_[0-9A-Za-z]{16,}$/u.test(value)
  );
}

function looksLikePublicConfigurationObject(value: Record<string, unknown>): boolean {
  const keys = new Set(Object.keys(value).map(normalizedKey));

  if ([...keys].some((key) => privateResponseMarkers.has(key))) {
    return false;
  }

  let markerCount = 0;

  for (const key of keys) {
    if (publicConfigurationMarkers.has(key)) {
      markerCount += 1;
    }
  }

  return markerCount >= 2;
}

function looksLikeCredentialValue(key: string, value: string): boolean {
  const trimmed = value.trim();

  if (!trimmed || looksLikePlaceholder(trimmed)) {
    return false;
  }

  if (key === 'privatekey') {
    return /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u.test(trimmed);
  }

  if (key === 'authorization') {
    return /^(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{20,}=*$/iu.test(trimmed);
  }

  if (
    ambiguousPublicClientCredentialKeys.has(key) &&
    looksLikePublicBrowserClientIdentifier(trimmed)
  ) {
    return false;
  }

  if (key.endsWith('token') || key === 'apikey' || key === 'accesskeyid') {
    return trimmed.length >= 20 && /^[A-Za-z0-9._~+/-]+={0,2}$/u.test(trimmed);
  }

  return trimmed.length >= 12;
}

function genericFindings(
  text: string,
  includeAmbiguousStructuredCredentials: boolean,
): SecretFindingKind[] {
  const findings: SecretFindingKind[] = [];

  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u.test(text)) {
    findings.push('private_key');
  }

  if (/\b(?:Authorization\s*[:=]\s*)?(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{20,}=*/iu.test(text)) {
    findings.push('authorization_credential');
  }

  if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(text)) {
    findings.push('jwt');
  }

  if (
    /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{40,}|xox[baprs]-[0-9A-Za-z-]{20,}|s[kr][_-](?:live|test)[_-][0-9A-Za-z]{20,}|sk\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}|whsec_[0-9A-Za-z]{20,})\b/u.test(
      text,
    )
  ) {
    findings.push('cloud_or_provider_token');
  }

  const structuredCredentialPattern =
    /["']?(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|session[_-]?id|password|passwd)["']?\s*[:=]\s*(["'])([A-Za-z0-9._~+/-]{20,}={0,2})\2/giu;

  for (const match of text.matchAll(structuredCredentialPattern)) {
    const key = normalizedKey(match[1] ?? '');
    const value = match[3];

    if (
      value &&
      (includeAmbiguousStructuredCredentials || !ambiguousPublicClientCredentialKeys.has(key)) &&
      looksLikeCredentialValue(key, value)
    ) {
      findings.push('structured_credential');
      break;
    }
  }

  return findings;
}

interface JsonFindingsResult {
  parsed: boolean;
  findings: SecretFindingKind[];
}

function jsonFindings(text: string): JsonFindingsResult {
  let value: unknown;

  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { parsed: false, findings: [] };
  }

  const findings: SecretFindingKind[] = [];
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let inspectedNodes = 0;

  while (stack.length > 0 && inspectedNodes < 100_000) {
    const current = stack.pop();

    if (!current || current.depth > 64) {
      continue;
    }

    inspectedNodes += 1;

    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }

    if (typeof current.value !== 'object' || current.value === null) {
      continue;
    }

    const objectValue = current.value as Record<string, unknown>;
    const publicConfiguration = looksLikePublicConfigurationObject(objectValue);

    for (const [rawKey, child] of Object.entries(objectValue)) {
      const key = normalizedKey(rawKey);

      if (
        structuredCredentialKeys.has(key) &&
        typeof child === 'string' &&
        looksLikeCredentialValue(key, child) &&
        !(publicConfiguration && ambiguousPublicClientCredentialKeys.has(key))
      ) {
        findings.push('structured_credential');
      }

      stack.push({ value: child, depth: current.depth + 1 });
    }
  }

  return { parsed: true, findings };
}

function isElement(node: DefaultTreeAdapterTypes.Node): node is DefaultTreeAdapterTypes.Element {
  return 'tagName' in node && Array.isArray(node.attrs);
}

function attribute(element: DefaultTreeAdapterTypes.Element, name: string): string | undefined {
  return element.attrs.find((candidate) => candidate.name === name)?.value;
}

function htmlFindings(text: string): SecretFindingKind[] {
  let document: DefaultTreeAdapterTypes.Document;

  try {
    document = parse(text);
  } catch {
    return [];
  }

  const findings: SecretFindingKind[] = [];
  const stack: DefaultTreeAdapterTypes.Node[] = [document];

  while (stack.length > 0) {
    const node = stack.pop();

    if (!node) {
      continue;
    }

    if (isElement(node)) {
      if (node.tagName === 'input') {
        const type = (attribute(node, 'type') ?? 'text').toLowerCase();
        const name = normalizedKey(attribute(node, 'name') ?? '');
        const value = attribute(node, 'value') ?? '';

        if (type === 'password' && value && !looksLikePlaceholder(value)) {
          findings.push('password_form_value');
        } else if (
          type === 'hidden' &&
          structuredCredentialKeys.has(name) &&
          looksLikeCredentialValue(name, value)
        ) {
          findings.push('structured_credential');
        }
      }

      if (node.tagName === 'meta') {
        const name = normalizedKey(attribute(node, 'name') ?? '');
        const content = attribute(node, 'content') ?? '';

        if (structuredCredentialKeys.has(name) && looksLikeCredentialValue(name, content)) {
          findings.push('structured_credential');
        }
      }
    }

    if ('childNodes' in node) {
      stack.push(...node.childNodes);
    }

    if (isElement(node) && node.tagName === 'template' && 'content' in node) {
      stack.push(node.content);
    }
  }

  return findings;
}

function isTextResource(contentType: string | undefined, localPath: string): boolean {
  const normalized = normalizeContentType(contentType) ?? '';

  return (
    normalized.startsWith('text/') ||
    normalized === 'application/json' ||
    normalized === 'application/ld+json' ||
    normalized === 'application/javascript' ||
    normalized === 'application/x-javascript' ||
    normalized === 'application/xml' ||
    normalized.endsWith('+json') ||
    normalized.endsWith('+xml') ||
    textExtensions.has(extname(localPath).toLowerCase())
  );
}

function sniffText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  }

  let text: string;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }

  if (text.length === 0) {
    return '';
  }

  let printable = 0;
  let characters = 0;

  for (const character of text) {
    characters += 1;
    const code = character.codePointAt(0) ?? 0;

    if (
      character === '\n' ||
      character === '\r' ||
      character === '\t' ||
      (code >= 0x20 && code !== 0x7f)
    ) {
      printable += 1;
    }
  }

  return characters > 0 && printable / characters >= 0.9 ? text : undefined;
}

export async function scanFileForHighConfidenceSecrets(
  filePath: string,
  contentType: string | undefined,
  localPath: string,
): Promise<SecretScanResult> {
  const metadata = await stat(filePath);
  const declaredText = isTextResource(contentType, localPath);

  if (metadata.size > maximumSecretScanBytes) {
    if (!declaredText) {
      return { scanned: false, findings: [] };
    }

    return {
      scanned: false,
      findings: ['scan_limit_exceeded'],
    };
  }

  const bytes = await readFile(filePath);
  const text = declaredText ? bytes.toString('utf8') : sniffText(bytes);

  if (text === undefined) {
    return { scanned: false, findings: [] };
  }

  const normalized = normalizeContentType(contentType) ?? '';
  const trimmed = text.trimStart();
  const strictStructuredCredentials =
    normalized === 'application/json' ||
    normalized === 'application/ld+json' ||
    normalized.endsWith('+json') ||
    ['.json', '.map', '.webmanifest'].includes(extname(localPath).toLowerCase()) ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[');
  const structured = strictStructuredCredentials
    ? jsonFindings(text)
    : { parsed: false, findings: [] };
  const findings = new Set<SecretFindingKind>(
    genericFindings(text, strictStructuredCredentials && !structured.parsed),
  );

  if (strictStructuredCredentials) {
    for (const finding of structured.findings) {
      findings.add(finding);
    }
  }

  if (
    normalized === 'text/html' ||
    ['.htm', '.html'].includes(extname(localPath).toLowerCase()) ||
    /^<(?:!doctype\s+html|html|head|body)\b/iu.test(trimmed)
  ) {
    for (const finding of htmlFindings(text)) {
      findings.add(finding);
    }
  }

  return {
    scanned: true,
    findings: [...findings],
  };
}
