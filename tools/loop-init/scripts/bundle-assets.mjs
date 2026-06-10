#!/usr/bin/env node
import { cp, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

for (const dir of ['starters', 'templates']) {
  const dest = path.join(PACKAGE_ROOT, dir);
  const src = path.join(REPO_ROOT, dir);
  if (!(await exists(src))) {
    console.error(`bundle-assets: missing ${src}`);
    process.exit(1);
  }
  await rm(dest, { recursive: true, force: true });
  await cp(src, dest, { recursive: true });
  console.log(`bundled ${dir}/ → tools/loop-init/${dir}/`);
}

const registrySrc = path.join(REPO_ROOT, 'patterns', 'registry.yaml');
const registryDest = path.join(PACKAGE_ROOT, 'registry.yaml');
if (await exists(registrySrc)) {
  await cp(registrySrc, registryDest);
  console.log('bundled patterns/registry.yaml → tools/loop-init/registry.yaml');
}