import { describe, expect, it, vi } from 'vitest';
import {
  fileSize,
  previewKind,
  readPreviewText,
  tablePreview,
  TEXT_LIMIT,
} from '../apps/web/src/preview-model';

describe('file preview limits and classification', () => {
  it('recognizes supported files even when uploads have a generic content type', () => {
    expect(previewKind({ id: '1', name: 'notes.md', mime: 'text/plain' })).toBe('markdown');
    expect(previewKind({ id: '2', name: 'results.CSV', mime: 'application/octet-stream' })).toBe(
      'table',
    );
    expect(previewKind({ id: '3', name: 'report.pdf' })).toBe('pdf');
    expect(previewKind({ id: '4', name: 'document.docx' })).toBe('unsupported');
    expect(fileSize(2048)).toBe('2 KB');
  });
  it('preserves quoted delimiters, newlines and escaped quotes in tables', () => {
    expect(
      tablePreview('Name,Notes\r\nAda,"First, second\nthird"\r\nBob,"A ""quote"""').rows,
    ).toEqual([
      ['Name', 'Notes'],
      ['Ada', 'First, second\nthird'],
      ['Bob', 'A "quote"'],
    ]);
    expect(tablePreview('a\tb\nc\td', '\t').rows).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
  it('bounds both rows and columns', () => {
    const result = tablePreview(
      Array.from({ length: 1000 }, () => Array(80).fill('x').join(',')).join('\n'),
    );
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(201);
    expect(result.rows.every((row) => row.length <= 40)).toBe(true);
  });
  it('stops reading large files and cancels the stream', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(65536).fill(65));
      },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
    try {
      const result = await readPreviewText('/file', new AbortController().signal);
      expect(result.text).toHaveLength(TEXT_LIMIT);
      expect(result.truncated).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('does not interpret binary payloads as text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('header\0binary')));
    try {
      await expect(readPreviewText('/file', new AbortController().signal)).rejects.toThrow(
        'cannot be previewed as text',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
