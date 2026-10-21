/**
 * The task-refine prompt.
 *
 * A refine run is **an ordinary session whose first message is this template
 * with the task's run history spliced in** — the same act `startLearning`
 * performs for the workspace, and the runtime does not know the word
 * "refine". What makes it a refine run is this text and nothing else.
 *
 * **English only**, for the same reason as the learning template: the
 * runtime is English-only by construction, and the transcript is read by a
 * person in this same app.
 *
 * **One candidate kind, by construction.** Refine may only propose a
 * replacement for *this* task's prompt. Generalisable findings are stated in
 * the report's Observations section and are never candidates — the
 * workspace-learning path is the only one with the evidence a general rule
 * needs (see the design's §2.2). The template says so in its own words,
 * because the agent is the only gate that will enforce it.
 *
 * **The marked block is the front end's half of the deal.** When the person
 * picks a candidate at the question, the store reads the marked block back
 * out of the session's transcript (`extractRefinePrompts`) and applies it
 * with `upsertTask`. The marker is a plain sentence, but it must survive
 * the model's own editing: the "one per candidate, never renumbered" rule
 * exists so a second candidate cannot collide with the first's number.
 */

/** The marker around a candidate's full new prompt, one block per candidate. */
export const REFINE_PROMPT_BEGIN = 'BEGIN TASK PROMPT CANDIDATE';
export const REFINE_PROMPT_END = 'END TASK PROMPT CANDIDATE';

/** The option a refine question draws per candidate, and per none. The
 *  number is the one from the marked block — the store matches the answer
 *  against it, so the two must be the same number by construction. */
export function refineOptionLabel(index: number): string {
  return `Apply candidate ${index}: replace the task prompt`;
}

export const REFINE_NONE_LABEL = 'Apply none of them';

/**
 * The runs the prompt lists, in the order the store computed them
 * (`refineRunScope` — newest first, scope applied, the failed-only variant
 * keeping one ok reference). Everything is frozen on the link, so the prompt
 * and the panel cannot describe one run two ways.
 */
export interface RefineRunEntry {
  taskName: string;
  model: string;
  workspaceLabel: string;
  startedAtMs: number;
  outcome: 'ok' | 'failed';
  durationMs: number | null;
  /** Null when the link predates the field — rendered as `(not recorded)`. */
  prompt: string | null;
  /** Workspace-relative JSONL path, or null while no session id is known. */
  sessionFile: string | null;
}

export interface RefineParams {
  taskName: string;
  /** The prompt the task carries *now* — the text any candidate improves. */
  currentPrompt: string;
  workspace: string;
  scope: { kind: 'all' } | { kind: 'last'; n: number };
  failedOnly: boolean;
  runs: RefineRunEntry[];
  /** The person's own words about where to look, when they gave any. */
  objectives: string;
}

