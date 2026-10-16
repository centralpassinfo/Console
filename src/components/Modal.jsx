import { useRef } from 'react';
import Icon from './Icon.jsx';
import useDialogFocus from '../useDialogFocus.js';

export default function Modal({ title, children, confirmLabel = 'Confirm change', tone = 'primary', busy = false, onConfirm, onClose }) {
  const cancelRef = useRef(null);
  const dialogRef = useRef(null);
  useDialogFocus(dialogRef, { busy, onClose, initialRef: cancelRef });

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section ref={dialogRef} tabIndex={-1} className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal__icon"><Icon name={tone === 'danger' ? 'alert' : 'settings'} size={22} /></div>
        <div className="modal__content">
          <h2 id="modal-title">{title}</h2>
          {children}
        </div>
        <div className="modal__actions">
          <button ref={cancelRef} className="button button--secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className={`button button--${tone}`} type="button" onClick={onConfirm} disabled={busy}>
            {busy ? 'Applying…' : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

