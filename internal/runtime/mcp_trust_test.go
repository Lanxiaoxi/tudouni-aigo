package runtime

import (
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
)

// TestMcpTrustGroupReleasesTheMountsSnapshot pins what the `a` key at an approval
// means.
//
// Without this wiring the key is unreachable — `AskerFactory(memory, nil)` removes
// it entirely — and the only symptom is that a person approving an external server's
// tools does it one at a time, forever, with nothing saying why.
func TestMcpTrustGroupReleasesTheMountsSnapshot(t *testing.T) {
	runtimeValue := &Runtime{mcpMounts: map[string]*mcpMount{
		"github": {tools: []string{"github__create_issue", "github__list_prs"}},
		"linear": {tools: []string{"linear__create_ticket"}},
	}}

	group, ok := runtimeValue.McpTrustGroup("github__list_prs")
	if !ok {
		t.Fatal("a mounted server's tool was not recognised")
	}
	if group.Label != "github" {
		t.Errorf("label = %q, want github", group.Label)
	}
	if len(group.Tools) != 2 {
		t.Errorf("group has %d tools, want 2", len(group.Tools))
	}

	group, ok = runtimeValue.McpTrustGroup("linear__create_ticket")
	if !ok || group.Label != "linear" {
		t.Errorf("the second server was not recognised: %+v ok=%v", group, ok)
	}

	if _, ok := runtimeValue.McpTrustGroup("read_file"); ok {
		t.Error("a built-in tool was reported as belonging to an MCP server")
	}
	if _, ok := runtimeValue.McpTrustGroup("github__deleted_tool"); ok {
		t.Error("a tool that is not mounted was reported as belonging to a server")
	}
}

// TestTheTrustGroupIsASnapshotNotAStandingPermission is the distinction the whole
// feature turns on: what gets released is the **names that exist right now**.
//
// A release that widened itself would let a server ship a `delete_everything` tool
// tomorrow and have it run without asking, with the configuration file untouched —
// and the audit would show a release that predates the tool.
func TestTheTrustGroupIsASnapshotNotAStandingPermission(t *testing.T) {
	mount := &mcpMount{tools: []string{"srv__a", "srv__b"}}
	runtimeValue := &Runtime{mcpMounts: map[string]*mcpMount{"srv": mount}}

	group, ok := runtimeValue.McpTrustGroup("srv__a")
	if !ok {
		t.Fatal("srv__a was not recognised")
	}

	// The server adds a tool after the release.
	mount.tools = append(mount.tools, "srv__delete_everything")

	// The group handed out earlier did not grow: it is a copy of the names at the
	// moment it was produced.
	if len(group.Tools) != 2 {
		t.Errorf("the released group grew to %d names: %v", len(group.Tools), group.Tools)
	}
	for _, name := range group.Tools {
		if name == "srv__delete_everything" {
			t.Error("a tool added later was included in an earlier release")
		}
	}
	// A release taken now does see it, which is the intended behaviour: the person
	// is being asked about the server as it is.
	fresh, _ := runtimeValue.McpTrustGroup("srv__delete_everything")
	if len(fresh.Tools) != 3 {
		t.Errorf("a fresh lookup has %d names, want 3", len(fresh.Tools))
	}
}

// TestAnUnloadedServerOffersNoGroup: the lookup reads the mounts that are running
// now. A server that was just unloaded must not still be offering "all 12 of its
// tools" while three of them no longer exist.
func TestAnUnloadedServerOffersNoGroup(t *testing.T) {
	runtimeValue := &Runtime{mcpMounts: map[string]*mcpMount{
		"srv": {tools: []string{"srv__a"}},
	}}
	if _, ok := runtimeValue.McpTrustGroup("srv__a"); !ok {
		t.Fatal("the mounted tool was not recognised")
	}

	delete(runtimeValue.mcpMounts, "srv")
	if _, ok := runtimeValue.McpTrustGroup("srv__a"); ok {
		t.Error("an unloaded server still offers a trust group")
	}
}

// TestTheTrustGroupIsTheShapeSecurityWants keeps the two packages agreeing without
// an import either way: this is a compile-time check that the value satisfies the
// lookup signature the asker is built with.
var _ security.TrustGroupLookup = (&Runtime{}).McpTrustGroup
