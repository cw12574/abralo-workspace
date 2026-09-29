import React, { useEffect, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { fileUrl, type PreviewFile } from './preview-model';

export default function ImagePreview({ file }: { file: PreviewFile }) {
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ x: 0, y: 0, moved: false });
  const fit = Math.min(
    1,
    Math.max(1, size.width - 32) / (natural.width || 1),
    Math.max(1, size.height - 32) / (natural.height || 1),
  );
  const scale = zoom ?? fit;
  const bounded = (value: { x: number; y: number }, nextScale = scale) => {
    const x = Math.max(0, (natural.width * nextScale - size.width) / 2 + 16);
    const y = Math.max(0, (natural.height * nextScale - size.height) / 2 + 16);
    return { x: Math.max(-x, Math.min(x, value.x)), y: Math.max(-y, Math.min(y, value.y)) };
  };
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(stage.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setPan((value) => bounded(value));
  }, [size.width, size.height, scale]);
  const zoomAt = (next: number, point?: { x: number; y: number }) => {
    next = Math.max(Math.min(fit, 0.1), Math.min(8, next));
    const box = stage.current!.getBoundingClientRect();
    const x = point ? point.x - box.left - box.width / 2 : 0;
    const y = point ? point.y - box.top - box.height / 2 : 0;
    setPan(
      bounded({ x: x - ((x - pan.x) * next) / scale, y: y - ((y - pan.y) * next) / scale }, next),
    );
    setZoom(next);
  };
  const reset = () => {
    setZoom(null);
    setPan({ x: 0, y: 0 });
  };
  const release = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div className="image-preview">
      <div className="preview-toolbar" role="group" aria-label="Image zoom">
        <button className="quiet-button" aria-pressed={zoom === null} onClick={reset}>
          Fit
        </button>
        <button className="quiet-button" aria-pressed={zoom === 1} onClick={() => zoomAt(1)}>
          100%
        </button>
        <span className="preview-toolbar-spacer" />
        <button
          className="icon"
          aria-label="Zoom out"
          disabled={!natural.width || scale <= Math.min(fit, 0.1)}
          onClick={() => zoomAt(scale / 1.5)}
        >
          <Minus size={16} />
        </button>
        <output aria-label="Zoom level">{Math.round(scale * 100)}%</output>
        <button
          className="icon"
          aria-label="Zoom in"
          disabled={!natural.width || scale >= 8}
          onClick={() => zoomAt(scale * 1.5)}
        >
          <Plus size={16} />
        </button>
      </div>
      <div
        className={`image-stage${scale > fit ? ' is-zoomed' : ''}`}
        ref={stage}
        onPointerDown={(event) => {
          if (
            event.button !== 0 ||
            !natural.width ||
            error ||
            (event.target as Element).closest('button')
          )
            return;
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          gesture.current = {
            x: event.clientX,
            y: event.clientY,
            moved: pointers.current.size > 1,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const previous = pointers.current.get(event.pointerId);
          if (!previous) return;
          const before = [...pointers.current.values()];
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (Math.hypot(event.clientX - gesture.current.x, event.clientY - gesture.current.y) > 4)
            gesture.current.moved = true;
          if (before.length === 2) {
            const after = [...pointers.current.values()];
            const distance = (points: typeof before) =>
              Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
            zoomAt((scale * distance(after)) / Math.max(1, distance(before)), {
              x: (after[0].x + after[1].x) / 2,
              y: (after[0].y + after[1].y) / 2,
            });
          } else
            setPan(
              bounded({
                x: pan.x + event.clientX - previous.x,
                y: pan.y + event.clientY - previous.y,
              }),
            );
        }}
        onPointerUp={(event) => {
          if (!pointers.current.has(event.pointerId)) return;
          if (!gesture.current.moved) {
            if (scale > fit) reset();
            else zoomAt(Math.max(1, fit * 2), { x: event.clientX, y: event.clientY });
          }
          release(event);
        }}
        onPointerCancel={release}
        onLostPointerCapture={(event) => pointers.current.delete(event.pointerId)}
      >
        {!natural.width && !error && (
          <div className="preview-state" role="status">
            Opening image…
          </div>
        )}
        {error ? (
          <div className="preview-state ui-stack">
            <p role="alert">The image could not be loaded.</p>
            <button
              className="secondary"
              onClick={() => {
                setError(false);
                setRetry(retry + 1);
              }}
            >
              <RotateCcw size={16} />
              Try again
            </button>
          </div>
        ) : (
          <img
            src={fileUrl(file) + (retry ? `?retry=${retry}` : '')}
            alt={file.name}
            draggable={false}
            onLoad={(event) =>
              setNatural({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={() => setError(true)}
            style={{
              visibility: natural.width ? 'visible' : 'hidden',
              width: natural.width || undefined,
              height: natural.height || undefined,
              transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            }}
          />
        )}
      </div>
      <div className="preview-caption">
        {natural.width
          ? `${natural.width.toLocaleString()} × ${natural.height.toLocaleString()} · ${scale > fit ? 'Drag to explore' : 'Click or pinch to zoom'}`
          : file.name}
      </div>
    </div>
  );
}
