#!/usr/bin/env node
// Compares every React hook's dependency array against what its callback reads.
//
// This exists because a dependency list drifted from its body and cost a real
// defect: the deposit review panel's minimum-shares floor was computed from the
// chosen pool, but the memo never recomputed when the pool changed, so the screen
// showed the verified pool's figure while depositing into another tier. Nothing
// caught it — the types were fine, the tests were fine, and the number happened
// to match under the seed in use.
//
// It uses the TypeScript parser, not regular expressions. A hand-rolled scan of
// these files produced eighteen false reports once before.
//
// It cannot tell a forgotten dependency from a deliberate one. "When this changes,
// reset that" is a correct pattern whose body never reads the dependency, and so
// is a callback that deliberately closes over the value it had when it was made.
// Those are listed in REVIEWED below with the reason each was accepted. Anything
// not on that list is new drift, and fails.
//
//   node scripts/checkHookDependencies.mjs            check
//   node scripts/checkHookDependencies.mjs --list     print every finding
//   node scripts/checkHookDependencies.mjs --self-test
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(path.join(root, "package.json"))("typescript");

const HOOKS = new Set(["useMemo", "useEffect", "useCallback", "useLayoutEffect"]);
// Never reactive: globals, state setters (stable by contract), refs (excluded on
// purpose), and a reducer's dispatch.
const GLOBAL = /^(BigInt|Number|String|Boolean|Error|Math|JSON|Date|Map|Set|Promise|Array|Object|undefined|null|window|document|localStorage|console|setTimeout|clearTimeout|setInterval|clearInterval|fetch|URL|isNaN|parseInt|parseFloat|structuredClone|queueMicrotask)\b/;
const SETTER = /^set[A-Z]/;
const REF = /\.current\b/;
const DISPATCH = /^dispatch[A-Z]/;
const unreactive = (name) => GLOBAL.test(name) || SETTER.test(name) || REF.test(name) || DISPATCH.test(name);

/**
 * Sites read and accepted on 2026-09-04. Each entry is one hook, by file and the
 * name it is missing or not using, with why it is correct as written.
 */
const REVIEWED = [
  { file: "src/swap/CosmosRecoveryPanel.tsx", missing: ["pending"], unused: ["context"], why: "Stops a lookup when its transaction or policy context changes, and reports whether one was running. Adding pending would fire the message every time a lookup starts or ends." },
  { file: "src/swap/CosmosRecoveryPanel.tsx", missing: ["stopLookup"], unused: [], why: "stopLookup only touches refs and setters and is rebuilt every render; listing it would re-run the effect on every render." },
  { file: "src/v01/V01App.tsx", missing: ["clearHistoryArchive", "reloadHistory"], unused: [], why: "Mount-only setup: reads the journal once, installs a clock and a storage listener. Both helpers only touch refs and setters." },
  { file: "src/v01/V01App.tsx", missing: ["invalidateSession"], unused: [], why: "invalidateSession clears state and bumps a ref; a stale closure of it does the same thing." },
  { file: "src/wallet/SolanaStandardConnectionPanel.tsx", missing: [], unused: ["controller"], why: "The controller is the trigger: when it changes, the panel resets. The body has no need to read it." },
  { file: "src/wallet/SolanaStandardConnectionPanel.tsx", missing: [], unused: ["discovery.revision"], why: "The revision is the trigger, so the effect re-runs when the wallet registry changes even if the booleans derived from it compare equal." }
];

