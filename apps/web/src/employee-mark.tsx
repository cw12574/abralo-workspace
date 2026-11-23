export function EmployeeMark({ id, className }: { id: string; className?: string }) {
  let seed = 0;
  for (const char of id) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  return (
    <svg className={className} viewBox="0 0 7 7" aria-hidden="true">
      <rect width="7" height="7" rx="1" fill="var(--tint)" />
      {Array.from({ length: 25 }, (_, i) =>
        (seed >> (Math.floor(i / 5) * 3 + Math.min(i % 5, 4 - (i % 5))) % 24) & 1 || i === 12 ? (
          <rect
            key={i}
            x={1 + (i % 5)}
            y={1 + Math.floor(i / 5)}
            width=".8"
            height=".8"
            rx=".1"
            fill="var(--accent)"
          />
        ) : null,
      )}
    </svg>
  );
}
