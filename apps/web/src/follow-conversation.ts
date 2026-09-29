import { useEffect, useRef, useState, type RefObject } from 'react';

export function useFollowConversation(
  scroll: RefObject<HTMLDivElement | null>,
  following: RefObject<boolean>,
  conversation: string,
) {
  const expected = useRef<number | null>(null);
  const [atLatest, setAtLatest] = useState(following.current);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    let frame = 0;
    let initial = true;
    let lastTime = 0;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const step = (time: number) => {
      frame = 0;
      if (!following.current) return;
      const target = Math.max(0, element.scrollHeight - element.clientHeight);
      const distance = target - element.scrollTop;
      const fraction = 1 - Math.exp(-Math.min(64, time - lastTime || 16) / 55);
      lastTime = time;
      element.scrollTop =
        initial ||
        motion.matches ||
        Math.abs(distance) <= 1 ||
        Math.abs(distance) > element.clientHeight
          ? target
          : element.scrollTop + distance * fraction;
      expected.current = element.scrollTop;
      setAtLatest(true);
      initial = false;
      if (Math.abs(target - element.scrollTop) >= 1) frame = requestAnimationFrame(step);
    };
    const schedule = () => {
      if (!following.current)
        setAtLatest(element.scrollHeight - element.scrollTop - element.clientHeight <= 2);
      if (following.current && !frame) {
        lastTime = 0;
        frame = requestAnimationFrame(step);
      }
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    const changed = new MutationObserver((records) => {
      for (const record of records) {
        for (const child of record.removedNodes)
          if (child instanceof Element) observer.unobserve(child);
        for (const child of record.addedNodes)
          if (child instanceof Element) observer.observe(child);
      }
      schedule();
    });
    // Only direct children: text streaming is measured through the virtual list.
    changed.observe(element, { childList: true });
    const stop = () => {
      following.current = false;
      setAtLatest(false);
      expected.current = null;
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0) stop();
    };
    const key = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) stop();
    };
    const scrollbar = (event: PointerEvent) => {
      const bounds = element.getBoundingClientRect();
      if (
        event.target === element &&
        event.clientX >= bounds.right - Math.max(12, element.offsetWidth - element.clientWidth)
      )
        stop();
    };
    element.addEventListener('wheel', wheel, { passive: true });
    element.addEventListener('touchmove', stop, { passive: true });
    element.addEventListener('keydown', key);
    element.addEventListener('pointerdown', scrollbar);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      changed.disconnect();
      element.removeEventListener('wheel', wheel);
      element.removeEventListener('touchmove', stop);
      element.removeEventListener('keydown', key);
      element.removeEventListener('pointerdown', scrollbar);
      expected.current = null;
    };
  }, [conversation, scroll, following]);
  const handleScroll = () => {
    const element = scroll.current!;
    if (expected.current !== null && Math.abs(element.scrollTop - expected.current) < 1) return;
    expected.current = null;
    // Layout changes and virtual-row measurements also dispatch scroll events.
    // Only an upward user gesture pauses following; reaching the bottom resumes it.
    if (element.scrollHeight - element.scrollTop - element.clientHeight <= 2)
      following.current = true;
    setAtLatest(following.current);
  };
  const jumpToLatest = () => {
    following.current = true;
    const element = scroll.current;
    if (element) {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      expected.current = element.scrollTop;
    }
    setAtLatest(true);
  };
  return { handleScroll, atLatest, jumpToLatest };
}
