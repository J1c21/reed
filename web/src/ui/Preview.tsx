// Looking closer at a figure: it lifts off the page and grows to fill the window, and goes
// back where it came from. Return, Escape, a click or a scroll puts it back; ⌘C copies it.

import { onCleanup, onMount } from 'solid-js';
import { setNotice } from '../notebook/execution';
import { copyPiece } from '../render/outputs/actions';
import { surfaces } from '../state/surfaces';
import { GLIDE_EASING, GLIDE_MS, still } from '../util/motion';

/** Space left around the enlarged picture. */
const MARGIN = 56;

export function Preview(props: { source: HTMLImageElement }) {
  let layer!: HTMLDivElement;
  let picture!: HTMLImageElement;
  const source = props.source;
  const previousFocus = document.activeElement as HTMLElement | null;
  let closing = false;

  // As large as the window allows — but a bitmap never beyond its own pixels (a drawing has none to run out of).
  const natural = { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height };
  const limit = source.src.startsWith('data:image/svg') ? Infinity : 1;
  const fit = Math.min((window.innerWidth - MARGIN * 2) / natural.width, (window.innerHeight - MARGIN * 2) / natural.height, limit);
  const size = { width: Math.round(natural.width * fit), height: Math.round(natural.height * fit) };
  const place = { left: Math.round((window.innerWidth - size.width) / 2), top: Math.round((window.innerHeight - size.height) / 2) };

  /** The transform that puts the enlarged picture exactly over the one on the page. */
  const onPage = () => {
    const rect = source.getBoundingClientRect();
    return `translate(${rect.left - place.left}px, ${rect.top - place.top}px) scale(${rect.width / size.width}, ${rect.height / size.height})`;
  };

  const close = () => {
    if (closing) return;
    closing = true;
    const done = () => {
      surfaces.setPreview(null);
      if (previousFocus?.isConnected && previousFocus !== document.body) previousFocus.focus({ preventScroll: true });
    };
    if (still() || !source.isConnected) return done();
    layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: GLIDE_MS, easing: 'ease-out', fill: 'forwards' });
    picture.animate([{ transform: 'none' }, { transform: onPage() }], { duration: GLIDE_MS, easing: GLIDE_EASING, fill: 'forwards' }).onfinish = done;
  };

  onMount(() => {
    if (!still()) {
      layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: GLIDE_MS, easing: 'ease-out' });
      picture.animate([{ transform: onPage() }, { transform: 'none' }], { duration: GLIDE_MS, easing: GLIDE_EASING });
    }
    // The picture has the keyboard while it is up.
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        event.stopPropagation();
        copyPiece({ kind: 'image', image: source }).then(
          (done) => setNotice({ kind: 'info', text: done }),
          () => setNotice({ kind: 'error', text: 'That could not be copied.' }),
        );
        return;
      }
      if (event.metaKey) return; // ⌘W, ⌘Q and the like are the app's
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('resize', close);
    onCleanup(() => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('wheel', close);
      window.removeEventListener('resize', close);
    });
  });

  return (
    <div class="preview-layer" ref={layer} onMouseDown={(event) => event.preventDefault()} onClick={close}>
      <img
        ref={picture}
        class={`preview-image ${source.classList.contains('dark-ok') ? 'dark-ok' : ''}`}
        src={source.src}
        alt=""
        style={{ left: `${place.left}px`, top: `${place.top}px`, width: `${size.width}px`, height: `${size.height}px` }}
      />
    </div>
  );
}
