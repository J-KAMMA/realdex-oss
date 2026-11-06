// Gate for the maintainers' internal suite in collaboration.internal.mjs.
// It checks files that are not part of the public tree (dev/github-publish.mjs, RELEASE.json, CURRENT.md),
// so it is skipped here and runs unchanged where those files exist.
import fs from 'node:fs';
import test from 'node:test';
const required = ['dev/github-publish.mjs', 'RELEASE.json', 'CURRENT.md'];
const present = required.every(p => fs.existsSync(new URL('../../' + p, import.meta.url)));
if (present) await import('./collaboration.internal.mjs');
else test('collaboration (internal planning/release data)', { skip: 'requires ' + required.join(', ') + ', which are not part of the public tree' }, () => {});
