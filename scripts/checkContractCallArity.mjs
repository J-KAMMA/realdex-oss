#!/usr/bin/env node
// Heuristic arity sweep for contract-like receivers, not complete ABI/type verification.
//
// Adding the fee to LocalSwapPool changed createPool and getPool from two
// arguments to three. TypeScript did not object — ethers contract methods are
// typed loosely — and every test passed, because the tests had been updated and
// the call sites that had not been were in code no test exercised. Three sites in
// the app and four in the seed scripts were dead until a real chain call was made.
//
// This finds that class without a chain. It is deliberately conservative: an
// overloaded name is reported rather than guessed at, and a receiver that does not
// look like a contract is skipped. Dynamic receivers/signatures are not resolved.
//
// Usage: node scripts/checkContractCallArity.mjs [--json]
// Exits non-zero on a mismatch or an unresolved argument list in a matched call.
// See the internal design notes (not published) for the bounded syntax scope.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");

// --- what the contracts actually declare -----------------------------------
const signatures = new Map();
const overloaded = new Set();
for (const file of collect(path.join(root, "contracts"), /\.sol$/)) {
  const source = lexicalView(fs.readFileSync(file, "utf8")).code;
  for (const match of source.matchAll(/\bfunction\s+(\w+)\s*\(([^)]*)\)\s*(external|public)/g)) {
    const [, name, args] = match;
    const count = args.trim() === "" ? 0 : args.split(",").length;
    if (signatures.has(name) && signatures.get(name) !== count) overloaded.add(name);
    else signatures.set(name, count);
  }
  // A public mapping is a getter too, and `getPool` is one. Leaving mappings out
  // meant the sweep missed half of the very regression it was written for: the
  // fee added a third key, and every two-argument getPool call kept type-checking.
  // Its argument count is the number of keys, so count the `=>` arrows.
  for (const match of source.matchAll(/\bmapping\s*\(([\s\S]*?)\)\s*public\s+(\w+)\s*;/g)) {
    const [, body, name] = match;
    const count = (body.match(/=>/g) ?? []).length;
    if (!count) continue;
    if (signatures.has(name) && signatures.get(name) !== count) overloaded.add(name);
    else signatures.set(name, count);
  }
}
// ERC-20 methods the pool and the app both call, declared in interfaces above.
for (const name of overloaded) signatures.delete(name);

// --- where they are called --------------------------------------------------
const sources = [
  ...collect(path.join(root, "src"), /\.(ts|tsx)$/),
  ...collect(path.join(root, "scripts"), /\.(mjs|ts)$/),
  ...collect(path.join(root, "test"), /\.(cjs|mjs)$/)
];

// ethers BaseContract.getAddress() resolves the instance address. A Solidity
// function of the same name must be selected with getFunction("getAddress").
// Do not globally skip the name or accept both arities: that would hide wrong
// host calls and wrong explicit ABI calls alike.
const hostMethodArities = new Map([["getAddress", 0]]);
const methodHelpers = ["staticCall", "staticCallResult", "send", "estimateGas", "populateTransaction"];
const findings = [];
let matchedCalls = 0;
for (const file of sources) {
  if (path.basename(file) === "checkContractCallArity.mjs") continue;
  const text = fs.readFileSync(file, "utf8");
  const view = lexicalView(text);
  const helper = `(?:\\s*\\.\\s*(${methodHelpers.join("|")}))?`;
  const receiver = `(?:^|[^\\w.$])([\\w$]+)\\s*\\.\\s*`;
  const accesses = [
    { pattern: new RegExp(receiver + `([\\w$]+)` + helper + `\\s*\\(`, "gd"), explicit: false },
    // A string is one opaque token in the view. Recover only literal bare names;
    // no eval, dynamic selection, signature inference or receiver type inference.
    { pattern: new RegExp(receiver + `getFunction\\s*\\(\\s*(0)\\s*\\)` + helper + `\\s*\\(`, "gd"), explicit: true }
  ];
  for (const {pattern, explicit} of accesses) for (const match of view.code.matchAll(pattern)) {
    const receiverName = match[1];
    if (!/pool|factory|router|token|contract|erc20|amber|jade|thin|deep/i.test(receiverName)) continue;
    const name = explicit ? view.strings.get(match.indices[2][0]) : match[2];
    if (!name || !/^[a-zA-Z_$][\w$]*$/.test(name)) continue;
    const host = !explicit && hostMethodArities.has(name);
    if (!host && !signatures.has(name)) continue;
    const expected = host ? hostMethodArities.get(name) : signatures.get(name);
    const binding = host ? "ethers-host" : explicit ? "explicit-solidity" : "solidity";
    const helperName = match[3] ?? null;
    const open = match.index + match[0].length - 1;
    const args = argumentList(view.code, open);
    const actual = args?.length ?? null;
    matchedCalls++;
    let reason = null;
    if (host && helperName) reason = "HOST_METHOD_HAS_NO_CONTRACT_HELPER";
    else if (args === null) reason = "ARGUMENT_LIST_UNRESOLVED";
    else if (args.some(arg => arg.startsWith("..."))) reason = "SPREAD_ARGUMENT_COUNT_UNRESOLVED";
    else if (actual !== expected) {
      // ethers accepts one final overrides object. This proves only its syntax,
      // never valid override keys, ABI values, mutability or transaction safety.
      if (host || actual !== expected + 1 || !objectLiteral(args.at(-1))) reason = "ARGUMENT_COUNT_MISMATCH";
    }
    if (!reason) continue;
    findings.push({
      file: path.relative(root, file).replace(/\\/g, "/"),
      line: text.slice(0, match.indices[1][0]).split("\n").length,
      call: `${receiverName}.${explicit ? `getFunction("${name}")` : name}${helperName ? `.${helperName}` : ""}`,
      expected, actual, binding, reason
    });
  }
}
findings.sort((a,b) => a.file.localeCompare(b.file) || a.line-b.line || a.call.localeCompare(b.call));

