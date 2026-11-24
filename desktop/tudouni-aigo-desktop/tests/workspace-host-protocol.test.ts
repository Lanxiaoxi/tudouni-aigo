/**
 * The Workspace Host protocol exists three times: the spec
 * (`docs/spec/workspace-host-protocol.md`), the Go host
 * (`internal/workspace/host`) and `src/workspaceHost/protocol.ts`. Two of them
 * are code in different languages, so nothing but this test notices when one
 * side grows a message the other does not know — the symptom would be a panel
 * that silently stops updating.
 *
 * Compared: the protocol version, every message name (both directions), the
 * error codes, the capability names, and each request's parameter names (spec
 * tables vs. the TS table). The spec and the Go source are read as text from the
 * repository, resolved from the project root (`cwd` is
 * `desktop/tudouni-aigo-desktop`; the suites are bundled into `.test-build/`).
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  CAPABILITY_NAMES,
  HOST_ERROR_CODES,
  HOST_MESSAGE_NAMES,
  HOST_PROTOCOL,
  HOST_REQUEST_FIELDS,
  HOST_REQUEST_NAMES,
} from '@/workspaceHost/protocol';

const repoRoot = resolve(process.cwd(), '..', '..');
const specPath = resolve(repoRoot, 'docs', 'spec', 'workspace-host-protocol.md');
const goDir = resolve(repoRoot, 'internal', 'workspace', 'host');

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function readSpec(): string {
  assert.ok(existsSync(specPath), `the spec is missing: ${specPath}`);
  return readFileSync(specPath, 'utf8');
}

/** All non-test Go sources of the host package, concatenated. Fails loudly: a
 *  skipped comparison is a comparison nobody notices is not running. */
function readGo(): string {
  assert.ok(
    existsSync(goDir),
    `the Go host package is missing (${goDir}). It must provide ` +
      '`const HostProtocol = 1` and `var MessageNames = []string{...}` so this test can compare them.',
  );
  const files = readdirSync(goDir).filter((n) => n.endsWith('.go') && !n.endsWith('_test.go'));
  assert.ok(files.length > 0, `no Go sources in ${goDir}`);
  return files.map((n) => readFileSync(resolve(goDir, n), 'utf8')).join('\n');
}

/* ---------------- the spec ---------------- */

function specTableRows(spec: string): { name: string; params: string }[] {
  const rows: { name: string; params: string }[] = [];
  for (const raw of spec.split(/\r?\n/)) {
    // `\|` inside a cell is an escaped pipe, not a column break.
    const line = raw.replace(/\\\|/g, '\u0001');
    const m = /^\|\s*`([a-z_]+)`\s*\|([^|]*)\|/.exec(line);
    if (!m) continue;
    rows.push({ name: m[1]!, params: m[2]!.replace(/\u0001/g, '|').trim() });
  }
  return rows;
}

