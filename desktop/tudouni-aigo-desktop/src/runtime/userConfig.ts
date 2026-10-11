/**
 * `~/.tudouni/config.json` and `mcp.json`, as the config panel works with them.
 *
 * The shapes mirror what the Rust side sends (`src-tauri/src/config_file.rs`,
 * which serialises camelCase), and the rules mirror what the **runtime** accepts:
 * `internal/state/catalog.go` decides which keys exist and what they may hold,
 * and `internal/runtime/config.go` does the same for `mcp.json`.
 *
 * **The validation here is a pre-check, not the authority.** It exists so a typo
 * is refused while the field is still under the cursor, instead of after a save
 * that writes nothing. The Rust side re-checks every one of these and is what
 * decides whether bytes reach the disk, and the Go runtime refuses the file on
 * read either way. Three voices saying the same thing is not drift as long as it
 * is clear which one is final — the same arrangement `runtime/paste.ts` uses for
 * pasted pictures.
 *
 * One rule is load-bearing rather than tidy: **a patch always carries every route
 * that was read.** The Rust merge lays the routes out in the order the patch
 * lists them, so a route missing from the patch is a route removed from the file
 * — and the order is what picks the default route
 * (`Registry.DefaultProvider`: the first route with a key).
 */

/** `key → value`, in the file's own order. */
export interface Pair {
  key: string;
  value: string;
}

export interface ModelView {
  id: string;
  label: string;
  /** Null means the catalogue does not know it, and the interface then reports
   *  usage without a percentage — a wrong percentage is worse than none. */
  contextWindow: number | null;
  summary: string;
  note: string;
  vision: boolean;
  /** Empty means "the model's own default", which the runtime resolves to `high`. */
  reasoningEffort: string;
  effortLevels: string[];
}

export interface RouteView {
  name: string;
  displayName: string;
  baseUrl: string;
  /** Empty is a real state, not a missing value: it is how the file says "this
   *  route is not usable yet", and it is the line somebody comes back to paste
   *  into. `Provider.Usable()` is exactly this test. */
  apiKey: string;
  /** Empty means "work it out from `base_url`", which is right for almost every
   *  route. */
  apiStyle: string;
  verify: boolean;
  headers: Pair[];
  effortLevels: string[];
  models: ModelView[];
}

export interface WebView {
  tavilyApiKey: string;
  tavilyBaseUrl: string;
}

export interface McpServerView {
  name: string;
  command: string;
  url: string;
  args: string[];
  env: Pair[];
  headers: Pair[];
  timeoutSeconds: number | null;
}

export interface McpDocumentView {
  path: string;
  exists: boolean;
  /** Non-null means the panel will not write this file. */
  problem: string | null;
  servers: McpServerView[];
}

export interface ConfigDocument {
  path: string;
  exists: boolean;
  /** Non-null means the panel will not write this file, and shows why. */
  problem: string | null;
  providers: RouteView[];
  web: WebView;
  mcp: McpDocumentView;
}

/**
 * The three wire protocols, mirroring `state.styles` in the Go catalogue.
 *
 * A list rather than free text, and that is not a convenience: `styleField`
 * **refuses** a value it does not recognise rather than falling back to `openai`,
 * because a route that silently speaks the wrong protocol produces errors from
 * the endpoint that name the endpoint instead of the line that is wrong. So a
 * closed set of three is the truth, and a text field would invite a fourth.
 *
 * The empty string is the first entry and means "infer it from `base_url`" —
 * which is the right answer for almost every route, so it is what the select
 * shows until somebody says otherwise.
 */
export const API_STYLES = ['', 'openai', 'anthropic', 'responses'] as const;

export interface ConfigPatch {
  /** Omitted means "do not touch this section". An empty array is a real
   *  statement — it removes every route — so the two are never conflated. */
  providers?: RouteView[];
  web?: WebView;
  mcp?: McpServerView[];
}

export interface Draft {
  providers: RouteView[];
  web: WebView;
  mcp: McpServerView[];
}

export function emptyModel(): ModelView {
  return {
    id: '',
    label: '',
    contextWindow: null,
    summary: '',
    note: '',
    vision: false,
    reasoningEffort: '',
    effortLevels: [],
  };
}

