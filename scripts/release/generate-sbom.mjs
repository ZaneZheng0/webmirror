import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const spawnOptions = {
  cwd: resolve('.'),
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  windowsHide: true,
};

function quoteCommandArgument(value) {
  if (!/[^\w@%+=:,./\\-]/u.test(value)) {
    return value;
  }

  return `"${value.replaceAll(/(["\\])/gu, '\\$1')}"`;
}

function getPnpmInvocation() {
  if (process.platform !== 'win32') {
    return {
      file: 'pnpm',
      prefix: [],
    };
  }

  const native = spawnSync('pnpm.exe', ['--version'], spawnOptions);
  if (!native.error && native.status === 0) {
    return {
      file: 'pnpm.exe',
      prefix: [],
    };
  }

  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    prefix: ['/d', '/s', '/c'],
  };
}

const pnpmInvocation = getPnpmInvocation();

function runPnpm(args) {
  const commandArgs =
    pnpmInvocation.prefix.length === 0
      ? [...pnpmInvocation.prefix, ...args]
      : [...pnpmInvocation.prefix, ['pnpm.cmd', ...args].map(quoteCommandArgument).join(' ')];
  const result = spawnSync(pnpmInvocation.file, commandArgs, spawnOptions);

  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ||
      result.stderr?.trim() ||
      result.stdout?.trim() ||
      `exit code ${result.status}`;
    throw new Error(`pnpm ${args.join(' ')} failed: ${detail}`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `pnpm ${args.join(' ')} returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function spdxId(name, version) {
  const normalized = `${name}-${version}`.replaceAll(/[^A-Za-z0-9.-]+/g, '-');
  return `SPDXRef-Package-${normalized}`;
}

function packageUrl(name, version) {
  const encodedName = name.startsWith('@')
    ? `@${name.slice(1).split('/').map(encodeURIComponent).join('/')}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

const outputPath = resolve(process.argv[2] ?? 'packaging/release/dist/webmirror-sbom.spdx.json');
const licenses = runPnpm(['licenses', 'list', '--prod', '--json']);
const workspaces = runPnpm(['list', '--recursive', '--prod', '--json', '--depth', '0']);
const records = new Map();

for (const [license, packages] of Object.entries(licenses)) {
  for (const current of packages) {
    for (const version of current.versions ?? []) {
      const key = `${current.name}@${version}`;
      records.set(key, {
        name: current.name,
        version,
        license: current.license || license || 'NOASSERTION',
      });
    }
  }
}

for (const workspace of workspaces) {
  if (!workspace.name || !workspace.version) {
    continue;
  }

  const key = `${workspace.name}@${workspace.version}`;

  if (!records.has(key)) {
    records.set(key, {
      name: workspace.name,
      version: workspace.version,
      license: 'NOASSERTION',
    });
  }
}

const packages = [...records.values()]
  .sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  )
  .map((current) => ({
    SPDXID: spdxId(current.name, current.version),
    name: current.name,
    versionInfo: current.version,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: current.license,
    licenseDeclared: current.license,
    copyrightText: 'NOASSERTION',
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: packageUrl(current.name, current.version),
      },
    ],
  }));
const document = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: 'WebMirror release candidate',
  documentNamespace: `https://webmirror.local/spdx/${crypto.randomUUID()}`,
  creationInfo: {
    created: new Date().toISOString(),
    creators: ['Tool: WebMirror generate-sbom.mjs'],
  },
  packages,
  relationships: packages.map((current) => ({
    spdxElementId: 'SPDXRef-DOCUMENT',
    relationshipType: 'DESCRIBES',
    relatedSpdxElement: current.SPDXID,
  })),
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(outputPath);
