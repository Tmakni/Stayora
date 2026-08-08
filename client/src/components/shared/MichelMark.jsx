export function MichelMark({ className = 'size-7', gradient = true }) {
  return (
    <svg viewBox="0 0 100 100" fill="none" className={className} aria-hidden="true">
      {gradient && (
        <defs>
          <linearGradient id="michel-mark-g" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#635BFF" />
            <stop offset="1" stopColor="#2563EB" />
          </linearGradient>
        </defs>
      )}
      <circle cx="50" cy="50" r="46" fill={gradient ? 'url(#michel-mark-g)' : 'currentColor'} />
      <circle cx="50" cy="50" r="25" stroke="white" strokeWidth="4.5" />
      <ellipse cx="50" cy="50" rx="25" ry="10" stroke="white" strokeWidth="4.5" transform="rotate(-38 50 50)" />
    </svg>
  );
}
