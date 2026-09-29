import React, { useEffect, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { fileUrl, type PreviewFile } from './preview-model';

type Entry = { name: string; method: number; compressed: number; size: number; offset: number };
type Archive = { bytes: Uint8Array; entries: Entry[] };

const readable =
  /\.(md|markdown|txt|log|json|csv|tsv|js|jsx|ts|tsx|py|css|html|xml|yaml|yml|sql|sh|rs|go|java|c|cpp|h|toml|ini|diff|patch)$/i;
const decoder = new TextDecoder();

async function readArchive(file: PreviewFile, signal: AbortSignal): Promise<Archive | null> {
  const response = await fetch(fileUrl(file), { signal });
  if (!response.ok || !response.body) throw new Error('This file is no longer available.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!total && value.length >= 4 && !(value[0] === 0x50 && value[1] === 0x4b)) {
        await reader.cancel();
        return null;
      }
      total += value.length;
      if (total > 25 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('This archive is too large to preview. Download it to open it.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, cursor);
    cursor += chunk.length;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.length - 65557);
  let end = -1;
  for (let i = bytes.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (count === 0xffff || directorySize === 0xffffffff || offset === 0xffffffff || count > 2000)
    throw new Error(
      'This ZIP archive uses a format that can’t be previewed. Download it to open it.',
    );
  const entries: Entry[] = [];
  const directoryEnd = Math.min(bytes.length, offset + directorySize);
  for (let i = 0; i < count && offset + 46 <= directoryEnd; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (!name.endsWith('/') && readable.test(name) && size <= 256 * 1024 && entries.length < 500)
      entries.push({ name, method, compressed, size, offset: localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { bytes, entries };
}

async function readEntry(archive: Archive, entry: Entry): Promise<string> {
  const view = new DataView(
    archive.bytes.buffer,
    archive.bytes.byteOffset,
    archive.bytes.byteLength,
  );
  if (entry.offset + 30 > archive.bytes.length || view.getUint32(entry.offset, true) !== 0x04034b50)
    throw new Error('This file could not be opened.');
  const nameLength = view.getUint16(entry.offset + 26, true);
  const extraLength = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength;
  const compressed = archive.bytes.subarray(start, start + entry.compressed);
  if (start + entry.compressed > archive.bytes.length)
    throw new Error('This file could not be opened.');
  if (entry.method === 0) return decoder.decode(compressed);
  if (entry.method !== 8 || typeof DecompressionStream === 'undefined')
    throw new Error('This file uses compression that this browser cannot preview.');
  const stream = new Blob([compressed])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 256 * 1024) {
        await reader.cancel();
        throw new Error('This file is too large to preview. Download the archive to open it.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    text.set(chunk, cursor);
    cursor += chunk.length;
  }
  return decoder.decode(text);
}

export default function ArchivePreview({ file }: { file: PreviewFile }) {
  const [archive, setArchive] = useState<Archive | null>(null);
  const [selected, setSelected] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setArchive(null);
    setText('');
    setError('');
    readArchive(file, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!value) {
          setError('This file type can’t be previewed here. You can still download and open it.');
          return;
        }
        setArchive(value);
        const initial =
          value.entries.find((entry) =>
            /(^|\/)(readme|index)\.(md|markdown|html?)$/i.test(entry.name),
          ) || value.entries[0];
        if (initial) setSelected(initial.name);
        else
          setError(
            'The archive contains no readable text or source files. You can still download it.',
          );
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'The archive could not be opened.');
      });
    return () => controller.abort();
  }, [file.id]);
  useEffect(() => {
    if (!archive || !selected) return;
    let alive = true;
    const entry = archive.entries.find((item) => item.name === selected);
    if (!entry) return;
    readEntry(archive, entry)
      .then((value) => {
        if (alive) {
          setText(value);
          setError('');
        }
      })
      .catch((cause) => {
        if (alive)
          setError(cause instanceof Error ? cause.message : 'This file could not be opened.');
      });
    return () => {
      alive = false;
    };
  }, [archive, selected]);
  if (!archive && !error)
    return (
      <div className="preview-state" role="status">
        Opening archive…
      </div>
    );
  if (error && !archive)
    return (
      <div className="preview-state ui-stack">
        <FileText size={40} strokeWidth={1} />
        <h3>File preview</h3>
        <p>{error}</p>
        <a
          className="secondary preview-download"
          href={fileUrl(file) + '?download=1'}
          download={file.name}
        >
          <Download size={16} />
          Download file
        </a>
      </div>
    );
  return (
    <div className="document-preview">
      <div className="preview-toolbar">
        <span>ZIP archive · {archive?.entries.length || 0} readable files</span>
        <span className="preview-toolbar-spacer" />
        <select
          aria-label="Choose a file in the archive"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          {archive?.entries.map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.name}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <div className="preview-state" role="alert">
          {error}
        </div>
      ) : (
        <div className="preview-document-scroll">
          <pre className="preview-code">{text}</pre>
        </div>
      )}
    </div>
  );
}