export function emptyRoute(): RouteView {
  return {
    name: '',
    displayName: '',
    baseUrl: '',
    apiKey: '',
    apiStyle: '',
    // The catalogue's default (`flagField` with a true fallback): a route that
    // says nothing about TLS verification is verified.
    verify: true,
    headers: [],
    effortLevels: [],
    models: [],
  };
}

export function emptyServer(): McpServerView {
  return {
    name: '',
    command: '',
    url: '',
    args: [],
    env: [],
    headers: [],
    timeoutSeconds: null,
  };
}

/** A deep copy, so edits never write through to the document being compared to. */
export function draftFrom(doc: ConfigDocument): Draft {
  return {
    providers: doc.providers.map((route) => ({
      ...route,
      headers: route.headers.map((pair) => ({ ...pair })),
      effortLevels: [...route.effortLevels],
      models: route.models.map((model) => ({
        ...model,
        effortLevels: [...model.effortLevels],
      })),
    })),
    web: { ...doc.web },
    mcp: doc.mcp.servers.map((server) => ({
      ...server,
      args: [...server.args],
      env: server.env.map((pair) => ({ ...pair })),
      headers: server.headers.map((pair) => ({ ...pair })),
    })),
  };
}

/**
 * One thing wrong with the draft.
 *
 * `blocking` is the distinction that matters, and it is not a severity knob for
 * looks: **a blocking problem disables the save**, so putting the wrong thing in
 * that class makes the panel refuse work it should do, and leaving something out
 * of it writes a file the runtime will complain about.
 *
 * Blocking is anything that would read-back as broken (a blank name, a missing
 * URL, two routes with one name, a bad transport) **and** the one case that is
 * destructive rather than merely wrong: saving with no routes at all removes
 * every `api_key` line from the file. "This route has no models" is *not*
 * blocking — the runtime only warns about it (`catalog.problem.no_models`, and
 * the route simply cannot be selected), and it is a normal intermediate state
 * while somebody is adding a route and has not typed its models yet.
 */
export interface Problem {
  text: string;
  blocking: boolean;
}

/**
 * Everything wrong with the draft, in the order it would be fixed.
 *
 * Empty means "nothing here is obviously wrong" — not "the file will be
 * accepted": the runtime is the authority, and its answer arrives after the
 * save. What this buys is that the ordinary mistakes are caught before anything
 * is written.
 */
export function validateDraft(draft: Draft): Problem[] {
  const problems: Problem[] = [];
  const routeNames = new Set<string>();

  if (draft.providers.length === 0) {
    problems.push({
      text: 'No route is configured. Saving this would remove every key from the file.',
      blocking: true,
    });
  }

  for (const [index, route] of draft.providers.entries()) {
    const label = route.name.trim() === '' ? `Route ${index + 1}` : `Route "${route.name.trim()}"`;
    const name = route.name.trim();

    if (name === '') {
      problems.push({ text: `${label} has no name.`, blocking: true });
    } else if (routeNames.has(name)) {
      problems.push({ text: `Two routes are both named "${name}".`, blocking: true });
    } else {
      routeNames.add(name);
    }
    if (route.baseUrl.trim() === '') {
      problems.push({ text: `${label} needs a base URL.`, blocking: true });
    }
    if (route.apiStyle !== '' && !API_STYLES.includes(route.apiStyle as (typeof API_STYLES)[number])) {
      // `styleField` refuses this outright rather than falling back to `openai`,
      // so it has to block: writing it would produce a file the runtime will not
      // open at all.
      problems.push({ text: `${label} has an unknown protocol "${route.apiStyle}".`, blocking: true });
    }

    const modelIds = new Set<string>();
    for (const [at, model] of route.models.entries()) {
      const id = model.id.trim();
      if (id === '') {
        problems.push({ text: `Model ${at + 1} on ${label} has no id.`, blocking: true });
      } else if (modelIds.has(id)) {
        problems.push({ text: `${label} lists the model "${id}" twice.`, blocking: true });
      } else {
        modelIds.add(id);
      }
      if (model.contextWindow !== null && !(Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0)) {
        problems.push({
          text: `The context window for "${id || `model ${at + 1}`}" has to be a whole number above zero, or empty.`,
          blocking: true,
        });
      }
    }
    if (route.models.length === 0) {
      // **Not blocking.** It is why the route cannot be picked, and the runtime
      // says so in as many words (`catalog.problem.no_models`) — but it says it
      // as a *problem on a session that still starts*, and an empty list is the
      // normal state of a route somebody has just added. Refusing the save here
      // would make "add a route, fill in the models" impossible to do in two
      // steps, which is how anyone would do it.
      problems.push({
        text: `${label} has no models, so it cannot be selected. You can save it and add them later.`,
        blocking: false,
      });
    }
  }

  const serverNames = new Set<string>();
  for (const [index, server] of draft.mcp.entries()) {
    const name = server.name.trim();
    const label = name === '' ? `MCP server ${index + 1}` : `MCP server "${name}"`;
    if (name === '') {
      problems.push({ text: `${label} has no name.`, blocking: true });
    } else if (serverNames.has(name)) {
      problems.push({ text: `Two MCP servers are both named "${name}".`, blocking: true });
    } else {
      serverNames.add(name);
    }

    const hasCommand = server.command.trim() !== '';
    const hasUrl = server.url.trim() !== '';
    // Both and neither are the two cases `parseMcpServers` refuses, and for the
    // same reason: they are two different transports and the file has no way to
    // say which one wins. Both would stop the session from starting.
    if (hasCommand === hasUrl) {
      problems.push({
        text: `${label} needs exactly one of a command (stdio) or a URL (remote).`,
        blocking: true,
      });
    }
    if (server.timeoutSeconds !== null && !(server.timeoutSeconds > 0)) {
      problems.push({ text: `${label} has a timeout that is not above zero.`, blocking: true });
    }
  }

  return problems;
}