export function findDependencyDrift (file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const moduleScope = new Set();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause;
      if (clause.name) moduleScope.add(clause.name.text);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) moduleScope.add(element.name.text);
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) moduleScope.add(statement.name.text);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) moduleScope.add(declaration.name.text);
      }
    }
  }

  const bindName = (name, into) => {
    if (ts.isIdentifier(name)) { into.add(name.text); return; }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) if (ts.isBindingElement(element)) bindName(element.name, into);
    }
  };
  const collectBound = (node, into) => {
    const walk = (current) => {
      if (ts.isVariableDeclaration(current) || ts.isParameter(current)) bindName(current.name, into);
      if (ts.isCatchClause(current) && current.variableDeclaration) bindName(current.variableDeclaration.name, into);
      if ((ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current)) && current.name) into.add(current.name.text);
      ts.forEachChild(current, walk);
    };
    ts.forEachChild(node, walk);
  };
  // Optional chains print as "a?.b"; normalising them lets one spelling match.
  const plain = (value) => value.replace(/\?\./g, ".");

  const readsOf = (node, bound) => {
    const found = new Set();
    const walk = (current) => {
      if (ts.isPropertyAccessExpression(current)) {
        let base = current;
        while (ts.isPropertyAccessExpression(base)) base = base.expression;
        if (ts.isIdentifier(base) && !bound.has(base.text)) found.add(plain(current.getText().split("(")[0]));
        // Do not descend into the chain's own root: it is already covered, and
        // counting it separately reported every ref as a bare outer read.
        if (!ts.isIdentifier(current.expression) && !ts.isPropertyAccessExpression(current.expression)) walk(current.expression);
        return;
      }
      if (ts.isPropertyAssignment(current)) { walk(current.initializer); return; }
      if (ts.isJsxAttribute(current)) { if (current.initializer) walk(current.initializer); return; }
      if (ts.isIdentifier(current)) {
        const parent = current.parent;
        const isName = (ts.isPropertyAccessExpression(parent) && parent.name === current)
          || (ts.isBindingElement(parent) && parent.propertyName === current)
          || ts.isPropertySignature(parent) || ts.isTypeReferenceNode(parent);
        if (!isName && !bound.has(current.text)) found.add(current.text);
        return;
      }
      ts.forEachChild(current, walk);
    };
    ts.forEachChild(node, walk);
    return found;
  };

  const findings = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && HOOKS.has(node.expression.text) && node.arguments.length >= 2) {
      const [callback, deps] = node.arguments;
      if (ts.isArrayLiteralExpression(deps)) {
        const bound = new Set(moduleScope);
        collectBound(callback, bound);
        if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
          for (const parameter of callback.parameters) bindName(parameter.name, bound);
        }
        const reads = [...readsOf(callback, bound)];
        const listed = deps.elements.map(element => plain(element.getText()));
        const roots = new Set(listed.map(item => item.split(".")[0]));
        const missing = reads.filter(read => !unreactive(read) && !listed.includes(read) && !roots.has(read.split(".")[0])).sort();
        const unused = listed.filter(item => !unreactive(item)
          && !reads.some(read => read === item || read.split(".")[0] === item.split(".")[0] || read.startsWith(item + ".")));
        // A body that reads nothing reactive is using its dependency as a trigger.
        const triggerOnly = !missing.length && unused.length > 0 && reads.every(unreactive);
        if ((missing.length || unused.length) && !triggerOnly) {
          findings.push({ file, hook: node.expression.text, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, missing, unused });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

function componentFiles () {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) found.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(path.join(root, "src"));
  return found.sort();
}

const sameNames = (left, right) => left.length === right.length && left.every((item, index) => item === right[index]);
const accepted = (finding) => REVIEWED.some(entry => entry.file === finding.file && sameNames(entry.missing, finding.missing) && sameNames(entry.unused, finding.unused));

if (process.argv.includes("--self-test")) {
  // A dependency list that omits something the body reads must be reported, and
  // one that names everything must not be.
  const drifting = findDependencyDrift("test.tsx", "const f = () => { const [a] = useState(0); const b = useMemo(() => a + 1, []); return b; };");
  const clean = findDependencyDrift("test.tsx", "const f = () => { const [a] = useState(0); const b = useMemo(() => a + 1, [a]); return b; };");
  if (!drifting.some(item => item.missing.includes("a"))) { console.error("self-test: a missing dependency was not reported"); process.exit(1); }
  if (clean.length) { console.error(`self-test: a complete dependency list was reported: ${JSON.stringify(clean)}`); process.exit(1); }
  console.log("checkHookDependencies self-test passed");
  process.exit(0);
}

const findings = componentFiles().flatMap(file => findDependencyDrift(file, fs.readFileSync(path.join(root, file), "utf8")));
if (process.argv.includes("--list")) {
  console.log(JSON.stringify(findings, null, 2));
  process.exit(0);
}

const unreviewed = findings.filter(finding => !accepted(finding));
const missingReviews = REVIEWED.filter(entry => !findings.some(finding => finding.file === entry.file && sameNames(entry.missing, finding.missing) && sameNames(entry.unused, finding.unused)));

for (const finding of unreviewed) {
  console.error(`${finding.file}:${finding.line} ${finding.hook} missing [${finding.missing.join(", ")}] unused [${finding.unused.join(", ")}]`);
}
// A reviewed exception that no longer occurs means the list is stale, and a stale
// list is how an accepted exception quietly starts covering something else.
for (const entry of missingReviews) {
  console.error(`reviewed exception no longer found, remove it: ${entry.file} missing [${entry.missing.join(", ")}] unused [${entry.unused.join(", ")}]`);
}
if (unreviewed.length || missingReviews.length) process.exit(1);
console.log(`hook dependencies: ${findings.length} reviewed exceptions, no new drift`);
