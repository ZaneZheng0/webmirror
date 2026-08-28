export const sensitiveQueryNames = [
  'accesskey',
  'accesstoken',
  'apikey',
  'auth',
  'authorization',
  'bearer',
  'clientsecret',
  'code',
  'codeverifier',
  'credential',
  'idtoken',
  'jwt',
  'key',
  'password',
  'passwd',
  'pwd',
  'refreshtoken',
  'secret',
  'session',
  'sessionid',
  'sid',
  'sig',
  'signature',
  'token',
] as const;

const exactSensitiveQueryNames = new Set<string>(sensitiveQueryNames);

function normalizedQueryName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/gu, '');
}

export function isSensitiveQueryName(value: string): boolean {
  const normalized = normalizedQueryName(value);
  return (
    exactSensitiveQueryNames.has(normalized) ||
    normalized.endsWith('token') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('password') ||
    normalized.endsWith('signature') ||
    normalized.endsWith('credential')
  );
}

export function redactSensitiveUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return redactSensitiveText(value);
  }

  if (url.username) {
    url.username = 'REDACTED';
  }

  if (url.password) {
    url.password = 'REDACTED';
  }

  for (const key of [...url.searchParams.keys()]) {
    if (isSensitiveQueryName(key)) {
      url.searchParams.set(key, 'REDACTED');
    }
  }

  if (url.hash) {
    const fragment = url.hash.slice(1);
    const redactedFragment = fragment.replace(
      /(^|[?&;])([^=?&;]+)=([^&;]*)/gu,
      (match, separator: string, rawName: string) => {
        let name = rawName;

        try {
          name = decodeURIComponent(rawName);
        } catch {
          // Use the raw fragment key when percent-decoding fails.
        }

        return isSensitiveQueryName(name) ? `${separator}${rawName}=REDACTED` : match;
      },
    );
    url.hash = redactedFragment;
  }

  return url.toString();
}

export function redactSensitiveText(value: string): string {
  return value
    .replaceAll(
      /(authorization\s*[:=]\s*)(?:Bearer\s+[A-Za-z0-9._~+/-]+=*|Basic\s+[A-Za-z0-9+/]+=*)/giu,
      '$1REDACTED',
    )
    .replaceAll(/Bearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer REDACTED')
    .replaceAll(/Basic\s+[A-Za-z0-9+/]+=*/giu, 'Basic REDACTED')
    .replaceAll(
      /(["']?(?:password|passwd|pwd|token|secret|api[-_]?key|authorization|cookie|session|credential)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/giu,
      '$1REDACTED',
    );
}
