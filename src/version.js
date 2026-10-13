import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

// package.json is the one place the version number lives. Releases bump it with `npm version`.
let pkg = {};
try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch { /* keep defaults */ }

export const REPO_URL = 'https://github.com/ChrisTracy/check_in';
const startedAt = new Date().toISOString();
const clean = (v) => { const s = String(v ?? '').trim(); return s && s !== 'unknown' ? s.slice(0, 80) : null; };

/** What the About page shows. The commit and build date come from the Docker build (see Dockerfile). */
export function aboutInfo() {
  const commit = clean(process.env.GIT_COMMIT);
  return {
    name: 'Check-In',
    version: String(pkg.version || '0.0.0'),
    commit: commit ? commit.slice(0, 7) : null,
    commitUrl: commit && /^[0-9a-f]{7,40}$/i.test(commit) ? `${REPO_URL}/commit/${commit}` : null,
    builtAt: clean(process.env.BUILD_DATE),
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    startedAt,
    license: String(pkg.license || ''),
    repoUrl: REPO_URL,
    releasesUrl: `${REPO_URL}/releases`,
    issuesUrl: `${REPO_URL}/issues`,
  };
}
