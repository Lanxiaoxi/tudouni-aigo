package host

import (
	"errors"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/gitinfo"
)

// handleGit serves `git_status` and `git_diff`. Both are read-only.
func (h *Host) handleGit(t string, msg map[string]any) (any, *wireError) {
	switch t {
	case MsgGitStatus:
		status, err := gitinfo.GetStatus(h.reqCtx, h.root)
		if err != nil {
			return nil, gitError(err)
		}
		return status, nil
	case MsgGitDiff:
		// The path crosses the same boundary as every file path before it is turned
		// into a git argument; gitinfo then treats it as a literal pathspec.
		target, werr := h.files.resolve(argString(msg, "path"))
		if werr != nil {
			return nil, werr
		}
		if target.rel == "" {
			return nil, errf(CodeBadRequest, "path must name a file")
		}
		source := argString(msg, "source")
		if source == "" {
			source = gitinfo.SourceWorktree
		}
		switch source {
		case gitinfo.SourceWorktree, gitinfo.SourceIndex, gitinfo.SourceUntracked:
		default:
			return nil, errf(CodeBadRequest, "source must be worktree, index or untracked")
		}
		result, err := gitinfo.GetDiff(h.reqCtx, h.root, target.rel, source)
		if err != nil {
			return nil, gitError(err)
		}
		return result, nil
	}
	return nil, errf(CodeUnsupported, "unknown message %q", t)
}

func gitError(err error) *wireError {
	switch {
	case errors.Is(err, gitinfo.ErrNoGit), errors.Is(err, gitinfo.ErrNotRepo):
		return errf(CodeNotGit, "%s", err.Error())
	case errors.Is(err, gitinfo.ErrBadPath):
		return errf(CodeBadRequest, "%s", err.Error())
	}
	return errf(CodeInternal, "%s", err.Error())
}
