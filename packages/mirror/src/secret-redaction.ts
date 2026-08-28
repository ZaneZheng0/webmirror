import { parse, type AnyNode, type Program } from 'acorn';
import MagicString from 'magic-string';

export interface JavaScriptCredentialRedaction {
  text: string;
  replacements: number;
  redactedPropertyNames: string[];
}

interface StaticStringNode {
  node: AnyNode;
  value: string;
}

type AstVisitor = (node: AnyNode) => void;

const structuredCredentialPropertyNames = new Set([
  'accesskey',
  'accesskeyid',
  'accesstoken',
  'apikey',
  'authorization',
  'clientsecret',
  'credential',
  'idtoken',
  'password',
  'passwd',
  'privatekey',
  'refreshtoken',
  'session',
  'sessionid',
]);

const ambiguousPublicClientCredentialPropertyNames = new Set([
  'accesskey',
  'accesskeyid',
  'accesstoken',
  'apikey',
  'idtoken',
  'session',
  'sessionid',
]);

function parseJavaScript(text: string): Program | undefined {
  try {
    return parse(text, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
    });
  } catch {
    try {
      return parse(text, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        allowHashBang: true,
        allowReturnOutsideFunction: true,
      });
    } catch {
      return undefined;
    }
  }
}

function isAstNode(value: unknown): value is AnyNode {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate = value as {
    type?: unknown;
    start?: unknown;
    end?: unknown;
  };

  return (
    typeof candidate.type === 'string' &&
    typeof candidate.start === 'number' &&
    typeof candidate.end === 'number'
  );
}

function walkAst(node: AnyNode, visitor: AstVisitor): void {
  visitor(node);

  for (const value of Object.values(node)) {
    if (isAstNode(value)) {
      walkAst(value, visitor);
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) {
          walkAst(item, visitor);
        }
      }
    }
  }
}

function staticString(node: AnyNode | undefined): StaticStringNode | undefined {
  if (!node) {
    return undefined;
  }

  if (node.type === 'Literal' && typeof node.value === 'string') {
    return { node, value: node.value };
  }

  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    const cooked = node.quasis[0]?.value.cooked;

    if (typeof cooked === 'string') {
      return { node, value: cooked };
    }
  }

  return undefined;
}

function staticPropertyName(node: AnyNode): string | undefined {
  if (node.type === 'Identifier') {
    return node.name;
  }

  return node.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
}

function normalizedPropertyName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/gu, '');
}

function isOpaqueCredential(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 20 && /^[A-Za-z0-9._~+/-]+={0,2}$/u.test(trimmed);
}

function isPublicBrowserClientIdentifier(value: string): boolean {
  const trimmed = value.trim();
  return /^AIza[0-9A-Za-z_-]{30,}$/u.test(trimmed) || /^pk\.[0-9A-Za-z._-]{20,}$/u.test(trimmed);
}

function authorizationScheme(value: string): string | undefined {
  const match = /^(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{20,}=*$/iu.exec(value.trim());
  return match?.[1];
}

function isJwt(value: string): boolean {
  return /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u.test(value.trim());
}

function isProviderToken(value: string): boolean {
  return /^(?:AKIA[0-9A-Z]{16}|gh[pousr]_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{40,}|xox[baprs]-[0-9A-Za-z-]{20,}|s[kr][_-](?:live|test)[_-][0-9A-Za-z]{20,}|sk\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}|whsec_[0-9A-Za-z]{20,})$/u.test(
    value.trim(),
  );
}

function isPrivateKey(value: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u.test(value);
}

function shouldRedactStructuredProperty(name: string, value: string): boolean {
  const normalizedName = normalizedPropertyName(name);

  if (normalizedName === 'authorization' || normalizedName === 'proxyauthorization') {
    return authorizationScheme(value) !== undefined;
  }

  if (normalizedName === 'privatekey') {
    return isPrivateKey(value);
  }

  if (
    !structuredCredentialPropertyNames.has(normalizedName) &&
    !normalizedName.endsWith('apikey') &&
    !normalizedName.endsWith('token')
  ) {
    return false;
  }

  if (ambiguousPublicClientCredentialPropertyNames.has(normalizedName)) {
    return (
      !isPublicBrowserClientIdentifier(value) &&
      (isJwt(value) || isProviderToken(value) || isPrivateKey(value))
    );
  }

  if (normalizedName.endsWith('apikey') || normalizedName.endsWith('token')) {
    return !isPublicBrowserClientIdentifier(value) && (isJwt(value) || isProviderToken(value));
  }

  return isOpaqueCredential(value);
}

function replacementFor(value: string): string {
  const scheme = authorizationScheme(value);
  return scheme ? `${scheme} <redacted>` : '<redacted>';
}

export function redactStaticJavaScriptCredentials(text: string): JavaScriptCredentialRedaction {
  const program = parseJavaScript(text);

  if (!program) {
    return {
      text,
      replacements: 0,
      redactedPropertyNames: [],
    };
  }

  const output = new MagicString(text);
  const handledRanges = new Set<string>();
  const redactedPropertyNames = new Set<string>();
  let replacements = 0;

  const redact = (candidate: StaticStringNode | undefined, propertyName?: string): void => {
    if (!candidate) {
      return;
    }

    const range = `${candidate.node.start}:${candidate.node.end}`;

    if (handledRanges.has(range)) {
      return;
    }

    handledRanges.add(range);
    output.overwrite(
      candidate.node.start,
      candidate.node.end,
      JSON.stringify(replacementFor(candidate.value)),
    );
    replacements += 1;

    if (propertyName) {
      redactedPropertyNames.add(normalizedPropertyName(propertyName));
    }
  };

  walkAst(program, (node) => {
    const candidate = staticString(node);

    if (
      candidate &&
      (isPrivateKey(candidate.value) || isJwt(candidate.value) || isProviderToken(candidate.value))
    ) {
      redact(candidate);
    }

    if (node.type !== 'Property' || node.kind !== 'init' || node.computed || node.method) {
      return;
    }

    const propertyName = staticPropertyName(node.key);
    const propertyValue = staticString(node.value);

    if (
      propertyName &&
      propertyValue &&
      shouldRedactStructuredProperty(propertyName, propertyValue.value)
    ) {
      redact(propertyValue, propertyName);
    }
  });

  return {
    text: replacements > 0 ? output.toString() : text,
    replacements,
    redactedPropertyNames: [...redactedPropertyNames].sort(),
  };
}
