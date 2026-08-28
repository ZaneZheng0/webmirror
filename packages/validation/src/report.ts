import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ValidationResult } from './types.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function issueList(items: readonly string[], emptyMessage: string): string {
  if (items.length === 0) {
    return `<p class="quiet">${escapeHtml(emptyMessage)}</p>`;
  }

  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function checkRow(name: string, passed: boolean, detail: string): string {
  return `<tr>
    <th scope="row">${escapeHtml(name)}</th>
    <td><span class="check ${passed ? 'pass' : 'issue'}">${passed ? 'Pass' : 'Issue'}</span></td>
    <td>${escapeHtml(detail)}</td>
  </tr>`;
}

function comparisonDetail(
  checkpoint: ValidationResult['checks']['perceptual']['checkpoints'][number],
): string {
  const comparison = checkpoint.comparison;

  if (comparison.outcome === 'not-compared') {
    return comparison.reason ?? 'No reference supplied';
  }

  if (comparison.outcome === 'error') {
    return comparison.reason ?? 'Comparison could not be completed';
  }

  const similarity =
    comparison.similarity === undefined
      ? 'unknown similarity'
      : `${(comparison.similarity * 100).toFixed(2)}% similarity`;
  return `${comparison.outcome}, ${similarity}, ${comparison.differingPixels ?? 0} differing pixel(s)`;
}