if (asJson) {
  console.log(JSON.stringify({ checked: signatures.size, overloadedSkipped: [...overloaded], hostMethodArities: Object.fromEntries(hostMethodArities), methodHelpers, matchedCalls, scope: "bare contract-like receivers and literal unqualified getFunction names; arity only", files: sources.length, findings }, null, 2));
} else {
  console.log(`contract functions checked: ${signatures.size}`);
  if (overloaded.size) console.log(`overloaded, not checked: ${[...overloaded].join(", ")}`);
  console.log(`files scanned: ${sources.length}`);
  if (!findings.length) console.log("call sites disagreeing with the contract: none");
  else {
    console.log(`call sites disagreeing with the contract: ${findings.length}`);
    for (const item of findings) console.log(`  ${item.file}:${item.line}  ${item.call}  ${item.binding} takes ${item.expected}, call passes ${item.actual} (${item.reason})`);
  }
}
process.exitCode = findings.length ? 1 : 0;

function collect (dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full, pattern));
    else if (pattern.test(entry.name)) out.push(full);
  }
  return out;
}

// Create a same-length code view: comments are whitespace and quoted values are
// one opaque numeric token. A comma or bracket inside text cannot change arity.
// Template interpolation is opaque too; calls inside templates are out of scope.
function lexicalView(text) {
  const chars = text.split("");
  const strings = new Map();
  const blank = (start, end, token = false) => {
    for (let i=start; i<end; i++) if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
    if (token) chars[start] = "0";
  };
  const quoteEnd = start => {
    const quote = text[start];
    for (let i=start+1; i<text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === quote) return i+1;
    }
    return text.length;
  };
  // Bound recursion for nested template literals. It is not a JS/TS parser.
  const templateEnd = (start, nesting = 0) => {
    if (nesting > 64) throw Error("ARITY_TEMPLATE_NESTING_LIMIT");
    let braces = 0;
    for (let i=start+1; i<text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      if (!braces && text[i] === "`") return i+1;
      if (!braces && text[i] === "$" && text[i+1] === "{") { braces=1; i++; continue; }
      if (braces) {
        if (text[i] === "'" || text[i] === '"') { i=quoteEnd(i)-1; continue; }
        if (text[i] === "`") { i=templateEnd(i, nesting+1)-1; continue; }
        if (text[i] === "/" && text[i+1] === "/") { const e=text.indexOf("\n",i+2); i=e<0?text.length:e; continue; }
        if (text[i] === "/" && text[i+1] === "*") { const e=text.indexOf("*/",i+2); i=e<0?text.length:e+1; continue; }
        if (text[i] === "{") braces++;
        if (text[i] === "}") braces--;
      }
    }
    return text.length;
  };
  for (let i=0; i<text.length;) {
    if (text[i] === "/" && (text[i+1] === "/" || text[i+1] === "*")) {
      const line = text[i+1] === "/";
      const end = text.indexOf(line ? "\n" : "*/", i+2);
      const next = end<0 ? text.length : end + (line ? 0 : 2);
      blank(i,next); i=next;
    } else if (text[i] === "'" || text[i] === '"' || text[i] === "`") {
      const end = text[i] === "`" ? templateEnd(i) : quoteEnd(i);
      if (text[i] !== "`" && text[end-1] === text[i]) strings.set(i,text.slice(i+1,end-1));
      blank(i,end,true); i=end;
    } else i++;
  }
  return {code:chars.join(""), strings};
}

// Split only at commas in the outer argument list. A trailing comma is not an
// extra argument; empty interior arguments and mismatched delimiters fail closed.
function argumentList(code, open) {
  const stack = [")"], args = [];
  const pairs = {"(":")", "[":"]", "{":"}"};
  let start = open+1;
  for (let i=start; i<code.length; i++) {
    const c=code[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (")]}".includes(c)) {
      if (c !== stack.pop()) return null;
      if (!stack.length) {
        const last=code.slice(start,i).trim();
        if (last) args.push(last);
        return args;
      }
    } else if (c === "," && stack.length === 1) {
      const arg=code.slice(start,i).trim();
      if (!arg) return null;
      args.push(arg); start=i+1;
    }
  }
  return null;
}
function objectLiteral(arg) {
  if (!arg || arg[0] !== "{") return false;
  let depth=0;
  for (let i=0; i<arg.length; i++) {
    if (arg[i] === "{") depth++;
    if (arg[i] === "}" && --depth === 0) return i === arg.length-1;
  }
  return false;
}
