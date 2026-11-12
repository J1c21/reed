// The app's one kind of movement. Things glide to where they belong — the line that marks the
// current cell, the page following it, cells making room for one another — briefly, and
// without a bounce. One duration and one curve for all of them, so that things which move
// together move as one.

import { clamp } from './misc';

export const GLIDE_MS = 200;
/** The curve, for CSS and the Web Animations API… */
export const GLIDE_EASING = 'cubic-bezier(0.22, 0.61, 0.36, 1)';
/** …and the same curve (ease-out cubic) for animation driven by hand. */
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** True when nothing should animate: the window is out of sight, or macOS is set to reduce motion. */
export function still(): boolean {
  return document.hidden || reducedMotion.matches;
}

// ── Scrolling ───────────────────────────────────────────────────────────────

interface Glide {
  frame: number;
  goal: number;
}
const glides = new WeakMap<HTMLElement, Glide>();
const watched = new WeakSet<HTMLElement>();

function stop(scroller: HTMLElement) {
  const glide = glides.get(scroller);
  if (glide) cancelAnimationFrame(glide.frame);
  glides.delete(scroller);
}

/** Where the scroller is headed: the end of a glide in flight, or where it is now. */
export function scrollGoal(scroller: HTMLElement): number {
  return glides.get(scroller)?.goal ?? scroller.scrollTop;
}

/** Scrolls to a position the way everything else moves. Scrolling by hand takes over at once. */
export function glideScrollTo(scroller: HTMLElement, top: number) {
  const goal = clamp(top, 0, scroller.scrollHeight - scroller.clientHeight);
  stop(scroller);
  let from = scroller.scrollTop;
  if (Math.abs(goal - from) < 1) return;
  if (still()) {
    scroller.scrollTop = goal;
    return;
  }
  if (!watched.has(scroller)) {
    watched.add(scroller);
    scroller.addEventListener('wheel', () => stop(scroller), { passive: true });
  }
  // A long way is mostly a jump: only the arrival is worth watching (and gliding past
  // thousands of pixels would have every cell on the way build itself for nothing).
  const reach = scroller.clientHeight * 1.5;
  if (Math.abs(goal - from) > reach) {
    from = goal - Math.sign(goal - from) * reach;
    scroller.scrollTop = from;
  }
  const started = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - started) / GLIDE_MS);
    scroller.scrollTop = from + (goal - from) * ease(t);
    if (t < 1) glides.set(scroller, { frame: requestAnimationFrame(step), goal });
    else glides.delete(scroller);
  };
  glides.set(scroller, { frame: requestAnimationFrame(step), goal });
}

/** Room kept clear above and below whatever is scrolled into view. */
const MARGIN_TOP = 64;
const MARGIN_BOTTOM = 96;

/**
 * Brings an element into view: no further than needed ('nearest'), to the middle of the
 * window ('center'), or to its top ('start').
 */
export function glideIntoView(
  scroller: HTMLElement,
  target: Element | { top: number; bottom: number },
  block: 'nearest' | 'center' | 'start' = 'nearest',
) {
  const view = scroller.getBoundingClientRect();
  const box = target instanceof Element ? target.getBoundingClientRect() : target;
  const rect = { top: box.top, bottom: box.bottom, height: box.bottom - box.top };
  const top = view.top + MARGIN_TOP;
  const bottom = view.bottom - MARGIN_BOTTOM;
  let delta = 0;
  if (block === 'start') {
    delta = rect.top - top;
  } else if (block === 'center') {
    delta = rect.top + rect.height / 2 - (view.top + view.height / 2);
  } else if (rect.top < top && rect.bottom > bottom) {
    delta = 0; // it fills the window already
  } else {
    const tall = rect.height > bottom - top;
    if (rect.top < top) delta = tall ? rect.bottom - bottom : rect.top - top;
    else if (rect.bottom > bottom) delta = tall ? rect.top - top : rect.bottom - bottom;
  }
  // Positions were read mid-glide, if one is under way, so this is relative to here and now.
  if (Math.abs(delta) >= 1) glideScrollTo(scroller, scroller.scrollTop + delta);
}

// ── Layout changes ──────────────────────────────────────────────────────────

/**
 * Makes a change of layout continuous. Call it before the change with the elements that may
 * move, keyed by something stable; call what it returns after the change with the elements as
 * they are then. Each one glides from where it was to where it now is, and ones that were not
 * there before fade in.
 */
export function rearrange(before: Map<string, HTMLElement>): (after: Map<string, HTMLElement>) => void {
  if (still()) return () => {};
  const reach = window.innerHeight;
  const tops = new Map<string, number>();
  for (const [key, element] of before) {
    const rect = element.getBoundingClientRect();
    // Only what is on screen, or near it, is worth animating.
    if (rect.bottom > -reach && rect.top < 2 * reach) tops.set(key, rect.top);
  }
  return (after) => {
    for (const [key, element] of after) {
      const was = tops.get(key);
      if (was === undefined) {
        if (!before.has(key)) element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: GLIDE_MS, easing: 'ease-out' });
        continue;
      }
      const delta = was - element.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) continue;
      element.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], {
        duration: GLIDE_MS,
        easing: GLIDE_EASING,
      });
    }
  };
}