const BODY = `You are starting a task refinement.

Your job is not to summarise past runs. It is to compare the runs of ONE task against each other, find where its prompt is the cause of recurring trouble, and propose the smallest replacement for that prompt.

## Task parameters

- Task: {{TASK_NAME}}
- Workspace: {{WORKSPACE}}
- Run scope: {{SCOPE}}
- Runs in scope: {{RUN_COUNT}}
- Focus (from the person, optional): {{OBJECTIVES}}

The runtime's workspace is the workspace of this session; the paths you work with are relative to it.

## The current prompt

This is the prompt the task sends as the first message of every run, right now. Any candidate you produce replaces it whole:

---
{{CURRENT_PROMPT}}
---

## The evidence: this task's runs

Each run below is one execution of the task, with the prompt **frozen at run time** (the task is editable, and a run's prompt is the one it had when it started — not the one above, if the two differ):

{{RUNS}}

The runs group into prompt versions. A run's \`prompt:\` line tells you its version; group by it and compare **within** a version first — runs of one version are repetitions of the same experiment, and the failures that repeat across them are the ones the prompt is responsible for. A run marked \`prompt: (not recorded)\` is older than the snapshot; use the task's own behaviour in it, and never attribute its failures to the prompt text above without checking the session file.

## Where the transcripts are

Each run's full transcript is the session file listed above, one JSONL file per session under .tudouni/sessions/. Each line is one record: {"v":1,"type":"head",...}, {"v":1,"type":"msg","message":{...}} (the transcript) and so on. Files are append-only and may be several megabytes.

A run's verdict is only a clue. The cases that matter are the ones the verdict does not show: "succeeded but took a long detour" and "did it right only after the user corrected it" are both \`ok\` in the list above and live only in the JSONL. Search across the files first to locate what is worth reading, then read the relevant ranges — do not load whole files into context. Files you cannot open are out of reach: say so in the report instead of guessing at their contents.

## Method

1. **Group by prompt version.** Same version, compared first: recurring failures, detours, retries, and user corrections within it. Across versions: which problems belong to the old prompt, and which a newer version introduced.
2. **Read the transcripts** behind the cases that matter. A \`failed\` run's failure point; an \`ok\` run's detours and corrections. The verdict column is a triage aid, not the finding.
3. **Classify every finding, and let the classification gate the prompt.** A finding is task-specific if it would not be made by a different conversation in this workspace ("the ranking table is on the second tab and must be waited on") — that is prompt material. A finding is generalisable if it would hold elsewhere too ("this site's login state expires between sessions") — that is NOT prompt material. The test is "would another session in this workspace hit this without this task", and the judgement must be made on that test rather than on a feeling. Generalisable findings are listed in the report's Observations section with their evidence, and noted for the workspace-learning path; they are never candidates, never offered at the question.
4. **Break the refine loop.** This session itself is not evidence. Earlier refine runs and learning runs of this task are not independent runs either — they read the same transcripts — and their reports are not evidence.
5. **Produce the smallest change.** A candidate is the complete new prompt text (a prompt is a whole; a diff of one is unreliable). It must keep the task's original intent and change only what the evidence says to change. State, per change, which run and which incident in it required it.

## Deliverable

Exactly one kind of candidate: **a replacement for this task's prompt.** No other kind exists for this run. You do not create, modify, or delete any workspace file — no AGENTS.md, no skills, no documents; the workspace-learning path is the only one with the evidence those need, and producing them here would lower its evidence standard.

Every candidate states: why; the expected value; the traceable evidence (which run, which part of its session file); confidence and why; scope and risks; and the full new prompt text, each inside one marked block:

\`\`\`
{{BEGIN}} (candidate {{N}})
(the complete new prompt)
{{END}}
\`\`\`

One marked block per candidate, numbered from 1 in the order the candidates are listed, the number in the block matching the number in that candidate's question option. A candidate without a block cannot be applied and must not be listed.

## Final answer

Your answer is the complete delivery:

1. What you actually compared, and how that differs from the scope given (runs whose session file was missing or unreadable, versions with a single run).
2. What the prompt versions each got wrong, with the run evidence.
3. Each candidate, as described above.
4. **Observations:** the findings you judged generalisable rather than task-specific — the symptom, the evidence run, and a note that they belong in the workspace-learning path ("Learn workspace"). These are observations, not candidates, and they are not offered at the question.
5. What you could not confirm, and the risks that remain.

A report with no candidate is a valid result when the runs hold nothing the prompt is responsible for. Do not lower the evidence bar to produce output, and do not widen the scope beyond the runs listed.

**Then ask which candidates to apply.** Once the candidates are listed, do not end with the report alone: use the ask_user tool with one option per candidate, worded exactly as \u201c{{OPTION}}\u201d for candidate 1, \u201c{{OPTION}}\u201d for candidate 2, and so on — the number in the option is the number of that candidate's marked block — plus one final option \u201c{{NONE}}\u201d. The person's choice is handled by the application: do not edit the task yourself, and do not apply a candidate the person did not select. If there are no candidates, there is nothing to ask; the report is the complete delivery.
`;

function renderScope(
  scope: { kind: 'all' } | { kind: 'last'; n: number },
  failedOnly: boolean,
  runs: RefineRunEntry[],
): string {
  const head =
    scope.kind === 'all'
      ? 'every finished run of the task'
      : `the ${scope.n} most recent finished runs of the task`;
  const tail = failedOnly
    ? ` — only the failed ones, plus the newest successful run as the reference`
    : '';
  return `${head}${tail} — ${runs.length} run${runs.length === 1 ? '' : 's'} listed`;
}

