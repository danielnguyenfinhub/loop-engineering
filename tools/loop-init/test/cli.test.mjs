import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CLI = path.resolve('dist/cli.js');

test('loop-init --help exits 0', async () => {
  const { stdout } = await exec('node', [CLI, '--help']);
  assert.match(stdout, /changelog-drafter/);
});

test('loop-init dry-run scaffolds daily-triage', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-init-'));
  try {
    const { stdout } = await exec('node', [
      CLI,
      dir,
      '--pattern',
      'daily-triage',
      '--tool',
      'grok',
      '--dry-run',
    ]);
    assert.match(stdout, /loop-init: daily-triage/);
    assert.match(stdout, /would copy|copied/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loop-init scaffolds ci-sweeper with bundled assets', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-init-'));
  try {
    await exec('node', [CLI, dir, '--pattern', 'ci-sweeper', '--tool', 'grok']);
    await access(path.join(dir, 'ci-sweeper-state.md'));
    await access(path.join(dir, '.grok', 'skills', 'ci-triage', 'SKILL.md'));
    await access(path.join(dir, '.grok', 'skills', 'minimal-fix', 'SKILL.md'));
    await access(path.join(dir, '.grok', 'skills', 'loop-verifier', 'SKILL.md'));
    await access(path.join(dir, 'loop-budget.md'));
    await access(path.join(dir, 'loop-run-log.md'));
    await access(path.join(dir, '.grok', 'skills', 'loop-budget', 'SKILL.md'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});