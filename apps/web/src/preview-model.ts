import { createContext, useContext } from 'react';

export type PreviewFile = { id: string; name: string; mime?: string; size?: number };
export type PreviewItem = {
  kind: 'files';
  files: PreviewFile[];
  index: number;
  onDiscuss?: () => void;
};

export const PreviewContext = createContext<(item: PreviewItem) => void>(() => {});
export const usePreview = () => useContext(PreviewContext);
export const fileUrl = (file: PreviewFile) => '/api/attachments/' + encodeURIComponent(file.id);
export function previewKind(file: PreviewFile) {
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  if (file.mime?.startsWith('image/')) return 'image';
  if (file.mime === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (file.mime === 'application/zip' || extension === 'zip') return 'archive';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'csv' || extension === 'tsv') return 'table';
  if (extension === 'json' || file.mime === 'application/json') return 'json';
  if (
    file.mime?.startsWith('text/') ||
    /^(txt|log|js|jsx|ts|tsx|py|css|html|xml|yaml|yml|sql|sh|rs|go|java|c|cpp|h|toml|ini|diff|patch)$/.test(
      extension || '',
    )
  )
    return 'text';
  return 'unsupported';
}
export function fileSize(size?: number) {
  if (size === undefined) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// A bounded RFC 4180 reader: quoted delimiters/newlines and escaped quotes are
// preserved without constructing an unbounded table for a large attachment.
export function tablePreview(text: string, delimiter = ',') {
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false,
    truncated = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (character === delimiter || character === '\n' || character === '\r')) {
      if (row.length < 40) row.push(field);
      else truncated = true;
      field = '';
      if (character !== delimiter) {
        if (character === '\r' && text[i + 1] === '\n') i++;
        rows.push(row);
        row = [];
        if (rows.length === 201) return { rows, truncated: i < text.length - 1 || truncated };
      }
    } else field += character;
  }
  if (field || row.length) {
    if (row.length < 40) row.push(field);
    else truncated = true;
    rows.push(row);
  }
  return { rows, truncated };
}

export const TEXT_LIMIT = 256 * 1024;
export async function readPreviewText(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new Error(
      response.status === 403 || response.status === 404
        ? 'This file is no longer available.'
        : 'The file could not be loaded.',
    );
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The file could not be loaded.');
  const decoder = new TextDecoder();
  let text = '',
    count = 0,
    truncated = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const remaining = TEXT_LIMIT - count;
      text += decoder.decode(result.value.subarray(0, remaining), { stream: true });
      count += result.value.length;
      if (count >= TEXT_LIMIT) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (text.includes('\0'))
    throw new Error('This file cannot be previewed as text. Download it to open in another app.');
  return { text, truncated };
}
