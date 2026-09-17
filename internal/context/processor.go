package context

// Tool output becoming an Artifact.
//
// This is the only place that enforces "a tool result never enters the context
// directly": tools produce information, and this turns that information into
// something that can be referenced later.
//
// Why a processor rather than tools creating their own artifacts: tools keep
// being added, and the context layer should not change along with them. "What
// artifacts did this search produce" is the search tool's knowledge, not the
// context's — so the layer is a **strategy registered per tool name**, with one
// default that handles everything and a couple of tools supplying extra shape.
//
//	read_file  → body + path and line count
//	grep       → body + hits and pattern
//	shell      → body + command and exit code
//	fetch_web  → body + URL and status code
//
// The default — one tool call, one artifact — is not laziness, it is what makes
// replay complete. History stores a reference, so every piece of content has to
// have an artifact behind it. Miss one and the model can never see that tool
// result again, and it looks like "the tool returned nothing" rather than like a
// bug.

// ToolExecution is everything one tool call amounted to.
//
// It is one value rather than four parameters because a strategy asks "what
// shape is this result", and the four things it needs (which tool, what
// arguments, what came back, how it ended) are exactly the notion of "one call".
// Spread out, every new field would change every strategy's signature.
type ToolExecution struct {
	Tool      string
	Arguments map[string]any
	// Text is what the model would see if there were no artifact layer.
	Text string
	// Audit carries the tool's own audit fields; they are copied into the
	// artifact metadata, because metadata is where "facts that came with this
	// information" belong.
	Audit map[string]any
	// Status is ok / denied / invalid_args / error — the same vocabulary the
	// audit uses.
	Status string
}

// Strategy turns one execution into one artifact. The artifact is already in the
// store when a strategy returns: the processor is the only writer, so "what
// became an artifact" has exactly one answer.
type Strategy func(store *ArtifactStore, execution ToolExecution) (Artifact, error)

// ToolResultProcessor maps executions to artifacts, customisable per tool.
//
// The customisation is deliberately small: a strategy decides what **extra**
// metadata to record, never whether an artifact is recorded at all. Allowing
// "skip this one" would leave a reference in history pointing at nothing.
type ToolResultProcessor struct {
	strategies map[string]Strategy
}

// NewToolResultProcessor builds an empty processor.
func NewToolResultProcessor() *ToolResultProcessor {
	return &ToolResultProcessor{strategies: map[string]Strategy{}}
}

// Register attaches a strategy to a tool name. A later registration of the same
// name wins.
//
// Overriding rather than refusing: strategies are registered at assembly time by
// tool name, and MCP tools are attached **while running** with names somebody
// else chose. Refusing would mean an external tool that happens to be called
// `read_file` crashes assembly — and that is not the user's fault.
func (p *ToolResultProcessor) Register(tool string, strategy Strategy) {
	p.strategies[tool] = strategy
}

// Process returns the artifacts this execution produced. **At least one.**
//
// The first is always the default one (the body as-is); strategies only add
// after it. The order is on purpose: callers use result[0] as "the tool result"
// to put in the context, and "there is also a summary artifact" should not
// change which one that is.
func (p *ToolResultProcessor) Process(store *ArtifactStore, execution ToolExecution) ([]Artifact, error) {
	primary, err := p.primary(store, execution)
	if err != nil {
		return nil, err
	}
	return []Artifact{primary}, nil
}

func (p *ToolResultProcessor) primary(store *ArtifactStore, execution ToolExecution) (Artifact, error) {
	if strategy, ok := p.strategies[execution.Tool]; ok {
		return strategy(store, execution)
	}
	return DefaultStrategy(store, execution)
}

// DefaultStrategy records the whole body as one artifact, typed coarsely by tool
// name.
//
// The type only affects how a range is sliced, so it does not need to be
// precise. What needs to be precise is the metadata, and that is each tool's
// strategy to add.
func DefaultStrategy(store *ArtifactStore, execution ToolExecution) (Artifact, error) {
	return store.Create(execution.Text, typeOf(execution.Tool),
		ArtifactSource{Tool: execution.Tool}, baseMetadata(execution))
}

