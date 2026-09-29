import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import { conversationCache, type ConversationView } from './conversation-cache';
import type { Message } from '../../../packages/contracts/src/index';

export function useConversationViewport(
  view: ConversationView,
  messages: Message[],
  virtual: Virtualizer<HTMLDivElement, Element>,
  scroll: RefObject<HTMLDivElement | null>,
  following: RefObject<boolean>,
  ready: boolean,
  restore = false,
) {
  const latest = useRef({ messages, virtual });
  const reading = useRef<{ id: string; offset: number; start: number } | null>(null);
  useLayoutEffect(() => {
    latest.current = { messages, virtual };
  });
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element || !ready) return;
    reading.current = null;
    const rememberReading = () => {
      if (following.current) {
        reading.current = null;
        return;
      }
      const top = element.getBoundingClientRect().top;
      const anchor = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (node) => node.getBoundingClientRect().bottom > top,
      );
      const item = anchor && latest.current.virtual.measurementsCache[Number(anchor.dataset.index)];
      if (anchor?.dataset.messageId && item)
        reading.current = {
          id: anchor.dataset.messageId,
          offset: element.scrollTop,
          start: item.start,
        };
    };
    element.addEventListener('scroll', rememberReading);
    const saved = restore ? conversationCache.viewport(view) : undefined;
    if (saved && !saved.following) {
      following.current = false;
      virtual.scrollToOffset(saved.offset);
    }
    // Opening intent owns position; cached measurements only speed up rendering.
    if (following.current)
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    return () => {
      element.removeEventListener('scroll', rememberReading);
      const top = element.getBoundingClientRect().top;
      const anchor = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (node) => node.getBoundingClientRect().bottom > top,
      );
      conversationCache.saveViewport(view, {
        following: following.current,
        offset: element.scrollTop,
        anchor: anchor?.dataset.messageId,
        anchorOffset: anchor ? anchor.getBoundingClientRect().top - top : undefined,
        anchorStart: anchor
          ? latest.current.virtual.measurementsCache[Number(anchor.dataset.index)]?.start
          : undefined,
        width: element.clientWidth,
        height: element.clientHeight,
        measurements: latest.current.virtual.takeSnapshot(),
      });
    };
  }, [view, ready]);
  useLayoutEffect(() => {
    const anchor = reading.current;
    if (following.current || !anchor) return;
    const index = messages.findIndex((message) => message.id === anchor.id);
    const item = virtual.measurementsCache[index];
    if (!item || item.start === anchor.start) return;
    // A refreshed latest page can drop its first row. Keep the same message
    // under the reader's eyes as the bounded history window advances.
    const offset = anchor.offset + item.start - anchor.start;
    virtual.scrollToOffset(offset);
    reading.current = { ...anchor, offset, start: item.start };
  }, [messages]);
}
