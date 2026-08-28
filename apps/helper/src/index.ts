import { runHelperCli } from './cli.js';

void runHelperCli(process.argv.slice(2), {
  input: process.stdin,
  output: process.stdout,
  errorOutput: process.stderr,
})
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown helper failure.';
    process.stderr.write(`[webmirror-helper] ${message}\n`);
    process.exitCode = 1;
  });
