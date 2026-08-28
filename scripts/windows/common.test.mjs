import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function powerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

describe('Windows command capture', () => {
  const windowsIt = process.platform === 'win32' ? it : it.skip;

  windowsIt('isolates machine-readable commands from conflicting color variables', () => {
    const commonScript = powerShellLiteral(resolve('scripts/windows/common.ps1'));
    const executable = powerShellLiteral(process.execPath);
    const command = [
      `. ${commonScript}`,
      `$value = Invoke-WebMirrorCommandCapture -FilePath ${executable} -ArgumentList @('--version') -Label 'Node version'`,
      '[ordered]@{ value = $value; noColor = $env:NO_COLOR; forceColor = $env:FORCE_COLOR } | ConvertTo-Json -Compress',
    ].join('; ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
      cwd: resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '1',
      },
      windowsHide: true,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      value: process.version,
      noColor: '1',
      forceColor: '1',
    });
  });
});
