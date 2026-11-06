const TEST_GATES = [
  ['test:contracts', 'root-contract-tests', true],
  ['test:call-arity', 'root-call-arity', false],
  ['test:release-plan', 'root-release-plan', false],
  ['test:cctp-artifact', 'root-cctp-asset', false],
  ['test:cctp-deployment-metadata', 'root-cctp-deployment-metadata', false],
  ['test:hooks', 'root-hook-dependencies', false],
  ['test:ui', 'root-ui-tests', false],
];

export const ROOT_SCRIPT_GATES = Object.freeze([
  Object.freeze({ name: 'root-build', script: 'build', requiresCompiler: false }),
  ...TEST_GATES.map(([script, name, requiresCompiler]) => Object.freeze({ name, script, requiresCompiler })),
]);

const TEST_SCRIPTS = new Set(TEST_GATES.map(([script]) => script));
const COMMAND_SEGMENT = /^(npm|pnpm) run ([A-Za-z0-9][A-Za-z0-9:_-]*)$/;

function invalid(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireScriptBody(scripts, name) {
  if (!Object.hasOwn(scripts, name)) throw invalid('ROOT_SCRIPT_BODY_MISSING');
  if (typeof scripts[name] !== 'string' || scripts[name].trim() === '') throw invalid('ROOT_SCRIPT_BODY_EMPTY');
}

function requireManifestScripts(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw invalid('ROOT_MANIFEST_INVALID');
  const { scripts } = manifest;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) throw invalid('ROOT_SCRIPTS_MISSING');
  requireScriptBody(scripts, 'build');
  requireScriptBody(scripts, 'test');
  for (const script of TEST_SCRIPTS) requireScriptBody(scripts, script);
  return scripts;
}

function declaredTestScripts(command) {
  const segments = command.trim().split('&&');
  if (segments.some(segment => !COMMAND_SEGMENT.test(segment.trim()))) throw invalid('ROOT_TEST_COMMAND_MALFORMED');
  return segments.map(segment => COMMAND_SEGMENT.exec(segment.trim())[2]);
}

export function rootScriptPlan(manifest) {
  const scripts = requireManifestScripts(manifest);
  const declared = declaredTestScripts(scripts.test);
  for (const script of declared) if (!TEST_SCRIPTS.has(script)) throw invalid('ROOT_TEST_SCRIPT_UNKNOWN');

  const seen = new Set();
  for (const script of declared) {
    if (seen.has(script)) throw invalid('ROOT_TEST_SCRIPT_DUPLICATE');
    seen.add(script);
  }
  if (seen.size !== TEST_SCRIPTS.size || [...TEST_SCRIPTS].some(script => !seen.has(script))) {
    throw invalid('ROOT_TEST_SCRIPT_OMITTED');
  }

  return Object.freeze([
    ROOT_SCRIPT_GATES[0],
    ...declared.map(script => ROOT_SCRIPT_GATES.find(gate => gate.script === script)),
  ]);
}
