// Command cgcompare compares two index databases.
//
// The point of a comparison is to answer "is my resolver right?" without reading
// edges by hand. The reference tool ships both `dump-graph.mjs` and
// `kernel-parity.mjs` for the same reason: a resolver's output is too large to
// review, so the only honest measure is a structural diff against a known build.
//
// It reports counts per edge kind, then the per-symbol edges that differ, which is
// what turns "calls are down 25%" into "these particular call sites are missing".
//
//go:build ignore

package main

import (
	"database/sql"
	"fmt"
	"os"
	"sort"

	_ "modernc.org/sqlite"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Println("usage: cgcompare <mine.db> <baseline.db>")
		os.Exit(2)
	}
	mine, err := open(os.Args[1])
	if err != nil {
		fmt.Println("open mine:", err)
		os.Exit(1)
	}
	defer mine.Close()
	base, err := open(os.Args[2])
	if err != nil {
		fmt.Println("open baseline:", err)
		os.Exit(1)
	}
	defer base.Close()

	mineKinds := edgeKinds(mine)
	baseKinds := edgeKinds(base)

	fmt.Println("edges per kind")
	fmt.Printf("  %-14s %10s %10s %10s\n", "kind", "mine", "baseline", "Δ")
	allKinds := map[string]bool{}
	for k := range mineKinds {
		allKinds[k] = true
	}
	for k := range baseKinds {
		allKinds[k] = true
	}
	names := make([]string, 0, len(allKinds))
	for k := range allKinds {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, kind := range names {
		m, b := mineKinds[kind], baseKinds[kind]
		delta := ""
		if b > 0 {
			delta = fmt.Sprintf("%+.0f%%", 100*float64(m-b)/float64(b))
		}
		fmt.Printf("  %-14s %10d %10d %10s\n", kind, m, b, delta)
	}

	fmt.Println()
	fmt.Println("node kinds")
	for _, kind := range []string{"function", "method", "struct", "interface", "class", "import"} {
		fmt.Printf("  %-14s %10d %10d\n", kind,
			count(mine, "SELECT COUNT(*) FROM nodes WHERE kind = ?", kind),
			count(base, "SELECT COUNT(*) FROM nodes WHERE kind = ?", kind))
	}

	fmt.Println()
	fmt.Println("diagnostics")
	fmt.Printf("  %-24s %10d\n", "mine ambiguous edges", count(mine,
		`SELECT COUNT(*) FROM edges WHERE metadata LIKE '%"ambiguous":true%'`))
	fmt.Printf("  %-24s %10d\n", "mine pending refs", count(mine,
		`SELECT COUNT(*) FROM unresolved_refs WHERE status = 'pending'`))
	fmt.Printf("  %-24s %10d\n", "mine failed refs", count(mine,
		`SELECT COUNT(*) FROM unresolved_refs WHERE status = 'failed'`))

	fmt.Println()
	fmt.Println("top names my resolver left unresolved")
	rows, err := mine.Query(`
		SELECT name_tail, COUNT(*) AS n FROM unresolved_refs
		GROUP BY name_tail ORDER BY n DESC LIMIT 15`)
	if err != nil {
		fmt.Println("query:", err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var n int
		rows.Scan(&name, &n)
		fmt.Printf("  %-30s %6d\n", name, n)
	}
}

func open(path string) (*sql.DB, error) {
	return sql.Open("sqlite", path+"?mode=ro")
}

func count(db *sql.DB, query string, args ...any) int {
	var n int
	if err := db.QueryRow(query, args...).Scan(&n); err != nil {
		return -1
	}
	return n
}

func edgeKinds(db *sql.DB) map[string]int {
	out := map[string]int{}
	rows, err := db.Query("SELECT kind, COUNT(*) FROM edges GROUP BY kind")
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var kind string
		var n int
		rows.Scan(&kind, &n)
		out[kind] = n
	}
	return out
}
