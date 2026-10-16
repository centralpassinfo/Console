import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatDateTime, formatFileSize } from '../format.js';
import Icon from './Icon.jsx';
import Modal from './Modal.jsx';

// The staff tablet app's over-the-air updates for one venue. Bundles are
// uploaded with staff-dashboard's publish:bundle script and stay inactive until
// they are approved here. Approving an older bundle is how a rollback works.
export default function TabletPanel({ venueId, venueName }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api(`/venues/${venueId}/tablet`));
      setError('');
    } catch (requestError) { setError(requestError.message); }
  }, [venueId]);

  useEffect(() => { load(); }, [load]);

  const bundles = data?.bundles || [];
  const live = bundles.find((bundle) => bundle.live);

  async function approve() {
    setBusy(true);
    try {
      await api(`/venues/${venueId}/tablet/approve`, { method: 'POST', body: { bundleId: confirm.bundle.id, checksum: confirm.bundle.checksum } });
      setNotice(`Tablet app ${confirm.bundle.version} approved. Tablets download it next time the app opens and apply it on the following restart.`);
      setConfirm(null);
      await load();
    } catch (requestError) {
      setConfirm((current) => ({ ...current, error: requestError.message }));
    } finally { setBusy(false); }
  }

  return (
    <section className="content-card tablet-panel">
      <div className="content-card__header">
        <div><span className="eyebrow">Staff tablet app</span><h2>Tablet app updates</h2><p>Bundles uploaded with <code>npm run publish:bundle</code> wait here until you approve one. Approving an older bundle rolls the tablets back.</p></div>
        <button className="button button--secondary" type="button" onClick={load}><Icon name="refresh" size={16} />Refresh</button>
      </div>
      {notice && <div className="form-alert form-alert--success contract-notice" role="status"><Icon name="check" size={18} />{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss"><Icon name="x" size={16} /></button></div>}
      {error && <div className="form-alert form-alert--error contract-notice" role="alert"><Icon name="alert" size={18} />{error}</div>}
      {data && !data.available && <div className="empty-inline">{data.reason}</div>}
      {data?.available && !data.release && <div className="contract-alert contract-alert--warning"><Icon name="info" /><div><strong>Deploy a release from Console first.</strong><p>This venue’s backend was not deployed by Console, so it cannot match a tablet approval to a release. Its current tablet app keeps working.</p></div></div>}
      {data?.available && (
        <div className="contract-list">
          {bundles.length ? bundles.map((bundle) => (
            <article className="tablet-bundle" key={bundle.id}>
              <div>
                <div className="contract-record__title"><div><h3>{bundle.version}</h3><span>{bundle.channel} · {bundle.appId} · {formatFileSize(bundle.sizeBytes)} · uploaded {formatDateTime(bundle.uploadedAt)}</span></div>{bundle.live ? <span className="billing-badge billing-badge--paid">Live on tablets</span> : <span className="billing-badge billing-badge--none">Not approved</span>}</div>
                <p className="tablet-bundle__meta">Checksum <code title={bundle.checksum}>{bundle.checksum.slice(0, 16)}…</code>{bundle.minVersionCode ? ` · needs app build ${bundle.minVersionCode} or later` : ''}{bundle.notes ? ` · ${bundle.notes}` : ''}</p>
              </div>
              {!bundle.live && <div className="contract-record__actions"><button className="button button--primary" type="button" disabled={!data.release} onClick={() => setConfirm({ bundle })}><Icon name="check" size={15} />{live && new Date(bundle.uploadedAt) < new Date(live.uploadedAt) ? 'Roll back to this' : 'Approve'}</button></div>}
            </article>
          )) : <div className="empty-inline contract-empty">No tablet bundles have been uploaded to this venue.</div>}
        </div>
      )}
      {confirm && (
        <Modal title={`Approve tablet app ${confirm.bundle.version}`} confirmLabel="Approve for tablets" busy={busy} onClose={() => setConfirm(null)} onConfirm={approve}>
          <p>Every {venueName} tablet on the <strong>{confirm.bundle.channel}</strong> channel downloads <strong>{confirm.bundle.version}</strong> the next time the app opens{live ? `, replacing ${live.version}` : ''}. The approval is tied to checksum <code>{confirm.bundle.checksum.slice(0, 12)}…</code> and to the backend release running now.</p>
          {confirm.error && <div className="form-alert form-alert--error"><Icon name="alert" size={18} />{confirm.error}</div>}
        </Modal>
      )}
    </section>
  );
}
