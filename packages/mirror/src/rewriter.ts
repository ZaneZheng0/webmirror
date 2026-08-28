import { rewriteCss } from './rewrite-css.js';
import { rewriteHtml } from './rewrite-html.js';
import { rewriteJavaScript } from './rewrite-javascript.js';
import { rewriteJson } from './rewrite-json.js';
import type { RewriteResult, RewriteTextInput } from './rewriter-core.js';

export type RewriteResourceType = 'html' | 'css' | 'json' | 'javascript';

export interface RewriteResourceInput extends RewriteTextInput {
  type: RewriteResourceType;
}

export function rewriteResource(input: RewriteResourceInput): RewriteResult {
  const rewriteInput: RewriteTextInput = {
    text: input.text,
    resourceUrl: input.resourceUrl,
    urlToLocalPath: input.urlToLocalPath,
    currentLocalPath: input.currentLocalPath,
    ...(input.knownResourceUrls ? { knownResourceUrls: input.knownResourceUrls } : {}),
    ...(input.workerContext ? { workerContext: true } : {}),
  };

  switch (input.type) {
    case 'html':
      return rewriteHtml(rewriteInput);
    case 'css':
      return rewriteCss(rewriteInput);
    case 'json':
      return rewriteJson(rewriteInput);
    case 'javascript':
      return rewriteJavaScript(rewriteInput);
  }
}

export { rewriteCss, rewriteHtml, rewriteJavaScript, rewriteJson };
export type { RewriteResult, RewriteTextInput, UrlToLocalPathMap } from './rewriter-core.js';
