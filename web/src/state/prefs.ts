// User preferences. Stored natively (one JSON file shared by every window) and mirrored
// into a reactive store; a change in one window shows up in all the others.

import { createStore } from 'solid-js/store';
import { call, on } from '../host';

export interface Preferences {
  appearance: 'system' | 'light' | 'dark';
  /** Typeface of the prose: sans (the default) or serif. */
  theme: 'reed' | 'serif';
  /** Width of the notebook column. */
  width: 'normal' | 'wide';
  lineNumbers: boolean;
  wrapCode: boolean;
  /**
   * Show the list of completions while typing. Off, typing shows only the likeliest ending,
   * faintly, after the caret, and the list comes when asked for.
   */
  completionList: boolean;
  /** Run dependent cells automatically (marimo-style) instead of only marking them stale. */
  reactive: boolean;
  autosave: boolean;
  /** Dim every cell but the one being worked on. */
  focusMode: boolean;
  /** Keep the line being typed at a steady height in the window. */
  typewriter: boolean;
  zoom: number;
  lastKernel: string | null;
  kernelByPath: Record<string, string>;
}

const defaults: Preferences = {
  appearance: 'system',
  theme: 'reed',
  width: 'normal',
  lineNumbers: false,
  wrapCode: false,
  completionList: false,
  reactive: false,
  autosave: true,
  focusMode: false,
  typewriter: false,
  zoom: 1,
  lastKernel: null,
  kernelByPath: {},
};

/** Settings that take one of a few values; anything else (an option since removed) falls back. */
const choices: Partial<Record<keyof Preferences, readonly unknown[]>> = {
  appearance: ['system', 'light', 'dark'],
  theme: ['reed', 'serif'],
  width: ['normal', 'wide'],
};

function valid(key: keyof Preferences, value: unknown): boolean {
  if (value === undefined || value === null || typeof value !== typeof defaults[key]) return false;
  return choices[key]?.includes(value) ?? true;
}

const [prefs, setStore] = createStore<Preferences>({ ...defaults });
export { prefs };

export function loadPreferences(raw: Record<string, unknown>) {
  const next: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof Preferences)[]) {
    if (valid(key, raw[key])) next[key] = raw[key];
  }
  setStore(next as unknown as Preferences);
  on('prefs.changed', ({ key, value }: { key: keyof Preferences; value: unknown }) => {
    if (key in defaults) setStore(key, (valid(key, value) ? value : defaults[key]) as never);
  });
}

export function setPref<K extends keyof Preferences>(key: K, value: Preferences[K]) {
  setStore(key, value as never);
  if (key === 'appearance') {
    try {
      localStorage.setItem('reed.appearance', String(value));
    } catch {
      /* private mode */
    }
  }
  call('prefs.set', { key, value }).catch(() => {});
}

export function togglePref(
  key: 'lineNumbers' | 'wrapCode' | 'completionList' | 'reactive' | 'autosave' | 'focusMode' | 'typewriter',
) {
  setPref(key, !prefs[key]);
}