function specParamNames(cell: string): string[] {
  const text = cell.replace(/`/g, '').trim();
  if (text === '' || text === '–' || text === '-') return [];
  return text.split(',').map((part) => {
    const name = part.trim();
    return /^[a-z_]+/.exec(name)![0];
  });
}

function specMessageNames(spec: string): string[] {
  const names = new Set<string>();
  // Request tables.
  for (const row of specTableRows(spec)) names.add(row.name);
  // `"t":"..."` in the JSON examples (result, host_init, shutdown, …).
  for (const m of spec.matchAll(/"t":"([a-z_]+)"/g)) names.add(m[1]!);
  // The push line: "host 主动发出、不带 `req`：`host_init`、…（保留）".
  const pushLine = spec.split(/\r?\n/).find((l) => l.includes('主动发出'));
  assert.ok(pushLine, 'the spec no longer has the line listing the pushes');
  for (const m of pushLine.matchAll(/`([a-z_]+)`/g)) if (m[1] !== 'req') names.add(m[1]!);
  // The host's own `error` for a bad version.
  assert.ok(/回 `error`/.test(spec), 'the spec no longer names the `error` message');
  names.add('error');
  return sorted(names);
}

/* ---------------- the Go source ---------------- */

function goConstants(go: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of go.matchAll(/^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$/gm)) map.set(m[1]!, m[2]!);
  return map;
}

function goList(go: string, name: string, consts: Map<string, string>): string[] {
  const m = new RegExp(`var\\s+${name}\\s*=\\s*\\[\\]string\\{([\\s\\S]*?)\\n\\}`).exec(go);
  assert.ok(m, `Go: var ${name} = []string{...} not found`);
  const out: string[] = [];
  for (const token of m[1]!.split(',')) {
    const t = token.replace(/\/\/.*$/gm, '').trim();
    if (t === '') continue;
    const literal = /^"([^"]*)"$/.exec(t);
    if (literal) {
      out.push(literal[1]!);
      continue;
    }
    const value = consts.get(t);
    assert.ok(value !== undefined, `Go: ${name} refers to ${t}, which is not a string constant`);
    out.push(value);
  }
  return out;
}

/** Go's `MessageNames`, whether it is a literal list or the append of two. */
function goMessageNames(go: string): string[] {
  const consts = goConstants(go);
  const direct = /var\s+MessageNames\s*=\s*\[\]string\{/.test(go);
  if (direct) return goList(go, 'MessageNames', consts);
  const joined = /var\s+MessageNames\s*=\s*append\(append\(\[\]string\{\},\s*([A-Za-z]+)\.\.\.\),\s*([A-Za-z]+)\.\.\.\)/.exec(go);
  assert.ok(joined, 'Go: `var MessageNames` is neither a []string literal nor append(append([]string{}, A...), B...)');
  return [...goList(go, joined[1]!, consts), ...goList(go, joined[2]!, consts)];
}

/* ---------------- tests ---------------- */

test('HOST_PROTOCOL matches the spec and the Go constant', () => {
  const spec = readSpec();
  const title = /HOST_PROTOCOL\s+(\d+)/.exec(spec);
  assert.ok(title, 'the spec title no longer states HOST_PROTOCOL');
  assert.equal(HOST_PROTOCOL, Number(title[1]));
  const init = /"host_protocol":\s*(\d+)/.exec(spec);
  assert.ok(init, 'the spec host_init example has no host_protocol');
  assert.equal(HOST_PROTOCOL, Number(init[1]));

  const go = readGo();
  const goVersion = /const\s+HostProtocol\s*=\s*(\d+)/.exec(go);
  assert.ok(goVersion, 'Go: `const HostProtocol = N` not found in internal/workspace/host');
  assert.equal(HOST_PROTOCOL, Number(goVersion[1]));
});

test('the TS message names equal the spec', () => {
  assert.deepEqual(sorted(HOST_MESSAGE_NAMES), specMessageNames(readSpec()));
});

test('the TS message names equal the Go MessageNames', () => {
  assert.deepEqual(sorted(HOST_MESSAGE_NAMES), sorted(goMessageNames(readGo())));
});

test('the message-name table has no duplicates', () => {
  assert.equal(new Set(HOST_MESSAGE_NAMES).size, HOST_MESSAGE_NAMES.length);
});

test('every request has a parameter table, and it matches the spec', () => {
  const rows = new Map(specTableRows(readSpec()).map((r) => [r.name, r.params]));
  for (const name of HOST_REQUEST_NAMES) {
    const cell = rows.get(name);
    assert.ok(cell !== undefined, `the spec has no table row for ${name}`);
    assert.deepEqual(
      [...HOST_REQUEST_FIELDS[name]],
      specParamNames(cell),
      `parameters of ${name} differ from the spec`,
    );
  }
});

test('the error codes equal the spec and the Go constants', () => {
  const spec = readSpec();
  const line = spec.split(/\r?\n/).find((l) => l.startsWith('错误码'));
  assert.ok(line, 'the spec no longer has the error-code line');
  const specCodes = [...line.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);
  assert.deepEqual(sorted(HOST_ERROR_CODES), sorted(specCodes));

  const go = readGo();
  const goCodes = [...go.matchAll(/^\s*Code[A-Za-z]+\s*=\s*"([a-z_]+)"\s*$/gm)].map((m) => m[1]!);
  assert.ok(goCodes.length > 0, 'Go: no `Code… = "…"` constants found');
  assert.deepEqual(sorted(HOST_ERROR_CODES), sorted(goCodes));
});

test('the capability names equal the spec and the Go struct tags', () => {
  const spec = readSpec();
  const block = /"workspace_capabilities":\{([\s\S]*?)\}/.exec(spec);
  assert.ok(block, 'the spec host_init example has no workspace_capabilities');
  const specCaps = [...block[1]!.matchAll(/"([a-z_]+)":(?:true|false)/g)].map((m) => m[1]!);
  assert.deepEqual(sorted(CAPABILITY_NAMES), sorted(specCaps));

  const go = readGo();
  const struct = /type\s+Capabilities\s+struct\s*\{([\s\S]*?)\n\}/.exec(go);
  assert.ok(struct, 'Go: `type Capabilities struct` not found');
  const goCaps = [...struct[1]!.matchAll(/`json:"([a-z_]+)"`/g)].map((m) => m[1]!);
  assert.deepEqual(sorted(CAPABILITY_NAMES), sorted(goCaps));
});
