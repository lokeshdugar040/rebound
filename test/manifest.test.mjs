import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// CSXS/manifest.xml has no test coverage anywhere else: tools/pack.mjs copies
// CSXS/ byte for byte and CI only runs lint + unit tests, so every way of
// breaking it is invisible until After Effects silently drops the panel from
// Window > Extensions. These are the failure modes that have actually bitten:
//
//   1. A double hyphen inside an XML comment. Illegal per XML 1.0 §2.5, and
//      CEP rejects the whole manifest, so writing a note about a CEF flag with
//      its real "--name" spelling deletes the extension from the menu.
//   2. Dropping a load bearing CEFCommandLine flag. enable-nodejs in
//      particular is periodically recommended for removal on the theory that
//      CEP 12 no longer ships Node. It does ship Node (cookbook: 17.7.1), and
//      without the flag window.cep_node is undefined, which takes out the
//      ingest server, all image import, and WAV onset detection.
//   3. Paths that point at files that are not there.
//   4. .debug drifting out of sync with the manifest, so a documented remote
//      debugging port belongs to an extension that no longer exists.

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');

const MANIFEST = path.join(root, 'CSXS', 'manifest.xml');
const DEBUG = path.join(root, '.debug');

const read = (p) => readFileSync(p, 'utf8');

// Flags the panel cannot lose without a user visible feature dying.
const LOAD_BEARING_FLAGS = ['--enable-nodejs', '--allow-file-access-from-files'];

function comments(xml) {
  return [...xml.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]);
}

function stripComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
}

// Minimal well-formedness scan. Enough to catch an unclosed or mismatched tag,
// which is the realistic hand-edit mistake; not a spec compliant parser.
function tagBalance(xml) {
  const body = stripComments(xml).replace(/<\?[\s\S]*?\?>/g, '');
  const stack = [];
  for (const m of body.matchAll(/<\/?([A-Za-z_][\w.-]*)[^>]*?(\/?)>/g)) {
    const [raw, name, selfClose] = m;
    if (selfClose === '/') continue;
    if (raw.startsWith('</')) {
      if (stack.pop() !== name) return `unbalanced close </${name}>`;
    } else {
      stack.push(name);
    }
  }
  return stack.length ? `unclosed <${stack[stack.length - 1]}>` : null;
}

describe('CSXS/manifest.xml', () => {
  const xml = read(MANIFEST);

  it('contains no double hyphen inside a comment', () => {
    // The reason the header comment spells flags without leading dashes.
    for (const c of comments(xml)) {
      expect(c.includes('--'), `illegal "--" in comment: ${c.trim().slice(0, 80)}`).toBe(false);
    }
  });

  it('closes every comment it opens', () => {
    expect((xml.match(/<!--/g) || []).length).toBe((xml.match(/-->/g) || []).length);
  });

  it('is well formed enough to parse', () => {
    expect(tagBalance(xml)).toBe(null);
  });

  it('keeps the load bearing CEF flags', () => {
    const flags = [...xml.matchAll(/<Parameter>([^<]*)<\/Parameter>/g)].map((m) => m[1].trim());
    for (const flag of LOAD_BEARING_FLAGS) {
      expect(flags, `${flag} is required, see the manifest header comment`).toContain(flag);
    }
  });

  it('points MainPath and ScriptPath at files that exist', () => {
    for (const tag of ['MainPath', 'ScriptPath']) {
      const rel = stripComments(xml).match(new RegExp(`<${tag}>([^<]+)</${tag}>`))?.[1];
      expect(rel, `${tag} missing`).toBeTruthy();
      expect(existsSync(path.join(root, rel.replace(/^\.\//, ''))), `${tag} -> ${rel}`).toBe(true);
    }
  });

  it('points every icon at a file that exists', () => {
    const icons = [...stripComments(xml).matchAll(/<Icon[^>]*>([^<]+)<\/Icon>/g)].map((m) => m[1].trim());
    expect(icons.length).toBeGreaterThan(0);
    for (const rel of icons) {
      expect(existsSync(path.join(root, rel.replace(/^\.\//, ''))), `icon -> ${rel}`).toBe(true);
    }
  });

  it('gives every declared extension a DispatchInfo block', () => {
    const body = stripComments(xml);
    const declared = [...body.matchAll(/<ExtensionList>([\s\S]*?)<\/ExtensionList>/g)]
      .flatMap((m) => [...m[1].matchAll(/<Extension\b[^>]*>/g)])
      .map((m) => attr(m[0], 'Id'));
    const dispatched = [...body.matchAll(/<DispatchInfoList>([\s\S]*?)<\/DispatchInfoList>/g)]
      .flatMap((m) => [...m[1].matchAll(/<Extension\b[^>]*>/g)])
      .map((m) => attr(m[0], 'Id'));

    expect(declared.length).toBeGreaterThan(0);
    for (const id of declared) expect(dispatched, `${id} has no DispatchInfo`).toContain(id);
    for (const id of dispatched) expect(declared, `${id} is dispatched but never declared`).toContain(id);
  });
});

describe('.debug', () => {
  const dbg = read(DEBUG);

  it('contains no double hyphen inside a comment', () => {
    for (const c of comments(dbg)) {
      expect(c.includes('--'), `illegal "--" in comment: ${c.trim().slice(0, 80)}`).toBe(false);
    }
  });

  it('is well formed enough to parse', () => {
    expect(tagBalance(dbg)).toBe(null);
  });

  it('only lists extensions the manifest actually declares', () => {
    const manifestIds = [...stripComments(read(MANIFEST)).matchAll(/<Extension\b[^>]*>/g)]
      .map((m) => attr(m[0], 'Id'))
      .filter(Boolean);
    const debugIds = [...stripComments(dbg).matchAll(/<Extension\b[^>]*>/g)]
      .map((m) => attr(m[0], 'Id'))
      .filter(Boolean);

    expect(debugIds.length).toBeGreaterThan(0);
    for (const id of debugIds) {
      expect(manifestIds, `.debug maps a port to ${id}, which the manifest does not declare`).toContain(id);
    }
  });

  it('gives each extension a unique port', () => {
    const ports = [...dbg.matchAll(/Port\s*=\s*"(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ports).size).toBe(ports.length);
  });
});
