export default function Brand({ compact = false }) {
  return (
    <div className={`brand${compact ? ' brand--compact' : ''}`}>
      <svg className="brand__mark" viewBox="0 0 40 40" aria-hidden="true">
        <circle cx="20" cy="20" r="7" />
        <circle cx="20" cy="4" r="2.4" />
        <circle cx="31.3" cy="8.7" r="2.4" />
        <circle cx="36" cy="20" r="2.4" />
        <circle cx="31.3" cy="31.3" r="2.4" />
        <circle cx="20" cy="36" r="2.4" />
        <circle cx="8.7" cy="31.3" r="2.4" />
        <circle cx="4" cy="20" r="2.4" />
        <circle cx="8.7" cy="8.7" r="2.4" />
      </svg>
      <span><strong>CentralPass</strong>{!compact && <small>Operations console</small>}</span>
    </div>
  );
}

