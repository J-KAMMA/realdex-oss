// Gate for the maintainers' internal suite in inj12-roadmap.internal.mjs.
// It checks files that are not part of the public tree (plans/),
// so it is skipped here and runs unchanged where those files exist.
import fs from 'node:fs';
import test from 'node:test';
const required = ['plans/'];
const present = required.every(p => fs.existsSync(new URL('../../' + p, import.meta.url)));
if (present) await import('./inj12-roadmap.internal.mjs');
else test('inj12-roadmap (internal planning/release data)', { skip: 'requires ' + required.join(', ') + ', which are not part of the public tree' }, () => {});
