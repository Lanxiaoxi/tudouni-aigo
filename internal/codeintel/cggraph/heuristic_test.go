package cggraph

import "testing"

// The line-based C/C++ reader. Its rules are what decide whether a macro-heavy header that
// the grammar rejects still yields something a reader can use — and, just as importantly,
// whether it stays quiet about what it cannot see.

// cSample is a small file exercising every rule at once.
const cSample = `/* licence block
   spanning lines */
#include <stdio.h>
#include "local.h"

#ifndef SAMPLE_H
#define SAMPLE_H

#define MAX_ITEMS 128
#define SQUARE(x) ((x) * (x))

typedef struct UT_hash_bucket {
    struct UT_hash_handle *hh_head;
    unsigned count;
} UT_hash_bucket;

struct Point {
    int x;
    int y;
};

typedef unsigned long ulong_t;

static int helper(int value) {
    return value + 1;
}

int main(void) {
    int local = 0;
    return helper(local);
}

#endif
`

func TestHeuristicExtractKinds(t *testing.T) {
	result := HeuristicExtract("sample.c", "c", []byte(cSample))

	byKind := map[string]map[string]bool{}
	for _, node := range result.Nodes {
		if byKind[node.Kind] == nil {
			byKind[node.Kind] = map[string]bool{}
		}
		byKind[node.Kind][node.Name] = true
	}

	// Every kind the scanner claims to recognise must appear in this sample.
	for kind, want := range map[string][]string{
		"file":       {"sample.c"},
		"import":     {"stdio.h", "local.h"},
		"constant":   {"MAX_ITEMS", "SAMPLE_H"},
		"function":   {"SQUARE", "helper", "main"},
		"struct":     {"UT_hash_bucket", "Point"},
		"type_alias": {"ulong_t"},
		"field":      {"hh_head", "count", "x", "y"},
	} {
		for _, name := range want {
			if !byKind[kind][name] {
				t.Errorf("%s %q not extracted (have %v)", kind, name, keysOfSet(byKind[kind]))
			}
		}
	}
}

// TestHeuristicStaysOutOfFunctionBodies is the rule that keeps the index usable: a local
// declaration is not a symbol a reader looks up, and treating `int local;` as a variable
// would bury the real declarations.
func TestHeuristicStaysOutOfFunctionBodies(t *testing.T) {
	result := HeuristicExtract("sample.c", "c", []byte(cSample))
	for _, node := range result.Nodes {
		if node.Name == "local" {
			t.Errorf("local variable %q extracted as a %s node; function bodies are skipped",
				node.Name, node.Kind)
		}
	}
}

// TestHeuristicSkipsCommentsOutsideBlock verifies that a declaration mentioned inside a
// block comment produces nothing — the licence blocks at the top of every C header are full
// of code-shaped text.
func TestHeuristicSkipsCommentsInsideBlock(t *testing.T) {
	source := `/*
struct NotAStruct {
    int notAField;
};
*/
struct Real {
    int value;
};
`
	result := HeuristicExtract("x.c", "c", []byte(source))
	for _, node := range result.Nodes {
		switch node.Name {
		case "NotAStruct", "notAField":
			t.Errorf("%q extracted from inside a block comment", node.Name)
		}
	}
	found := false
	for _, node := range result.Nodes {
		if node.Name == "Real" {
			found = true
		}
	}
	if !found {
		t.Error("Real struct was not extracted")
	}
}

// TestHeuristicRecordsMacroSignatures pins why macros are stored as functions: a reader
// looking up `SQUARE` needs its parameter list, and the directive line is that.
func TestHeuristicRecordsMacroSignatures(t *testing.T) {
	result := HeuristicExtract("sample.c", "c", []byte(cSample))
	for _, node := range result.Nodes {
		if node.Kind != "function" || node.Name != "SQUARE" {
			continue
		}
		if node.Signature == "" {
			t.Fatal("macro has no signature")
		}
		if want := "#define SQUARE(x)"; len(node.Signature) < len(want) ||
			node.Signature[:len(want)] != want {
			t.Errorf("signature = %q, want it to start with %q", node.Signature, want)
		}
		return
	}
	t.Fatal("SQUARE not extracted")
}

// TestHeuristicNoCallEdges is the honest limitation, asserted rather than assumed: the scanner
// recognises no references, so no `calls` edge may appear.
func TestHeuristicNoCallEdges(t *testing.T) {
	result := HeuristicExtract("sample.c", "c", []byte(cSample))
	for _, edge := range result.Edges {
		if edge.Kind != "contains" {
			t.Errorf("edge kind %q produced; the scanner emits only containment", edge.Kind)
		}
	}
}

// TestHeuristicMultiLineMacro covers the backslash continuation, which would otherwise make
// the following lines look like declarations.
func TestHeuristicMultiLineMacro(t *testing.T) {
	source := `#define HASH_ADD(hh,head,fieldname,keylen_in,add) \
    HASH_ADD_KEYPTR(hh,head,&add->fieldname,keylen_in,add)
struct After { int v; };
`
	result := HeuristicExtract("m.c", "c", []byte(source))
	foundMacro, foundStruct := false, false
	for _, node := range result.Nodes {
		switch node.Name {
		case "HASH_ADD":
			foundMacro = true
		case "After":
			foundStruct = true
		}
	}
	if !foundMacro {
		t.Error("multi-line macro not extracted")
	}
	if !foundStruct {
		t.Error("struct after a continuation was lost")
	}
}

// TestHeuristicAnonymousTypedef covers `typedef struct { … } Name;`, where the name only
// appears on the closing line.
func TestHeuristicAnonymousTypedef(t *testing.T) {
	source := `typedef struct {
    int a;
} Named;
`
	result := HeuristicExtract("t.c", "c", []byte(source))
	found := false
	for _, node := range result.Nodes {
		if node.Kind == "struct" && node.Name == "Named" {
			found = true
			if node.EndLine < 3 {
				t.Errorf("struct Named ends at line %d, want the closing brace's line", node.EndLine)
			}
		}
	}
	if !found {
		t.Error("anonymous typedef's name not recovered from its closing line")
	}
}

func keysOfSet(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
