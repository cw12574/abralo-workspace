import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check } from 'lucide-react';
import {
  fileUrl,
  previewKind,
  readPreviewText,
  tablePreview,
  type PreviewFile,
} from './preview-model';

function HighlightedText({ text }: { text: string }) {
  if (text.length > 48000) return <>{text}</>;
  const parts = text.split(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:true|false|null|const|let|function|return|import|export|class|def|if|else|await|async)\b|\b\d+(?:\.\d+)?\b)/g,
  );
  if (parts.length > 6000) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) =>
        index % 2 ? (
          <span
            className={/^["']/.test(part) ? 'preview-token-string' : 'preview-token-value'}
            key={index}
          >
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

export default function TextPreview({ file }: { file: PreviewFile }) {
  const [data, setData] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [raw, setRaw] = useState(false);
  const kind = previewKind(file);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setData(null);
    readPreviewText(fileUrl(file), controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [file.id, retry]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const formatted = useMemo(() => {
    if (!data) return '';
    if (kind === 'json' && !data.truncated) {
      try {
        return JSON.stringify(JSON.parse(data.text), null, 2);
      } catch {
        /* Incomplete JSON is still readable. */
      }
    }
    return data.text;
  }, [data, kind]);
  const table = useMemo(
    () =>
      kind === 'table' && data
        ? tablePreview(data.text, file.name.endsWith('.tsv') ? '\t' : ',')
        : null,
    [data, kind],
  );
  const clipped = formatted.length > 120000 || !!data?.truncated;
  const display = formatted.slice(0, 120000);
  if (error)
    return (
      <div className="preview-state ui-stack">
        <p role="alert">{error}</p>
        <button className="secondary" onClick={() => setRetry(retry + 1)}>
          Try again
        </button>
      </div>
    );
  if (!data)
    return (
      <div className="preview-state" role="status">
        Opening file…
      </div>
    );
  return (
    <div className="document-preview">
      <div className="preview-toolbar">
        <span>
          {kind === 'table'
            ? 'Table'
            : kind === 'markdown'
              ? 'Document'
              : kind === 'json'
                ? 'JSON'
                : 'Text'}
        </span>
        {(kind === 'markdown' || kind === 'table') && (
          <button className="quiet-button" aria-pressed={raw} onClick={() => setRaw(!raw)}>
            {raw ? 'Preview' : 'Source'}
          </button>
        )}
        <span className="preview-toolbar-spacer" />
        <button
          className="quiet-button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(display);
              setCopied(true);
              setCopyError('');
            } catch {
              setCopyError('Copy unavailable. You can select and copy the text below.');
            }
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {copyError && (
        <p className="preview-notice" role="status">
          {copyError}
        </p>
      )}
      {(clipped || table?.truncated) && (
        <p className="preview-notice">Showing a limited preview. Download for the complete file.</p>
      )}
      <div className="preview-document-scroll" tabIndex={0} aria-label="File contents">
        {!display.trim() ? (
          <div className="preview-state">This file is empty.</div>
        ) : kind === 'markdown' && !raw && display.length <= 32000 ? (
          <div className="preview-prose prose">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                img: ({ alt }) => <span className="quiet">[Image: {alt || 'embedded image'}]</span>,
                a: ({ children, ...props }) => (
                  <a {...props} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                ),
              }}
            >
              {display}
            </ReactMarkdown>
          </div>
        ) : table && !raw ? (
          <table className="preview-table">
            <thead>
              <tr>
                {(table.rows[0] || []).map((cell, index) => (
                  <th key={index}>{cell || `Column ${index + 1}`}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.slice(1).map((row, index) => (
                <tr key={index}>
                  {row.map((cell, col) => (
                    <td key={col}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <pre className="preview-code">
            <code>
              <HighlightedText text={display} />
            </code>
          </pre>
        )}
      </div>
      {kind === 'markdown' && display.length > 32000 && !raw && (
        <div className="preview-caption">
          Large document shown as text for a responsive preview.
        </div>
      )}
    </div>
  );
}
