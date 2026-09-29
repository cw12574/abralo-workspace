import React, { useId } from 'react';

// An open doorway, drawn on the same small grid as the agent portraits.
// The inset changes with the room's name; every mark stays recognizable at 16px.
export function RoomMark({ size = 20, name = '' }: { size?: number; name?: string }) {
  const inset = [...name].reduce((n, c) => n + c.charCodeAt(0), 0) % 3;
  return (
    <svg
      className="room-mark"
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

export function AgentNavigationRow({
  employee,
  unread,
  selected,
  onClick,
  avatar,
  onIntent,
  onIntentEnd,
}: {
  employee: any;
  unread: boolean;
  selected: boolean;
  onClick: () => void;
  avatar: React.ReactNode;
  onIntent?: () => void;
  onIntentEnd?: () => void;
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
        aria-describedby={descriptionId}
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