/** Only the problems that must stop a save. */
export function blockingProblems(problems: Problem[]): Problem[] {
  return problems.filter((problem) => problem.blocking);
}

/**
 * What to send, given what was read and what the form now holds.
 *
 * **Only the sections that changed are sent**, because `mcp.json` is a list of
 * programs the runtime executes at startup: writing it as a side effect of
 * editing a route would create a file nobody asked for, and an empty one is a
 * different statement from a missing one.
 */
export function buildPatch(doc: ConfigDocument, draft: Draft): ConfigPatch {
  const patch: ConfigPatch = {};
  const before = draftFrom(doc);

  if (doc.problem === null && !same(before.providers, draft.providers)) {
    patch.providers = draft.providers;
  }
  if (doc.problem === null && !same(before.web, draft.web)) {
    patch.web = draft.web;
  }
  if (doc.mcp.problem === null && !same(before.mcp, draft.mcp)) {
    patch.mcp = draft.mcp;
  }
  return patch;
}

/** Whether there is anything for a save to do. */
export function isDirty(doc: ConfigDocument, draft: Draft): boolean {
  const patch = buildPatch(doc, draft);
  return patch.providers !== undefined || patch.web !== undefined || patch.mcp !== undefined;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Split a textarea's contents into one entry per non-blank line. */
export function linesOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** The inverse, for a field that shows a list as one entry per line. */
export function textOfLines(lines: string[]): string {
  return lines.join('\n');
}

/**
 * `key = value` pairs as one-per-line text.
 *
 * A textarea rather than a two-column editor, because the pair lists here are
 * short, they are read as a block ("what does this route send with every
 * request"), and a pair editor costs a delete button per row for four rows.
 *
 * Only the **first** `=` separates, so a value may contain one — a bearer token
 * or a URL with a query is a plausible header value and truncating it at the
 * second `=` would corrupt it silently.
 */
export function textOfPairs(pairs: Pair[]): string {
  return pairs.map((pair) => `${pair.key} = ${pair.value}`).join('\n');
}

/**
 * The inverse. A line with no `=` is treated as a name with an empty value
 * rather than dropped: `"x-opencode-session"` alone is somebody who has not
 * typed the value yet, and silently discarding the line would make it vanish on
 * the next render.
 */
export function pairsOfText(text: string): Pair[] {
  const out: Pair[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const at = trimmed.indexOf('=');
    const key = (at < 0 ? trimmed : trimmed.slice(0, at)).trim();
    // The value is **not** trimmed: `headersField` keeps header values verbatim,
    // and a leading space can be meaningful in a value while it never is in a
    // name.
    const value = at < 0 ? '' : trimmed.slice(at + 1).replace(/^ /, '');
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, value });
  }
  return out;
}

/** Move one entry, for the reorder controls. Returns the list unchanged at the edges. */
export function moved<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from < 0 || from >= list.length || from === to) return list;
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item as T);
  return out;
}
