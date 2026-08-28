import postcss from 'postcss';
import valueParser from 'postcss-value-parser';

import {
  createRewriteSession,
  type LocalReferenceStyle,
  type RewriteResult,
  type RewriteSession,
  type RewriteTextInput,
} from './rewriter-core.js';

type ParsedCssValue = ReturnType<typeof valueParser>;
type CssValueNode = ParsedCssValue['nodes'][number];
type CssFunctionNode = Extract<CssValueNode, { type: 'function' }>;

function significantValueNodes(nodes: CssValueNode[]): CssValueNode[] {
  return nodes.filter((node) => node.type !== 'space' && node.type !== 'comment');
}

function escapeCssString(value: string, quote: '"' | "'"): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(quote, `\\${quote}`)
    .replaceAll('\r\n', '\\a ')
    .replaceAll('\n', '\\a ')
    .replaceAll('\r', '\\a ');
}

function replaceFunctionUrl(node: CssFunctionNode, value: string): void {
  const quote = '"';
  node.before = '';
  node.after = '';
  node.nodes = [
    {
      type: 'string',
      quote,
      value: escapeCssString(value, quote),
      sourceIndex: node.sourceIndex,
      sourceEndIndex: node.sourceEndIndex,
    },
  ];
}

function rewriteUrlFunctions(
  parsedValue: ParsedCssValue,
  session: RewriteSession,
  style: LocalReferenceStyle,
): void {
  parsedValue.walk((node) => {
    if (node.type !== 'function' || node.value.toLowerCase() !== 'url') {
      return;
    }

    const nodes = significantValueNodes(node.nodes);

    if (nodes.length !== 1) {
      return false;
    }

    const valueNode = nodes[0];

    if (!valueNode || (valueNode.type !== 'string' && valueNode.type !== 'word')) {
      return false;
    }

    const rewritten = session.rewriteKnownUrl(valueNode.value, style);

    if (rewritten !== valueNode.value) {
      replaceFunctionUrl(node, rewritten);
    }

    return false;
  });
}

function rewriteCssValue(
  value: string,
  session: RewriteSession,
  style: LocalReferenceStyle,
): string {
  const parsedValue = valueParser(value);
  rewriteUrlFunctions(parsedValue, session, style);
  return valueParser.stringify(parsedValue.nodes);
}

function rewriteImportParams(
  params: string,
  session: RewriteSession,
  style: LocalReferenceStyle,
): string {
  const parsedValue = valueParser(params);
  rewriteUrlFunctions(parsedValue, session, style);
  const firstNode = significantValueNodes(parsedValue.nodes)[0];

  if (firstNode?.type === 'string') {
    const rewritten = session.rewriteKnownUrl(firstNode.value, style);

    if (rewritten !== firstNode.value) {
      firstNode.value = escapeCssString(rewritten, firstNode.quote);
    }
  }

  return valueParser.stringify(parsedValue.nodes);
}

export function rewriteCssTextWithSession(
  text: string,
  session: RewriteSession,
  style: LocalReferenceStyle = 'url',
): string {
  const root = postcss.parse(text);

  root.walkDecls((declaration) => {
    declaration.value = rewriteCssValue(declaration.value, session, style);
  });

  root.walkAtRules((atRule) => {
    if (atRule.name.toLowerCase() === 'import') {
      atRule.params = rewriteImportParams(atRule.params, session, style);
    }
  });

  return root.toString();
}

export function rewriteCssDeclarationsWithSession(
  text: string,
  session: RewriteSession,
  style: LocalReferenceStyle = 'url',
): string {
  const root = postcss.parse(text);

  root.walkDecls((declaration) => {
    declaration.value = rewriteCssValue(declaration.value, session, style);
  });

  return root.toString();
}

export function rewriteCss(input: RewriteTextInput): RewriteResult {
  const session = createRewriteSession(input);
  return session.result(rewriteCssTextWithSession(input.text, session));
}
