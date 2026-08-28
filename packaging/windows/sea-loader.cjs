'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { getAsset, isSea } = require('node:sea');

const helperAssetName = 'webmirror-helper.js';
const helperHashAssetName = 'webmirror-helper.sha256';
const manifestFileNames = ['com.webmirror.helper.chrome.json', 'com.webmirror.helper.edge.json'];
const extensionOriginPattern = /^chrome-extension:\/\/([a-p]{32})\/?$/;
const parentWindowPattern = /^--parent-window=\d+$/;
const maximumManifestBytes = 64 * 1024;

function fail(message) {
  process.stderr.write(`[webmirror-sea] ${message}\n`);
  process.exitCode = 1;
}

function readAllowedOrigins() {
  const installDirectory = path.dirname(process.execPath);
  const allowedOrigins = new Set();
  let manifestCount = 0;

  for (const fileName of manifestFileNames) {
    const manifestPath = path.join(installDirectory, fileName);
    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    const stats = fs.statSync(manifestPath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > maximumManifestBytes) {
      throw new Error(`Native host manifest has an invalid size: ${fileName}`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (
      manifest === null ||
      typeof manifest !== 'object' ||
      Array.isArray(manifest) ||
      manifest.name !== 'com.webmirror.helper' ||
      manifest.type !== 'stdio' ||
      manifest.path !== 'webmirror-helper.exe' ||
      !Array.isArray(manifest.allowed_origins)
    ) {
      throw new Error(`Native host manifest has an invalid schema: ${fileName}`);
    }

    for (const origin of manifest.allowed_origins) {
      if (typeof origin !== 'string' || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin)) {
        throw new Error(`Native host manifest contains an invalid origin: ${fileName}`);
      }

      allowedOrigins.add(origin);
    }

    manifestCount += 1;
  }

  if (manifestCount === 0) {
    throw new Error('No installed Chrome or Edge native host manifest was found.');
  }

  return allowedOrigins;
}

function normalizeBrowserInvocation() {
  const args = process.argv.slice(2);
  if (args.length === 0 || !args[0].startsWith('chrome-extension://')) {
    return;
  }

  const originMatch = extensionOriginPattern.exec(args[0]);
  if (!originMatch) {
    throw new Error('Browser supplied an invalid extension origin.');
  }

  if (args.length > 2 || (args.length === 2 && !parentWindowPattern.test(args[1]))) {
    throw new Error('Browser supplied unexpected native host arguments.');
  }

  const normalizedOrigin = `chrome-extension://${originMatch[1]}/`;
  if (!readAllowedOrigins().has(normalizedOrigin)) {
    throw new Error('Browser extension origin is not allowed by the installed manifests.');
  }

  process.argv.splice(2, args.length, '--native');
}

function readVerifiedHelperSource() {
  const helperSource = getAsset(helperAssetName, 'utf8');
  const expectedHash = getAsset(helperHashAssetName, 'utf8').trim().toLowerCase();

  if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw new Error('Embedded helper SHA-256 metadata is invalid.');
  }

  const actualHash = crypto.createHash('sha256').update(helperSource, 'utf8').digest('hex');
  if (actualHash !== expectedHash) {
    throw new Error('Embedded helper JavaScript failed SHA-256 verification.');
  }

  return helperSource;
}

async function main() {
  if (!isSea()) {
    throw new Error('SEA loader is not running from a Node single executable application.');
  }

  normalizeBrowserInvocation();
  process.env.WEBMIRROR_SEA = '1';
  const helperSource = readVerifiedHelperSource();
  const helperFilename = path.join(path.dirname(process.execPath), 'embedded-webmirror-helper.cjs');
  const helperModule = new Module(helperFilename, module);
  helperModule.filename = helperFilename;
  helperModule.paths = Module._nodeModulePaths(path.dirname(helperFilename));
  helperModule._compile(helperSource, helperFilename);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : 'Unknown SEA loader failure.');
});
