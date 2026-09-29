import { useEffect, useRef, useState } from 'react';

export const REVEAL_INTERVAL = 55;
export const REVEAL_FADE = 160;

// Release complete words together, but never hold a long word, URL or CJK text
// indefinitely. Large bursts catch up in one update rather than forming a queue.
export function revealEnd(text: string, start: number, flush: boolean) {
  if (flush) return text.length;
  const tail = text.slice(start);
  const complete = tail.match(/^[\s\S]*\s/);
  return start + (complete?.[0].length || 0);
}

type Reveal = { start: number; end: number; at: number };

export function useStreamingText(text: string, streaming: boolean) {
  const [reduced, setReduced] = useState(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [frame, setFrame] = useState(() => ({ text, reveals: [] as Reveal[] }));
  const latest = useRef({ text, streaming });
  latest.current = { text, streaming };
  const current = useRef(frame);
  const wake = useRef(() => {});

  useEffect(() => {
    if (!streaming) return;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(media.matches);
    change();
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, [streaming]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heldSince = 0;
    const tick = () => {
      timer = undefined;
      const target = latest.current;
      const previous = current.current;
      const time = performance.now();
      let next = previous;
      if (
        !target.streaming ||
        reduced ||
        document.hidden ||
        !target.text.startsWith(previous.text)
      ) {
        next = { text: target.text, reveals: [] };
      } else {
        if (target.text.length > previous.text.length && !heldSince) heldSince = time;
        const end = revealEnd(
          target.text,
          previous.text.length,
          !!heldSince && time - heldSince >= REVEAL_INTERVAL,
        );
        const reveals = previous.reveals.filter((item) => time - item.at < REVEAL_FADE);
        if (end > previous.text.length) {
          reveals.push({ start: previous.text.length, end, at: time });
          heldSince = 0;
        }
        next = { text: target.text.slice(0, end), reveals };
      }
      if (
        next.text !== previous.text ||
        next.reveals.length !== previous.reveals.length ||
        next.reveals.at(-1) !== previous.reveals.at(-1)
      ) {
        current.current = next;
        setFrame(next);
      }
      if (target.streaming && !reduced && (next.text !== target.text || next.reveals.length))
        timer = setTimeout(tick, REVEAL_INTERVAL);
    };
    wake.current = () => {
      if (timer === undefined) timer = setTimeout(tick, REVEAL_INTERVAL);
    };
    tick();
    return () => {
      clearTimeout(timer);
      wake.current = () => {};
    };
  }, [streaming, reduced]);
  useEffect(() => {
    if (text !== current.current.text) wake.current();
  }, [text]);

  // Completion, corrections and reduced motion must never wait for a timer.
  if (!streaming || reduced || !text.startsWith(frame.text)) return { text, reveals: [] };
  return frame;
}

// Operate on parsed Markdown text, preserving links, lists and formatting. Only
// the last 160 ms gets wrappers; code and transformed/escaped text stay crisp.
export function rehypeTextReveal(options: { source: string; reveals: Reveal[] }) {
  return (tree: any) => {
    if (!options.reveals.length) return;
    const visit = (parent: any) => {
      if (!parent.children || ['pre', 'code'].includes(parent.tagName)) return;
      parent.children = parent.children.flatMap((node: any) => {
        if (node.type !== 'text') {
          visit(node);
          return [node];
        }
        const start = node.position?.start?.offset;
        const end = node.position?.end?.offset;
        if (
          start === undefined ||
          end === undefined ||
          options.source.slice(start, end) !== node.value
        )
          return [node];
        const parts: any[] = [];
        let cursor = start;
        for (const reveal of options.reveals) {
          const from = Math.max(start, reveal.start);
          const to = Math.min(end, reveal.end);
          if (from >= to) continue;
          if (from > cursor)
            parts.push({ type: 'text', value: options.source.slice(cursor, from) });
          parts.push({
            type: 'element',
            tagName: 'span',
            properties: {
              className: ['text-reveal'],
              style: `animation-delay: -${Math.min(REVEAL_FADE, performance.now() - reveal.at)}ms`,
            },
            children: [{ type: 'text', value: options.source.slice(from, to) }],
          });
          cursor = to;
        }
        if (!parts.length) return [node];
        if (cursor < end) parts.push({ type: 'text', value: options.source.slice(cursor, end) });
        return parts;
      });
    };
    visit(tree);
  };
}
