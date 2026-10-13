// Decides the version a push to main is released as. Used by .github/workflows/docker-publish.yml.
//
//   - package.json holds the version of the last release. When it names a version that has no
//     tag yet (you changed it by hand, e.g. to 1.1.0, or this is the very first release), that
//     exact version is released.
//   - Otherwise the patch number goes up by one from the highest v<major>.<minor>.* tag.
//
// Usage: node scripts/next-version.mjs   (reads package.json and `git tag`; prints "<version> <asis|bump>")
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(pkgVersion, tags) {
  const m = SEMVER.exec(String(pkgVersion).trim());
  if (!m) throw new Error(`package.json version "${pkgVersion}" is not major.minor.patch`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const have = new Set(tags.map((t) => t.trim()));
  if (!have.has(`v${major}.${minor}.${patch}`)) return { version: `${major}.${minor}.${patch}`, mode: 'asis' };
  let top = patch;
  for (const t of have) {
    const x = /^v(\d+)\.(\d+)\.(\d+)$/.exec(t);
    if (x && Number(x[1]) === major && Number(x[2]) === minor) top = Math.max(top, Number(x[3]));
  }
  return { version: `${major}.${minor}.${top + 1}`, mode: 'bump' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const r = nextVersion(pkg.version, tags);
  console.log(`${r.version} ${r.mode}`);
}
