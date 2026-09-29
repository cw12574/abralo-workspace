import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  MessageSquare,
  X,
} from 'lucide-react';
import { fileUrl, previewKind, type PreviewItem, type PreviewFile } from './preview-model';
import ImagePreview from './image-preview';
const TextPreview = lazy(() => import('./text-preview'));
const PdfPreview = lazy(() => import('./pdf-preview'));
const ArchivePreview = lazy(() => import('./archive-preview'));

class PreviewBoundary extends React.Component<{ children: React.ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="preview-state ui-stack">
        <p role="alert">The preview could not be loaded. You can still download the file.</p>
        <button className="secondary" onClick={() => this.setState({ error: false })}>
          Try again
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}

function FilePreview({ file }: { file: PreviewFile }) {
  const kind = previewKind(file);
  if (kind === 'image') return <ImagePreview file={file} />;
  if (kind === 'archive' || kind === 'unsupported')
    return (
      <Suspense
        fallback={
          <div className="preview-state" role="status">
            Opening file…
          </div>
        }
      >
        <ArchivePreview file={file} />
      </Suspense>
    );
  return (
    <Suspense
      fallback={
        <div className="preview-state" role="status">
          Opening preview…
        </div>
      }
    >
      {kind === 'pdf' ? <PdfPreview file={file} /> : <TextPreview file={file} />}
    </Suspense>
  );
}

export default function PreviewViewer({
  item,
  expanded,
  onExpand,
  onClose,
}: {
  item: PreviewItem;
  expanded: boolean;
  onExpand: () => void;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(item.index);
  const close = useRef<HTMLButtonElement>(null);
  const files = item.files;
  const file = files[index];
  const title = file.name;
  const kind = previewKind(file);
  const change = (value: number) => setIndex(Math.max(0, Math.min(files.length - 1, value)));
  useEffect(() => {
    close.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      if (
        (event.target as Element)?.closest(
          'input, textarea, select, [contenteditable], [role="separator"], .preview-document-scroll',
        )
      )
        return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!close.current?.closest('.side-panel')?.contains(event.target as Node)) return;
      if (files.length > 1 && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        change(index + (event.key === 'ArrowLeft' ? -1 : 1));
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  }, [onClose, index, files.length]);
  return (
    <>
      <header className="preview-header">
        <div className="preview-heading">
          {kind === 'image' ? (
            <ImageIcon size={16} aria-hidden="true" />
          ) : (
            <FileText size={16} aria-hidden="true" />
          )}
          <h2 title={title} aria-label={title}>
            {title}
          </h2>
        </div>
        <div className="preview-header-actions">
          {item.onDiscuss && (
            <button
              className="icon"
              aria-label="Discuss in thread"
              title="Discuss in thread"
              onClick={item.onDiscuss}
            >
              <MessageSquare size={17} />
            </button>
          )}
          <a
            className="icon"
            href={fileUrl(file) + '?download=1'}
            download={file.name}
            aria-label="Download file"
            title="Download file"
          >
            <Download size={17} />
          </a>
          <button
            className="icon"
            onClick={onExpand}
            aria-label={expanded ? 'Restore preview size' : 'Expand preview'}
            title={expanded ? 'Restore preview size' : 'Expand preview'}
          >
            {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
          <button
            ref={close}
            className="icon"
            onClick={onClose}
            aria-label="Close preview"
            title="Close preview · Esc"
          >
            <X size={18} />
          </button>
        </div>
      </header>
      <PreviewBoundary key={file.id}>
        <FilePreview file={file} />
      </PreviewBoundary>
      {files.length > 1 && (
        <footer className="preview-gallery">
          <button
            className="icon"
            aria-label="Previous attachment"
            disabled={index === 0}
            onClick={() => change(index - 1)}
          >
            <ChevronLeft size={18} />
          </button>
          <span className="preview-gallery-count" aria-live="polite">
            {index + 1} of {files.length}
          </span>
          <div className="preview-thumbnails" aria-label="Attachments from this message">
            {files.map((entry, position) => (
              <button
                key={entry.id}
                className="preview-thumbnail"
                aria-label={`Preview ${entry.name}`}
                aria-pressed={position === index}
                onClick={() => change(position)}
                title={entry.name}
              >
                {previewKind(entry) === 'image' ? (
                  <img src={fileUrl(entry)} alt="" />
                ) : (
                  <FileText size={19} />
                )}
              </button>
            ))}
          </div>
          <button
            className="icon"
            aria-label="Next attachment"
            disabled={index === files.length - 1}
            onClick={() => change(index + 1)}
          >
            <ChevronRight size={18} />
          </button>
        </footer>
      )}
    </>
  );
}
