package tui

import (
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// commandInfo is one entry of the palette: what to type, and what it does.
//
// The hint and the detail live in the catalogue rather than in the renderer so
// the two front ends describe the same command the same way. The order is the
// original's: it is the order people learned, and the palette is a list they
// scan by position.
type commandInfo struct {
	name   string
	hint   string
	detail string
}

// commands is the palette's content, in display order.
//
// It is rebuilt on every call because the strings are language-dependent at
// run time — and because a package-level table initialised at import time would
// freeze whatever language happened to be active then.
func commands() []commandInfo {
	table := []struct {
		name   string
		hasArg bool
	}{
		{"/new", false},
		{"/resume", true},
		{"/audit", false},
		{"/exit", false},
		{"/help", false},
		{"/theme", true},
		{"/skills", false},
		{"/autopilot", false},
		{"/quiet", true},
		{"/status", false},
		{"/tools", false},
		{"/context", false},
		{"/compact", false},
		{"/model", true},
		{"/thinking", true},
		{"/effort", true},
		{"/mcp", true},
	}
	out := make([]commandInfo, 0, len(table))
	for _, row := range table {
		key := strings.TrimPrefix(row.name, "/")
		info := commandInfo{
			name: row.name,
			hint: i18n.LookupOr("cmd."+key+".hint", ""),
		}
		if row.hasArg {
			info.detail = i18n.LookupOr("cmd."+key+".detail", "")
		}
		out = append(out, info)
	}
	return out
}

// filterCommands narrows the palette by what has been typed so far.
//
// Prefix matching, not fuzzy: with seventeen commands, fuzzy matching makes "I
// mistyped" and "it guessed right" look identical, and the list is short enough
// that a prefix is never more than two keystrokes away.
func filterCommands(query string) []commandInfo {
	query = strings.ToLower(strings.TrimSpace(query))
	out := make([]commandInfo, 0, len(commands()))
	for _, command := range commands() {
		name := strings.ToLower(strings.TrimPrefix(command.name, "/"))
		if query == "" || strings.HasPrefix(name, query) {
			out = append(out, command)
		}
	}
	return out
}
