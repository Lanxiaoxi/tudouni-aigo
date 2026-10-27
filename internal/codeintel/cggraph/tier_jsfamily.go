package cggraph

// The TypeScript / JavaScript language tier.
//
// The largest of the tiers, because the JS family has the most varied scoping of the
// languages in scope: three module systems that coexist (`import`/`export`, CommonJS
// `require`/`module.exports`, and ambient globals), plus path aliases (`@/foo`), plus a
// distinction between type-only and value imports that changes what is in scope.
//
// Rules ported from CodeGraph's JS/TS handling:
//
//	name-matcher.ts   isVisibleAcrossFiles's JS arm — the "sealed module" rule
//	import-resolver.ts path-aliases.ts — `@/x` and `baseUrl` mapping
//	extraction        import/export nodes and their bindings
//
// The rule that carries the most weight is the reference implementation's own recorded
// failure: a module that exports NOTHING (it has an `import` but no `export`, no CommonJS
// export and no `declare global`) is sealed, and nothing outside can name its bindings.
// Without that check, the vite playground's `const vite = await createServer(…)` took 157
// `import { defineConfig } from 'vite'` edges.
//
// Deliberately NOT ported: type-aware narrowing (a generic parameter is already rejected
// centrally by IsGenericTypeParameter) and the router/framework synthesizers
// (`next-router`, `react-router`, `expo-router`, `sveltekit`, `tanstack`). Those exist to
// link URL patterns to handlers, which is a different capability from name resolution.

import (
	"path/filepath"
	"regexp"
	"strings"
)

// jsTier implements LanguageTier for the JS family.
type jsTier struct {
	language string
	// r is the resolver the tier is registered on: the alias table it resolves
	// against is looked up per reference (the file's own repo), because each
	// repo's tsconfig is a different fact in a multi-repo index.
	r *Resolver
	// aliases is the single-repo form, kept for tests that build a tier
	// without a resolver.
	aliases map[string]string
}

func (t *jsTier) Name() string { return t.language }

// jsLanguages are the languages this tier serves. They share scoping rules closely
// enough that one implementation covers all five.
var jsLanguages = []string{"typescript", "tsx", "javascript", "jsx", "arkts"}

// Visible applies the sealed-module rule.
//
// A module that exports nothing is not importable, so its bindings are unreachable from
// another file. That is what makes `const vite = …` in a script file invisible to the
// rest of the tree.
//
// "Exports nothing" is decided by the reference implementation's three exemptions, all of
// which keep a file open: a classic script (no import and no export at all), a CommonJS
// module (`module.exports` / `exports.x`), and an ambient declaration
// (`declare global`). A file with an `import` and no `export` is the sealed case.
func (t *jsTier) Visible(candidate *Candidate, ref *pendingRef) bool {
	if normalizeSlash(candidate.FilePath) == normalizeSlash(ref.FromFileName) {
		return true
	}
	if !jsFamily(candidate.Language) {
		return true
	}
	sealed := jsModuleIsSealed(candidate.FilePath)
	if !sealed {
		return true
	}
	// A sealed module's bindings are file-local.
	return false
}

// jsSealedRE decides whether a file exports anything.
//
// Three patterns, each a way a module stays open: an `export` keyword in any form, a
// CommonJS export, or an ambient global. The check is on text because that is what the
// reference implementation does too — it is looking for the presence of a construct, not
// parsing one.
var (
	jsExportRE    = regexp.MustCompile(`(?m)^\s*export\b|\bexports\.|\bmodule\.exports\b`)
	jsImportRE    = regexp.MustCompile(`(?m)^\s*import\b|\brequire\s*\(`)
	jsAmbientRE   = regexp.MustCompile(`(?m)\bdeclare\s+global\b`)
	jsSealedCache = map[string]bool{}
)

// jsModuleIsSealed reports whether a module exports nothing while importing something.
//
// A classic script (no import, no export) is NOT sealed: its declarations are globals,
// which is precisely how a non-module script is meant to work.
func jsModuleIsSealed(filePath string) bool {
	key := normalizeSlash(filePath)
	if sealed, ok := jsSealedCache[key]; ok {
		return sealed
	}
	text := readSourceText(filePath)
	sealed := false
	if text != "" {
		hasExport := jsExportRE.MatchString(text)
		hasImport := jsImportRE.MatchString(text)
		hasAmbient := jsAmbientRE.MatchString(text)
		sealed = hasImport && !hasExport && !hasAmbient
	}
	jsSealedCache[key] = sealed
	return sealed
}

// Narrow restricts candidates using the file's imports and path aliases.
func (t *jsTier) Narrow(ref *pendingRef, imports map[string]Import, candidates []Candidate) ([]Candidate, bool) {
	qualifier, _, unqualified := SplitGoQualified(ref.Name)
	if unqualified || qualifier == "" {
		return candidates, false
	}
	// A JS qualifier is a value (`obj.method`), a namespace import (`api.fetch`), or a
	// class (`Store.get`). Only the namespace-import case narrows.
	imported, ok := imports[qualifier]
	if !ok {
		return candidates, false
	}
	if imported.Path == "" {
		return candidates, false
	}
	// A bare package specifier (`react`, `lodash`) names a dependency, not a file here.
	// A relative or aliased path names a module in this tree.
	target := t.resolveSpecifier(imported.Path, ref.FromFileName)
	if target == "" {
		// The specifier points at a dependency: nothing in this tree is its target.
		return nil, true
	}

	var narrowed []Candidate
	for _, cand := range candidates {
		normalized := normalizeSlash(cand.FilePath)
		if strings.HasSuffix(normalized, normalizeSlash(target)) ||
			strings.HasSuffix(normalized, normalizeSlash(strings.TrimSuffix(target, filepath.Ext(target)))) {
			narrowed = append(narrowed, cand)
		}
	}
	if len(narrowed) == 0 {
		return candidates, false
	}
	return narrowed, true
}

