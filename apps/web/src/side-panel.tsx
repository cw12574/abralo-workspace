import React, { useEffect, useRef } from 'react';

export function SidePanel({
  children,
  width,
  onWidth,
  onResize,
  preview = false,
  expanded = false,
}: {
  children: React.ReactNode;
  width: number;
  onWidth: (width: number) => void;
  onResize: (resizing: boolean) => void;
  preview?: boolean;
  expanded?: boolean;
}) {
  const drag = useRef({ x: 0, width });
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = panel.current!;
    const conversation = element.previousElementSibling as HTMLElement | null;
    const narrow = matchMedia('(max-width: 720px)');
    const sync = () => {
      if (conversation) conversation.inert = expanded || narrow.matches;
    };
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || (!expanded && !narrow.matches)) return;
      const controls = [
        ...element.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ),
      ].filter((node) => node.getClientRects().length);
      const first = controls[0],
        last = controls.at(-1);
      if (!first || !last) return;
      if (
        event.shiftKey &&
        (document.activeElement === first || !element.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !element.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    sync();
    narrow.addEventListener('change', sync);
    element.addEventListener('keydown', trap);
    return () => {
      if (conversation) conversation.inert = false;
      narrow.removeEventListener('change', sync);
      element.removeEventListener('keydown', trap);
    };
  }, [expanded, preview]);
  const resize = (value: number) => onWidth(Math.round(Math.max(300, Math.min(760, value))));
  return (
    <section
      ref={panel}
      className={`thread side-panel${preview ? ' preview-panel' : ''}${expanded ? ' is-expanded' : ''}`}
      aria-label={preview ? 'Preview' : 'Thread'}
      style={{ '--thread-width': width + 'px' } as React.CSSProperties}
    >
      {!expanded && (
        <div
          className="thread-resizer"
          role="separator"
          aria-label={preview ? 'Resize preview' : 'Resize thread'}
          aria-orientation="vertical"
          aria-valuemin={300}
          aria-valuemax={760}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            drag.current = {
              x: event.clientX,
              width: event.currentTarget.parentElement!.getBoundingClientRect().width,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            onResize(true);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              resize(drag.current.width + drag.current.x - event.clientX);
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
            onResize(false);
          }}
          onLostPointerCapture={() => onResize(false)}
          onDoubleClick={() => resize(390)}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            resize(
              event.key === 'Home'
                ? 300
                : event.key === 'End'
                  ? 760
                  : width + (event.key === 'ArrowLeft' ? 10 : -10) * (event.shiftKey ? 4 : 1),
            );
          }}
          title="Drag to resize · double-click to reset"
        />
      )}
      {children}
    </section>
  );
}
