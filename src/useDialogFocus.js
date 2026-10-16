import { useEffect, useRef } from 'react';
export default function useDialogFocus(
  ref,
  { open = true, busy, onClose, initialRef } = {},
) {
  const state = useRef();
  state.current = { busy, onClose, initialRef };
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const controls = () =>
      [
        ...(ref.current?.querySelectorAll(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]',
        ) || []),
      ].filter((element) => element.getClientRects().length);
    (
      state.current.initialRef?.current ||
      controls()[0] ||
      ref.current
    )?.focus();
    function handle(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!state.current.busy) state.current.onClose?.();
      }
      if (event.key !== 'Tab') return;
      const items = controls(),
        first = items[0],
        last = items.at(-1);
      if (!items.length) {
        event.preventDefault();
        ref.current?.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first ||
          !ref.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !ref.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handle);
    return () => {
      document.removeEventListener('keydown', handle);
      document.body.style.overflow = oldOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [open, ref]);
}