// resolveSpecifier turns an import specifier into a repository-relative path.
//
// Three forms:
//
//	./foo     relative to the importing file
//	@/foo     through a path alias (tsconfig `paths`)
//	foo       a bare specifier — a dependency, with no file here
//
// The extension may be absent (`./foo` meaning `./foo.ts`), which is why the caller
// compares by prefix rather than equality.
func (t *jsTier) resolveSpecifier(specifier, fromFile string) string {
	spec := strings.TrimSpace(specifier)
	if spec == "" {
		return ""
	}
	if strings.HasPrefix(spec, "./") || strings.HasPrefix(spec, "../") {
		dir := filepath.ToSlash(filepath.Dir(fromFile))
		joined := filepath.ToSlash(filepath.Join(dir, spec))
		return strings.TrimPrefix(joined, "./")
	}
	// A path alias: the longest matching prefix wins, so `@/components` beats `@/`.
	aliases := t.aliases
	if t.r != nil {
		aliases = t.r.aliasesFor(fromFile)
	}
	if aliases != nil {
		bestPrefix := ""
		for prefix := range t.aliases {
			if !strings.HasPrefix(spec, prefix) {
				continue
			}
			if len(prefix) > len(bestPrefix) {
				bestPrefix = prefix
			}
		}
		if bestPrefix != "" {
			rest := strings.TrimPrefix(spec, bestPrefix)
			return filepath.ToSlash(filepath.Join(t.aliases[bestPrefix], rest))
		}
	}
	// A bare specifier names a dependency.
	return ""
}

// ReceiverType returns "" — JS receiver inference needs type information.
func (t *jsTier) ReceiverType(ref *pendingRef, file *sourceFile) string { return "" }

// IsBuiltin applies the JS global-namespace rule.
func (t *jsTier) IsBuiltin(name string) bool { return jsGlobals[name] }

// jsGlobals are the names the JS/TS runtime and lib.d.ts put in scope everywhere.
//
// A reference to one is never a project definition — `Object`, `Promise`, `console` are
// the runtime's. The list is the lib's broadly-used surface, not its entirety.
var jsGlobals = map[string]bool{
	// Language builtins.
	"Object": true, "Function": true, "Boolean": true, "Symbol": true,
	"Number": true, "BigInt": true, "Math": true, "Date": true, "String": true,
	"RegExp": true, "Array": true, "Map": true, "Set": true, "WeakMap": true,
	"WeakSet": true, "WeakRef": true, "Promise": true, "Proxy": true,
	"Reflect": true, "JSON": true, "Intl": true, "Error": true, "TypeError": true,
	"RangeError": true, "SyntaxError": true, "ReferenceError": true,
	"EvalError": true, "URIError": true, "ArrayBuffer": true,
	"SharedArrayBuffer": true, "DataView": true, "Atomics": true,
	"Infinity": true, "NaN": true, "undefined": true, "globalThis": true,
	"parseInt": true, "parseFloat": true, "isNaN": true, "isFinite": true,
	"encodeURI": true, "decodeURI": true, "encodeURIComponent": true,
	"decodeURIComponent": true, "eval": true,
	// Typed arrays.
	"Int8Array": true, "Uint8Array": true, "Uint8ClampedArray": true,
	"Int16Array": true, "Uint16Array": true, "Int32Array": true,
	"Uint32Array": true, "Float32Array": true, "Float64Array": true,
	"BigInt64Array": true, "BigUint64Array": true,
	// Host globals.
	"console": true, "window": true, "document": true, "navigator": true,
	"location": true, "history": true, "localStorage": true, "sessionStorage": true,
	"fetch": true, "Headers": true, "Request": true, "Response": true,
	"URL": true, "URLSearchParams": true, "Blob": true, "File": true,
	"FormData": true, "AbortController": true, "AbortSignal": true,
	"setTimeout": true, "clearTimeout": true, "setInterval": true,
	"clearInterval": true, "requestAnimationFrame": true,
	"cancelAnimationFrame": true, "queueMicrotask": true, "structuredClone": true,
	"process": true, "Buffer": true, "global": true, "require": true,
	"module": true, "exports": true, "__dirname": true, "__filename": true,
	// TS utility types.
	"Partial": true, "Required": true, "Readonly": true, "Record": true,
	"Pick": true, "Omit": true, "Exclude": true, "Extract": true,
	"NonNullable": true, "Parameters": true, "ReturnType": true,
	"Awaited": true, "PromiseLike": true, "InstanceType": true,
	"Uppercase": true, "Lowercase": true, "Capitalize": true,
	"Uncapitalize": true, "ThisType": true,
}
