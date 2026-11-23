import { useEffect, useRef, useState } from 'react';

export type CaptionEntry = { id: string; text: string };
export function ReadableCaptions({ entries }: { entries: CaptionEntry[] }) {
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [paused, setPaused] = useState(false);
  const follow = () => {
    following.current = true;
    setPaused(false);
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  };
  useEffect(() => {
    if (following.current) follow();
  }, [entries]);
  if (!entries.length) return null;
  return (
    <div className="chief-captions ui-stack">
      <div
        className="chief-caption-transcript"
        ref={viewport}
        tabIndex={0}
        role="region"
        aria-label="Chief of Staff captions"
        onWheel={(e) => {
          if (e.deltaY < 0) {
            following.current = false;
            setPaused(true);
          }
        }}
        onTouchMove={() => {
          following.current = false;
          setPaused(true);
        }}
        onKeyDown={(e) => {
          if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) {
            following.current = false;
            setPaused(true);
          }
        }}
        onScroll={() => {
          const el = viewport.current!;
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
          following.current = atEnd;
          setPaused(!atEnd);
        }}
      >
        {entries.map((entry) => (
          <p className="chief-caption" key={entry.id}>
            {entry.text}
          </p>
        ))}
      </div>
      {paused && (
        <button className="chief-text-link" onClick={follow}>
          Back to live
        </button>
      )}
    </div>
  );
}
