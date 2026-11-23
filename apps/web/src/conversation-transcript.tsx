import { useEffect, useRef, useState } from 'react';
export function ConversationTranscript({
  turns,
  chiefName,
}: {
  turns: { id: string; speaker: string; text: string; delivery?: string; heardText?: string }[];
  chiefName: string;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [paused, setPaused] = useState(false);
  function follow() {
    following.current = true;
    setPaused(false);
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }
  useEffect(() => {
    if (following.current) follow();
  }, [turns]);
  return (
    <div id="chief-transcript" className="chief-transcript ui-stack">
      <div
        className="chief-transcript-scroll ui-stack"
        role="region"
        aria-label="Conversation transcript"
        tabIndex={0}
        ref={viewport}
        onScroll={() => {
          const el = viewport.current!;
          following.current = el.scrollHeight - el.clientHeight - el.scrollTop < 8;
          setPaused(!following.current);
        }}
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
          if (['Home', 'PageUp', 'ArrowUp'].includes(e.key)) {
            following.current = false;
            setPaused(true);
          }
        }}
      >
        {!turns.length && <p>Your conversation will appear here.</p>}
        {turns.map((turn) => (
          <article key={turn.id} className="chief-transcript-turn ui-stack">
            <strong>{turn.speaker === 'You' ? 'You' : chiefName}</strong>
            <p>
              {turn.delivery === 'interrupted'
                ? turn.heardText || 'Interrupted before captions began.'
                : turn.text}
            </p>
            {turn.delivery === 'interrupted' && (
              <details>
                <summary>Interrupted reply · full text</summary>
                <p>{turn.text}</p>
              </details>
            )}
          </article>
        ))}
      </div>
      {paused && (
        <button className="chief-text-link" onClick={follow}>
          Back to latest
        </button>
      )}
    </div>
  );
}
