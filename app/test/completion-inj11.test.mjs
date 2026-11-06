// Gate for the maintainers' internal suite in completion-inj11.internal.mjs.
// It checks files that are not part of the public tree (plans/),
// so it is skipped here and runs unchanged where those files exist.
import fs from 'node:fs';
import test from 'node:test';
const required = ['plans/'];
const present = required.every(p => fs.existsSync(new URL('../../' + p, import.meta.url)));
if (present) await import('./completion-inj11.internal.mjs');
else test('completion-inj11 (internal planning/release data)', { skip: 'requires ' + required.join(', ') + ', which are not part of the public tree' }, () => {});