function renderRuns(runs: RefineRunEntry[]): string {
  if (runs.length === 0) return '(no finished run)';
  return runs
    .map((run) => {
      const at = new Date(run.startedAtMs).toISOString();
      const duration = run.durationMs === null ? 'duration: unknown' : `duration: ${run.durationMs}ms`;
      const prompt =
        run.prompt === null
          ? 'prompt: (not recorded)'
          : `prompt: ${run.prompt.replace(/\n/g, ' ⏎ ')}`;
      const file = run.sessionFile === null ? 'session: (id not recorded)' : `session: ${run.sessionFile}`;
      return `- ${at}  outcome: ${run.outcome}  ${duration}  model: ${run.model === '' ? '(inherited)' : run.model}  ${file}\n  ${prompt}`;
    })
    .join('\n');
}

/** Splice the run history into the template.
 *
 *  The fixed placeholders are substituted **before** any of the person's or
 *  the task's text goes in: a prompt that happens to contain `{{END}}` must
 *  not be edited by the template's own markers. */
export function buildRefineMessage(p: RefineParams): string {
  const optionWord = refineOptionLabel(0).replace(' 0', ' N');
  const fixed = BODY.replace('{{BEGIN}}', REFINE_PROMPT_BEGIN)
    .replace('{{N}}', 'N')
    .replace(/\{\{END\}\}/g, REFINE_PROMPT_END)
    .replace(/\{\{OPTION\}\}/g, optionWord)
    .replace(/\{\{NONE\}\}/g, REFINE_NONE_LABEL);
  return fixed.replace('{{TASK_NAME}}', p.taskName)
    .replace('{{WORKSPACE}}', p.workspace)
    .replace('{{SCOPE}}', renderScope(p.scope, p.failedOnly, p.runs))
    .replace('{{RUN_COUNT}}', String(p.runs.length))
    .replace('{{OBJECTIVES}}', p.objectives.trim() === '' ? '(none)' : p.objectives.trim())
    .replace('{{CURRENT_PROMPT}}', p.currentPrompt.trim() === '' ? '(the task has no prompt text recorded)' : p.currentPrompt)
    .replace('{{RUNS}}', renderRuns(p.runs));
}

/**
 * The candidate prompts out of the report's text, in listing order.
 *
 * The store applies what the person picked at the question, and the only
 * durable copy of a candidate's text is the transcript this window holds —
 * the question's own options are the one-line labels. This is the reader of
 * the marked blocks, and it takes the **last** block with each number: the
 * model may quote its own block in the surrounding prose, and the one in the
 * candidates section is the later of the two.
 */
export function extractRefinePrompts(reportText: string): string[] {
  const out: string[] = [];
  for (let index = 1; index <= 20; index += 1) {
    // The number in the marker is the candidate's own, so the marker is
    // unambiguous — and the **last** occurrence of it is the block, because
    // an earlier identical one may be a quote in the surrounding prose.
    const marker = `${REFINE_PROMPT_BEGIN} (candidate ${index})`;
    const at = reportText.lastIndexOf(marker);
    if (at < 0) continue;
    const end = reportText.indexOf(REFINE_PROMPT_END, at + marker.length);
    if (end < 0) continue;
    out[index - 1] = reportText.slice(at + marker.length, end).trim();
  }
  return out;
}

/**
 * What the person's answer names, as candidate numbers.
 *
 * The option labels are `Apply candidate N: …`, so the answer — the selected
 * option(s), joined — is read back to numbers. Free text wins over the
 * selection in the question modal, and a free-text answer that names no
 * number selects nothing: an application on a guess is worse than none.
 */
export function refineSelectedNumbers(answer: string, count: number): number[] {
  // "Apply none of them" anywhere in the answer means none, full stop.
  if (answer.toLowerCase().includes(REFINE_NONE_LABEL.toLowerCase())) return [];
  const out: number[] = [];
  for (let i = 1; i <= count; i += 1) {
    // The option's wording names the number after the word "candidate", so
    // require that context rather than any digit: "3 replicas please" in the
    // free-text field must not select candidate 3.
    const marker = new RegExp(`candidate\\s*${i}(?=[\\.:,\\s]|$)`, 'i');
    if (marker.test(answer)) out.push(i);
  }
  return out;
}