function interactionSection(result: ValidationResult): string {
  const interactions = result.checks.interactions;

  if (!interactions.checked || interactions.actions.length === 0) {
    return '';
  }

  const rows = interactions.actions
    .map(
      (action) => `<tr>
        <th scope="row">${escapeHtml(action.label)}</th>
        <td>${escapeHtml(action.type)}</td>
        <td><span class="check ${action.status === 'passed' ? 'pass' : 'issue'}">${escapeHtml(action.status)}</span></td>
        <td>${action.durationMs} ms</td>
        <td>${escapeHtml(action.error ?? `${action.remoteDependencies.length} blocked remote request(s)`)}</td>
      </tr>`,
    )
    .join('');

  return `<section>
      <h2>Scripted interactions</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Action</th>
            <th scope="col">Type</th>
            <th scope="col">Result</th>
            <th scope="col">Duration</th>
            <th scope="col">Evidence</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function checkpointSection(result: ValidationResult): string {
  const checkpoints = result.checks.perceptual.checkpoints;

  if (checkpoints.length === 0) {
    return '';
  }

  return `<section>
      <h2>Checkpoint evidence</h2>
      <div class="checkpoints">
        ${checkpoints
          .map((checkpoint) => {
            const images = [
              checkpoint.screenshot.path
                ? `<figure><img src="${escapeHtml(checkpoint.screenshot.path)}" alt="${escapeHtml(checkpoint.label)} actual"><figcaption>Actual</figcaption></figure>`
                : '',
              checkpoint.comparison.referencePath
                ? `<figure><img src="${escapeHtml(checkpoint.comparison.referencePath)}" alt="${escapeHtml(checkpoint.label)} reference"><figcaption>Reference</figcaption></figure>`
                : '',
              checkpoint.comparison.diffPath
                ? `<figure><img src="${escapeHtml(checkpoint.comparison.diffPath)}" alt="${escapeHtml(checkpoint.label)} visual difference"><figcaption>Difference</figcaption></figure>`
                : '',
            ].join('');

            return `<article>
              <h3>${escapeHtml(checkpoint.label)}</h3>
              <p class="quiet">${escapeHtml(comparisonDetail(checkpoint))}</p>
              ${images ? `<div class="evidence-grid">${images}</div>` : ''}
            </article>`;
          })
          .join('')}
      </div>
    </section>`;
}

export function renderValidationReport(result: ValidationResult): string {
  const screenshot = result.artifacts.screenshot
    ? `<section>
        <h2>First view</h2>
        <img src="${escapeHtml(result.artifacts.screenshot)}" alt="Validated first viewport">
      </section>`
    : '';
  const canvas = result.checks.canvas;
  const interactions = result.checks.interactions;
  const perceptual = result.checks.perceptual;
  const diagnostics = result.checks.diagnostics;
  const diagnosticsDetail = diagnostics
    ? diagnostics.truncated
      ? `${diagnostics.droppedEvents} event(s) omitted after reaching evidence limits`
      : `${diagnostics.estimatedRecordedEventBytes}/${diagnostics.eventByteBudget} estimated event bytes retained`
    : 'Diagnostic budget metadata was not recorded by this validation result';
  const screenshotDetail = result.checks.screenshot.path
    ? `${result.checks.screenshot.path}${result.checks.screenshot.maskedSensitiveControls ? ' (sensitive controls masked)' : ''}`
    : (result.checks.screenshot.error ?? 'Not saved');
  const entryDetail = result.entry.ok
    ? `${result.entry.httpStatus ?? 'loaded'} ${result.entry.finalUrl ?? result.entry.requestedUrl}`
    : (result.entry.error ?? 'Entry did not load');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'">
  <title>WebMirror validation report</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, sans-serif; color: #1f2933; background: #f5f7f8; }
    body { margin: 0; }
    main { width: min(920px, calc(100% - 32px)); margin: 24px auto 48px; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; border-bottom: 2px solid #d6dde2; padding-bottom: 16px; }
    h1 { margin: 0; font-size: 24px; }
    h2 { margin: 24px 0 10px; font-size: 17px; }
    h3 { margin: 0; font-size: 15px; }
    .outcome { text-align: right; }
    .status { font-weight: 700; text-transform: uppercase; color: ${result.status === 'complete' ? '#176b45' : result.status === 'partial' ? '#8a5800' : '#a22b2b'}; }
    .score { display: block; font-size: 22px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; background: #fff; }
    th, td { padding: 10px 12px; border: 1px solid #d6dde2; text-align: left; vertical-align: top; }
    th { width: 24%; }
    .check { font-weight: 700; }
    .pass { color: #176b45; }
    .issue { color: #a22b2b; }
    .quiet { color: #66737d; }
    ul { margin: 8px 0; padding-left: 22px; }
    li { margin: 5px 0; overflow-wrap: anywhere; }
    img { display: block; max-width: 100%; height: auto; border: 1px solid #c6d0d7; background: #fff; }
    .checkpoints { display: grid; gap: 20px; }
    article { border-top: 1px solid #d6dde2; padding-top: 14px; }
    .evidence-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    figure { margin: 0; }
    figcaption { margin-top: 5px; color: #66737d; font-size: 12px; }
    footer { margin-top: 24px; color: #66737d; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>WebMirror validation</h1>
        <div class="quiet">${escapeHtml(result.entry.requestedUrl)}</div>
      </div>
      <div class="outcome">
        <span class="status">${escapeHtml(result.status)}</span>
        <span class="score">${result.score}/100</span>
      </div>
    </header>
    <section>
      <h2>Checks</h2>
      <table>
        <tbody>
          ${checkRow('Local entry', result.entry.ok, entryDetail)}
          ${checkRow('HTTP resources', result.checks.http.passed, `${result.checks.http.failures.length} failure(s), ${result.checks.http.local404s.length} local 404(s)`)}
          ${checkRow('Runtime errors', result.checks.runtime.passed, `${result.checks.runtime.pageErrors.length} page error(s), ${result.checks.runtime.blockingConsoleErrors.length} blocking console error(s)`)}
          ${checkRow('Remote dependencies', result.checks.remoteDependencies.passed, `${result.checks.remoteDependencies.dependencies.length} unexpected request(s)`)}
          ${checkRow('Diagnostic evidence', diagnostics?.passed ?? true, diagnosticsDetail)}
          ${checkRow('Screenshot', result.checks.screenshot.passed, screenshotDetail)}
          ${checkRow('Canvas / WebGL', canvas.passed && !canvas.truncated, canvas.checked ? `${canvas.nonEmpty} non-empty, ${canvas.empty} empty, ${canvas.unreadable} unreadable${canvas.truncated ? `, ${canvas.omitted} omitted` : ''}` : 'Not checked')}
          ${checkRow('Scripted interactions', interactions.passed, interactions.checked ? (interactions.actions.length > 0 ? `${interactions.completed}/${interactions.actions.length} action(s) completed, ${interactions.skipped} skipped` : interactions.passed ? 'Replay context initialized; no actions configured' : 'Replay context failed before actions could run') : 'Not configured')}
          ${checkRow('Perceptual comparison', perceptual.passed, perceptual.checked ? `${perceptual.matched}/${perceptual.compared} checkpoint(s) matched, ${perceptual.partial} partial` : 'No trusted references supplied')}
        </tbody>
      </table>
    </section>
    ${interactionSection(result)}
    <section>
      <h2>Errors</h2>
      ${issueList(result.errors, 'No blocking errors.')}
    </section>
    <section>
      <h2>Warnings</h2>
      ${issueList(result.warnings, 'No warnings.')}
    </section>
    ${screenshot}
    ${checkpointSection(result)}
    <footer>Completed ${escapeHtml(result.completedAt)} in ${result.durationMs} ms.</footer>
  </main>
</body>
</html>
`;
}

export async function atomicWriteFile(
  targetPath: string,
  contents: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = join(
    dirname(targetPath),
    `.${targetPath.split(/[\\/]/).at(-1) ?? 'validation'}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, contents, { flag: 'wx' });
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
