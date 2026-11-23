import React, { useId } from 'react';

// An open doorway, drawn on the same small grid as the agent portraits.
// The inset changes with the workspace's name; every mark stays recognizable at 16px.
export function WorkspaceMark({ size = 20, name = '' }: { size?: number; name?: string }) {
  const inset = [...name].reduce((n, c) => n + c.charCodeAt(0), 0) % 3;
  return (
    <svg
      className="workspace-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path d="M4 20V4h15v16h-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
      <path d="M4 20h6V9l6-3v14" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 22h13" stroke="currentColor" strokeOpacity=".3" />
      <rect x="12" y={12 + inset} width="1.5" height="1.5" fill="currentColor" />
      <path d="M10 9l6-3v14l-6 2V9Z" fill="currentColor" opacity=".09" />
    </svg>
  );
}

// Familiar target and microphone silhouettes, built from the portraits' small blocks.
const navigationPixels = {
  goals: ['001111100', '010000010', '100111001', '101000101', '101010101', '101000101', '100111001', '010000010', '001111100'],
  briefing: ['000111000', '001111100', '101111101', '101111101', '100111001', '010000010', '001111100', '000010000', '001111100'],
};

export function NavigationMark({ kind }: { kind: keyof typeof navigationPixels }) {
  return (
    <svg className="navigation-mark" width="26" height="26" viewBox="0 0 11 11" aria-hidden="true">
      <rect width="11" height="11" rx="1.6" fill="var(--tint)" />
      {navigationPixels[kind].flatMap((row, y) => [...row].map((pixel, x) =>
        pixel === '1' ? <rect key={`${x}-${y}`} x={x + 1} y={y + 1}
          width=".8" height=".8" rx=".1" fill="currentColor" /> : null,
      ))}
    </svg>
  );
}

export function AgentNavigationRow({
  employee,
  unread,
  selected,
  onClick,
  avatar,
  onIntent,
  onIntentEnd,
  reorderDescriptionId,
}: {
  employee: any;
  unread: boolean;
  selected: boolean;
  onClick: () => void;
  avatar: React.ReactNode;
  onIntent?: () => void;
  onIntentEnd?: () => void;
  reorderDescriptionId?: string;
}) {
  const descriptionId = useId();
  const working =
    employee.working ??
    (!!employee.latestWork &&
      ['accepted', 'dispatching', 'running', 'cancelling'].includes(employee.latestWork.state));
  const next = employee.nextScheduledAt;
  const label = `${working ? 'Working' : 'Idle'}${unread ? ' · Unread activity' : ''}${next ? ' · Next scheduled run ' + new Date(next).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : ''}`;
  return (
    <div className="nav-item agent-nav-item" onMouseLeave={onIntentEnd}>
      <button
        className={`nav-row employee-row${selected ? ' selected' : ''}${unread ? ' has-unread' : ''}`}
        aria-label={employee.name}
        aria-describedby={[descriptionId, reorderDescriptionId].filter(Boolean).join(' ')}
        aria-keyshortcuts={reorderDescriptionId ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
        aria-current={selected ? 'page' : undefined}
        onClick={onClick}
        onMouseEnter={onIntent}
        onFocus={onIntent}
        onBlur={onIntentEnd}
      >
        <span className={`agent-avatar${working ? ' is-working' : ''}`} aria-hidden="true">
          {avatar}
        </span>
        <span className="employee-name">{employee.name}</span>
        <span className="agent-unread-slot" aria-hidden="true">
          {unread && <span className="unread-dot" />}
        </span>
      </button>
      <span hidden id={descriptionId}>
        {label}
      </span>
    </div>
  );
}