// FilesystemStrategy records the path and the line count.
//
// Those two are the entire basis of the range level: when the model says "give
// me lines 1800-1900", the renderer has to know this artifact really is that
// file and how many lines it has.
func FilesystemStrategy(store *ArtifactStore, execution ToolExecution) (Artifact, error) {
	path := stringArg(execution.Arguments, "path")
	metadata := baseMetadata(execution)
	metadata["path"] = path
	metadata["lines"] = CountLines(execution.Text)

	// Only read_file is "a file body". write_file and edit_file return a
	// sentence, and typing that as a file makes the range level slice a sentence
	// with no lines in it.
	kind := "text"
	if execution.Tool == "read_file" {
		kind = "file"
	}
	return store.Create(execution.Text, kind,
		ArtifactSource{Tool: execution.Tool, Path: path}, metadata)
}

// SearchStrategy records what was searched for.
func SearchStrategy(store *ArtifactStore, execution ToolExecution) (Artifact, error) {
	metadata := baseMetadata(execution)
	for _, key := range []string{"pattern", "query", "path", "include"} {
		// Empty and absent are the same thing here: a metadata key that is
		// always blank reads as "this search really had no pattern".
		if value, present := execution.Arguments[key]; present && value != nil && value != "" {
			metadata[key] = value
		}
	}
	return store.Create(execution.Text, "search",
		ArtifactSource{Tool: execution.Tool}, metadata)
}

// CommandStrategy records the command line, which is the first thing anybody
// asks about afterwards.
func CommandStrategy(store *ArtifactStore, execution ToolExecution) (Artifact, error) {
	metadata := baseMetadata(execution)
	if command, ok := execution.Arguments["command"].(string); ok && command != "" {
		metadata["command"] = command
	}
	return store.Create(execution.Text, "command",
		ArtifactSource{Tool: execution.Tool}, metadata)
}

// WebStrategy records the URL, which is the page's identity.
func WebStrategy(store *ArtifactStore, execution ToolExecution) (Artifact, error) {
	metadata := baseMetadata(execution)
	url := stringArg(execution.Arguments, "url")
	if url != "" {
		metadata["url"] = url
	}
	return store.Create(execution.Text, "web",
		ArtifactSource{Tool: execution.Tool, URL: url}, metadata)
}

// DefaultProcessor is the one assembly uses: the default plus the tools that
// carry extra shape.
func DefaultProcessor() *ToolResultProcessor {
	processor := NewToolResultProcessor()
	for _, name := range []string{"read_file", "write_file", "edit_file", "list_files"} {
		processor.Register(name, FilesystemStrategy)
	}
	for _, name := range []string{"grep", "web_search"} {
		processor.Register(name, SearchStrategy)
	}
	for _, name := range []string{"shell", "shell_background", "job_output", "job_list"} {
		processor.Register(name, CommandStrategy)
	}
	processor.Register("fetch_web", WebStrategy)
	return processor
}

// baseMetadata is what every artifact carries.
func baseMetadata(execution ToolExecution) map[string]any {
	status := execution.Status
	if status == "" {
		status = "ok"
	}
	data := map[string]any{"status": status}
	// The tool's own audit fields are copied rather than dropped: they are facts
	// only the tool knows, and an artifact is where "facts attached to this
	// information" belong. The audit record still exists separately — two exits
	// serving two readers.
	for key, value := range execution.Audit {
		data[key] = value
	}
	return data
}

// CountLines counts lines the way the store splits them, so metadata and a
// snippet's TotalLines always agree.
func CountLines(text string) int {
	return len(splitLines(text))
}

// typeOf maps a tool name to a coarse type. Anything unrecognised is plain text,
// which is the only fallback that cannot be wrong.
func typeOf(tool string) string {
	switch tool {
	case "read_file", "write_file", "edit_file", "list_files":
		return "file"
	case "shell", "shell_background", "job_output", "job_list":
		return "command"
	case "grep", "web_search":
		return "search"
	case "fetch_web":
		return "web"
	default:
		return "text"
	}
}

func stringArg(arguments map[string]any, key string) string {
	// No trimming: a path is used verbatim, and "it worked in the metadata but
	// not in the header" is a difference nobody wants to debug.
	text, _ := arguments[key].(string)
	return text
}
