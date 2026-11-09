//! Glob matching, shared by `filter` in `sources.json` and by the probes that
//! take a name pattern (`git.local` branches, `dir` pattern).
//!
//! Deliberately tiny: `*` is any run of characters, `?` is one character, and
//! matching ignores case. A full glob (classes, braces) would invite configs
//! this layer has no reason to support; anything cleverer belongs in a
//! `command` probe.

/// Whether `text` matches `pattern`, ignoring case.
pub(crate) fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    // Iterative match with one backtrack point: linear in practice and no
    // recursion depth to worry about on long paths.
    let (mut pi, mut ti) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut mark = 0usize;
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::glob_match;

    #[test]
    fn literals_stars_and_question_marks() {
        assert!(glob_match("main", "main"));
        assert!(glob_match("MAIN", "main"));
        assert!(!glob_match("main", "mainline"));
        assert!(glob_match("release/*", "release/1.2"));
        assert!(glob_match("*", ""));
        assert!(glob_match("v?.?", "v1.2"));
        assert!(!glob_match("v?.?", "v1.23"));
        assert!(glob_match("*fix*", "hotfix-login"));
        assert!(glob_match("a*b*c", "aXXbYYc"));
        assert!(!glob_match("a*b*c", "aXXbYY"));
    }
}
