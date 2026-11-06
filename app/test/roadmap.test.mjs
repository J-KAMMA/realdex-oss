// Gate for the maintainers' internal suite in roadmap.internal.mjs.
// It checks files that are not part of the public tree (plans/DEVELOPMENT-ROADMAP-2026-09-06.json),
// so it is skipped here and runs unchanged where those files exist.
import fs from 'node:fs';
import test from 'node:test';
const required = ['plans/DEVELOPMENT-ROADMAP-2026-09-06.json'];
const present = required.every(p => fs.existsSync(new URL('../../' + p, import.meta.url)));
if (present) await import('./roadmap.internal.mjs');
else test('roadmap (internal planning/release data)', { skip: 'requires ' + required.join(', ') + ', which are not part of the public tree' }, () => {});
