import { useEffect, useRef, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import './surface.css';

/**
 * Shared page anatomy for workspace pages (Goals, Connections, Usage):
 * a centred column, small section labels, quiet rows, status in one word,
 * and actions that appear only where they are needed.
 */
export function Page({
  label,
  actions,
  children,
}: {
  label: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="surface-page" aria-label={label}>
      <div className="surface-column">
        {actions && <div className="surface-page-actions">{actions}</div>}
        {children}
      </div>
    </section>
  );
}

export function Section({
  id,
  label,
  count,
  tone,
  children,
  footnote,
  aside,
}: {
  id: string;
  label: string;
  count?: number;
  tone?: 'attention';
  children: ReactNode;
  footnote?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className={'surface-section' + (tone ? ' ' + tone : '')} aria-labelledby={id}>
      <div className="surface-section-head">
        <h3 id={id}>
          {label}
          {count !== undefined && <span>{count}</span>}
        </h3>
        {aside}
      </div>
      {children}
      {footnote && <p className="surface-footnote">{footnote}</p>}
    </section>
  );
}

export function List({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul className="surface-list" aria-label={label}>
      {children}
    </ul>
  );
}

export type Tone = 'ok' | 'attention' | 'problem' | 'idle';

export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={'surface-status ' + tone}>
      <span className="surface-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Row({
  mark,
  title,
  subtitle,
  tag,
  status,
  actions,
  menu,
  tone,
  children,
  className = '',
}: {
  mark?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  tag?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  menu?: ReactNode;
  tone?: 'attention' | 'problem';
  children?: ReactNode;
  className?: string;
}) {
  return (
    <li className={['surface-row', tone, className].filter(Boolean).join(' ')}>
      <div className="surface-row-head">
        {mark && <span className="surface-row-mark">{mark}</span>}
        <div className="surface-row-text">
          <div className="surface-row-title">
            <strong>{title}</strong>
            {tag && <span className="surface-tag">{tag}</span>}
          </div>
          {subtitle && <div className="surface-row-subtitle">{subtitle}</div>}
        </div>
        {status}
        {actions && <div className="surface-row-actions">{actions}</div>}
        {menu}
      </div>
      {children && <div className="surface-row-body">{children}</div>}
    </li>
  );
}

/** A small "…" menu that closes on outside click, Escape or choosing an item. */
export function Menu({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const menu = ref.current;
      if (!menu?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        menu.open = false;
        menu.querySelector('summary')?.focus();
        return;
      }
      if (!menu.contains(event.target as Node)) menu.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  return (
    <details className="surface-menu" ref={ref}>
      <summary aria-label={label} title={label}>
        <MoreHorizontal size={18} />
      </summary>
      <div
        className="surface-menu-items"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('button') && ref.current)
            ref.current.open = false;
        }}
      >
        {children}
      </div>
    </details>
  );
}

export function Meter({ used, label }: { used: number; label: string }) {
  const value = Math.max(0, Math.min(100, used));
  const tone = value >= 100 ? 'problem' : value >= 85 ? 'attention' : 'ok';
  return (
    <span
      className={'surface-meter ' + tone}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
    >
      <span style={{ width: value + '%' }} />
    </span>
  );
}

export function Switch({
  checked,
  disabled,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: ReactNode;
}) {
  return (
    <li className="surface-row surface-switch-row">
      <div className="surface-row-head">
        <div className="surface-row-text">
          <div className="surface-row-title">
            <span>{label}</span>
          </div>
          {hint && <div className="surface-row-subtitle">{hint}</div>}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          className="surface-switch"
          disabled={disabled}
          onClick={() => onChange(!checked)}
        >
          <span />
        </button>
      </div>
    </li>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="surface-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const marks: Record<string, string> = {
  railway: 'railway',
  stripe: 'stripe',
  resend: 'resend',
  gmail: 'gmail',
  github: 'github',
  codex: 'openai',
  openai: 'openai',
  claude: 'claude',
};

/** Brand mark drawn in the current text colour, so it suits both themes. */
export function ServiceMark({ service, name, size = 20 }: { service: string; name: string; size?: number }) {
  const key = marks[service.toLowerCase()] || marks[service.toLowerCase().split('-')[0]];
  return key ? (
    <span
      className="service-mark"
      aria-hidden="true"
      style={{ width: size, height: size, ['--mark' as any]: `url(/brands/${key}.svg)` }}
    />
  ) : (
    <span
      className="service-mark letter"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
    >
      {(name || service).trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

/** "Ana", "Ana and Ben", "Ana, Ben and 2 others". */
export function namesList(names: string[]) {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}
