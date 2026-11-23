import { useEffect, useId, useRef, useState, type ReactNode, type PointerEvent } from 'react';
import type { Employee } from '../../../packages/contracts/src/index';
import { closestEmployeeSlot, moveEmployee, reconcileEmployeeOrder } from './employee-order';
import './employee-list.css';

type Gesture = {
  id: string;
  pointer: number;
  capture: HTMLElement;
  nav: HTMLElement;
  x: number;
  y: number;
  startX: number;
  startY: number;
  scroll: number;
  from: number;
  to: number;
  active: boolean;
  frame: number;
  rows: DOMRect[];
  listTop: number;
};
type Preview = { id: string; from: number; to: number; delta: number; height: number; top: number };

export function EmployeeList({
  employees,
  userId,
  children,
}: {
  employees: Employee[];
  userId: string;
  children: (employee: Employee, instructionsId: string) => ReactNode;
}) {
  const storageKey = `employee-order:${userId}`;
  const [saved, setSaved] = useState<string[]>(() => {
    try {
      return reconcileEmployeeOrder(
        employees.map((e) => e.id),
        JSON.parse(localStorage.getItem(storageKey) || '[]'),
      );
    } catch {
      return employees.map((e) => e.id);
    }
  });
  const order = reconcileEmployeeOrder(
    employees.map((e) => e.id),
    saved,
  );
  const list = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClickUntil = useRef(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const instructionsId = useId();
  const people = new Map(employees.map((e) => [e.id, e]));

  function finish(commit: boolean) {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    cancelAnimationFrame(g.frame);
    if (g.capture.hasPointerCapture(g.pointer)) g.capture.releasePointerCapture(g.pointer);
    setPreview(null);
    if (g.active) {
      suppressClickUntil.current = performance.now() + 250;
      if (commit) save(g.id, g.to);
      else setAnnouncement('Move cancelled. Employee order unchanged.');
    }
  }

  function save(id: string, to: number) {
    const next = moveEmployee(order, id, to);
    setSaved(next);
    const position = next.indexOf(id) + 1;
    const message = `${people.get(id)?.name} moved to position ${position} of ${next.length}.`;
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setAnnouncement(message);
    } catch {
      setAnnouncement(`${message} This browser could not save the order for next time.`);
    }
  }

  useEffect(() => {
    setPreview(null);
    const cancel = () => finish(false);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture.current) {
        event.preventDefault();
        cancel();
      }
    };
    const storage = (event: StorageEvent) => {
      if (event.key === storageKey && !gesture.current) {
        try {
          setSaved(
            reconcileEmployeeOrder(
              employees.map((e) => e.id),
              JSON.parse(event.newValue || '[]'),
            ),
          );
        } catch {
          /* Keep the current usable order if another tab has invalid data. */
        }
      }
    };
    window.addEventListener('keydown', key);
    window.addEventListener('blur', cancel);
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('storage', storage);
      const g = gesture.current;
      if (g) {
        cancelAnimationFrame(g.frame);
        gesture.current = null;
        if (g.capture.hasPointerCapture(g.pointer)) g.capture.releasePointerCapture(g.pointer);
      }
    };
  }, [storageKey, employees.map((e) => e.id).join(',')]);

  function update(g: Gesture) {
    const delta = g.y - g.startY + g.nav.scrollTop - g.scroll;
    const source = g.rows[g.from];
    g.to = closestEmployeeSlot(
      g.rows.map((r) => r.top + r.height / 2),
      source.top + source.height / 2 + delta,
    );
    const target = g.rows[g.to];
    setPreview({
      id: g.id,
      from: g.from,
      to: g.to,
      delta,
      height: source.height,
      top: target.top - g.listTop + (g.to > g.from ? target.height - source.height : 0),
    });
  }

  function scroll(g: Gesture) {
    if (gesture.current !== g || !g.active) return;
    const bounds = g.nav.getBoundingClientRect();
    if (g.x >= bounds.left && g.x <= bounds.right) {
      const speed =
        g.y < bounds.top + 40
          ? -Math.min(10, (bounds.top + 40 - g.y) / 4)
          : g.y > bounds.bottom - 40
            ? Math.min(10, (g.y - bounds.bottom + 40) / 4)
            : 0;
      if (speed) {
        g.nav.scrollTop += speed;
        update(g);
      }
    }
    g.frame = requestAnimationFrame(() => scroll(g));
  }

  function down(event: PointerEvent<HTMLDivElement>, id: string) {
    if (event.button !== 0 || !event.isPrimary || gesture.current || employees.length < 2) return;
    const target = event.target as HTMLElement;
    // Touch users scroll normally over names; the portrait is the drag handle.
    if (event.pointerType === 'touch' && !target.closest('.agent-avatar')) return;
    const capture = target.closest('button');
    const nav = list.current?.closest('nav');
    if (!capture || !nav || !list.current) return;
    const rows = [
      ...list.current.querySelectorAll<HTMLElement>(':scope > .reorderable-employee'),
    ].map((row) => row.getBoundingClientRect());
    gesture.current = {
      id,
      pointer: event.pointerId,
      capture,
      nav,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      scroll: nav.scrollTop,
      from: order.indexOf(id),
      to: order.indexOf(id),
      active: false,
      frame: 0,
      rows,
      listTop: list.current.getBoundingClientRect().top,
    };
    capture.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    g.x = event.clientX;
    g.y = event.clientY;
    if (!g.active && Math.hypot(g.x - g.startX, g.y - g.startY) < 6) return;
    event.preventDefault();
    if (!g.active) {
      g.active = true;
      setAnnouncement(`Moving ${people.get(g.id)?.name}. Release to place. Escape cancels.`);
      scroll(g);
    }
    update(g);
  }

  return (
    <div
      ref={list}
      className={`employee-list${preview ? ' is-reordering' : ''}`}
      onPointerMove={move}
      onPointerUp={(event) => {
        const g = gesture.current;
        if (!g || g.pointer !== event.pointerId) return;
        const bounds = g.nav.getBoundingClientRect();
        finish(
          event.clientX >= bounds.left &&
            event.clientX <= bounds.right &&
            event.clientY >= bounds.top &&
            event.clientY <= bounds.bottom,
        );
      }}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(false)}
      onDragStart={(event) => event.preventDefault()}
      onClickCapture={(event) => {
        if (performance.now() < suppressClickUntil.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <span id={instructionsId} className="reorder-screen-reader">
        Drag to reorder. On touch screens, drag the portrait. Or use Alt and the Up or Down arrow
        key. Escape cancels a drag.
      </span>
      <span className="reorder-screen-reader" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      {preview && (
        <div
          className="employee-drop-slot"
          aria-hidden="true"
          style={{ top: preview.top, height: preview.height }}
        />
      )}
      {order.map((id, index) => {
        const employee = people.get(id)!;
        const lifted = preview?.id === id;
        let offset = 0;
        if (preview) {
          if (lifted) offset = preview.delta;
          else if (index > preview.from && index <= preview.to) offset = -preview.height;
          else if (index < preview.from && index >= preview.to) offset = preview.height;
        }
        return (
          <div
            key={id}
            data-employee-id={id}
            className={`reorderable-employee${lifted ? ' is-lifted' : ''}`}
            style={{ transform: offset ? `translateY(${offset}px)` : undefined }}
            onPointerDown={(event) => down(event, id)}
            onKeyDown={(event) => {
              if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || gesture.current)
                return;
              event.preventDefault();
              save(id, index + (event.key === 'ArrowUp' ? -1 : 1));
              requestAnimationFrame(() =>
                list.current
                  ?.querySelector<HTMLElement>(`[data-employee-id="${id}"] button`)
                  ?.scrollIntoView({ block: 'nearest' }),
              );
            }}
          >
            {children(employee, instructionsId)}
          </div>
        );
      })}
    </div>
  );
}
