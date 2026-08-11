export default function Brand({ compact = false }) {
  return (
    <div className={`brand${compact ? ' brand--compact' : ''}`}>
      <svg className="brand__mark" viewBox="45 50 305 350" aria-hidden="true">
        <path d="M139 80C139 69 148 62 159 65L274 96C284 99 291 107 291 118V228L139 261Z" fill="#176F6A" />
        <path d="M62 159C62 149 70 142 81 141L178 133C189 132 198 140 198 151V342C198 353 190 361 179 361H81C70 361 62 353 62 342Z" fill="#432044" />
        <path d="M188 191C188 181 195 174 206 172L311 165C322 164 331 172 331 183V350C331 360 324 368 313 370L208 383C197 384 188 376 188 365Z" fill="#D99B19" />
        <path d="M151 198C151 188 156 184 163 181L225 162C234 159 241 165 241 175V316C241 326 234 332 225 330L163 312C155 310 151 305 151 297Z" fill="#FFF8EC" />
      </svg>
      <span><strong>Central Pass</strong>{!compact && <small>Operations console</small>}</span>
    </div>
  );
}
