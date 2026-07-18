import { protocolVersion } from '@webmirror/shared';

const packageVersion = '0.0.1';

function writeDiagnostic(message: string): void {
  process.stderr.write(`[webmirror-helper] ${message}\n`);
}

function main(): void {
  const command = process.argv[2];

  if (command === '--version') {
    process.stdout.write(`${packageVersion}\n`);
    return;
  }

  writeDiagnostic(
    `Helper scaffold started. Version ${packageVersion}, protocol ${protocolVersion}. Native Messaging is not connected yet.`,
  );
}

main();
