/**
 * The first-run guide's provider step, as data and pure functions.
 *
 * Kept apart from the component so the two rules that matter can be asserted
 * without a window:
 *
 *   - **what counts as "configured"** — a route with a key *and* at least one
 *     model. The runtime's own test (`Provider.Usable()`) is only the key, but a
 *     route with no models cannot be picked in `/model`, so a guide that stopped
 *     there would leave the person with nothing to say hi to;
 *   - **how the new route enters the file** — first, so it is the default route
 *     (`Registry.DefaultProvider`: the first route with a key), and alongside
 *     every route that was already there, because a route missing from the patch
 *     is a route removed from the file.
 */
import { emptyModel, emptyRoute, type ConfigDocument, type Draft, type RouteView } from '@/runtime/userConfig';

/**
 * Which guide step a launch should open on, or null for the ordinary start-up.
 *
 *   - no file answer (not hosted, or the read failed) or a broken file → null:
 *     the guide will not write over a file it cannot parse;
 *   - no usable route → `provider`, whatever was finished before: nothing can
 *     run without one;
 *   - a route, but no workspace remembered and the guide never finished →
 *     `workspace`, so a person who configured keys by hand still gets the
 *     "say hi" check once;
 *   - otherwise null.
 */
export type FirstRunStep = 'provider' | 'workspace';

export function firstRunStep(
  config: ConfigDocument | null,
  lastWorkspace: string | null,
  doneAt: number | null,
): FirstRunStep | null {
  if (config === null || config.problem !== null) return null;
  if (!hasUsableRoute(config.providers)) return 'provider';
  if (lastWorkspace === null && doneAt === null) return 'workspace';
  return null;
}

export type PresetId = 'openai' | 'anthropic' | 'deepseek' | 'ollama' | 'custom';

export interface ProviderPreset {
  id: PresetId;
  /** Shown on the card. Product names, so not translated. */
  label: string;
  /** The route name written into `providers`. */
  routeName: string;
  baseUrl: string;
  /** Empty means "infer from base_url", which is right for all but Anthropic. */
  apiStyle: string;
  model: string;
  /** Whether the endpoint needs a real key. A local Ollama does not, but the
   *  runtime treats an empty key as "not usable", so a placeholder is written. */
  needsKey: boolean;
  /** Written when `needsKey` is false and the person left the key empty. */
  placeholderKey: string;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    routeName: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiStyle: '',
    // `deepseek-chat` was retired on 2026-07-24; `deepseek-flash` tracks the
    // newest Flash checkpoint (V4.1-Flash-1017 as of 2026-11) and is the name
    // `config.example.json` already uses.
    model: 'deepseek-flash',
    needsKey: true,
    placeholderKey: '',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    routeName: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiStyle: '',
    // The everyday tier of GPT-6.2 (2026-11-18); `gpt-6.2-astra` is the
    // frontier one at four times the price. Both serve Chat Completions.
    model: 'gpt-6.2-sol',
    needsKey: true,
    placeholderKey: '',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    routeName: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiStyle: 'anthropic',
    // The generally available Sonnet (2026-09-28).
    model: 'claude-sonnet-5-5',
    needsKey: true,
    placeholderKey: '',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    routeName: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    apiStyle: '',
    // A recent model whose default tag fits an ordinary laptop. The newest
    // `qwen3.8` ships only as 27b, which is a poor first download for a hello.
    model: 'gemma4',
    needsKey: false,
    placeholderKey: 'ollama',
  },
  {
    id: 'custom',
    label: 'OpenAI-compatible',
    routeName: 'custom',
    baseUrl: '',
    apiStyle: '',
    model: '',
    needsKey: true,
    placeholderKey: '',
  },
];

export function presetById(id: PresetId): ProviderPreset {
  return PRESETS.find((preset) => preset.id === id) ?? PRESETS[0];
}

/** A route that can actually answer: a key and something to select. */
export function isUsableRoute(route: RouteView): boolean {
  return route.apiKey.trim() !== '' && route.models.some((model) => model.id.trim() !== '');
}

export function hasUsableRoute(routes: RouteView[]): boolean {
  return routes.some(isUsableRoute);
}

/** What the person typed into the provider step. */
export interface ProviderForm {
  preset: PresetId;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function formFor(id: PresetId): ProviderForm {
  const preset = presetById(id);
  return { preset: id, apiKey: '', baseUrl: preset.baseUrl, model: preset.model };
}

/** Why the form cannot be saved yet, as i18n key suffixes; empty means it can. */
export type FormProblem = 'key' | 'baseUrl' | 'model';

export function formProblems(form: ProviderForm): FormProblem[] {
  const preset = presetById(form.preset);
  const problems: FormProblem[] = [];
  if (preset.needsKey && form.apiKey.trim() === '') problems.push('key');
  if (form.baseUrl.trim() === '') problems.push('baseUrl');
  if (form.model.trim() === '') problems.push('model');
  return problems;
}

/** The route the form describes, before it is placed in the file. */
export function routeFromForm(form: ProviderForm): RouteView {
  const preset = presetById(form.preset);
  const key = form.apiKey.trim() === '' ? preset.placeholderKey : form.apiKey.trim();
  return {
    ...emptyRoute(),
    name: preset.routeName,
    baseUrl: form.baseUrl.trim(),
    apiKey: key,
    apiStyle: preset.apiStyle,
    models: [{ ...emptyModel(), id: form.model.trim() }],
  };
}

/**
 * The draft with `route` placed first.
 *
 * A route of the same name that has **no key** is the scaffolded template's
 * placeholder (`config.example.json` ships `deepseek` with an empty key), so it
 * is replaced rather than kept next to a renamed copy. A same-named route that
 * *does* have a key is somebody's working configuration: it stays, and the new
 * one takes a free name instead.
 */
export function withRouteFirst(draft: Draft, route: RouteView): Draft {
  const kept = draft.providers.filter(
    (existing) => !(existing.name.trim() === route.name && existing.apiKey.trim() === ''),
  );
  const taken = new Set(kept.map((existing) => existing.name.trim()));
  let name = route.name;
  for (let n = 2; taken.has(name); n += 1) name = `${route.name}-${n}`;
  return { ...draft, providers: [{ ...route, name }, ...kept] };
}
