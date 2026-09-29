import React, { useEffect, useRef, useState } from 'react';
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type RenderTask,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';
import { fileUrl, type PreviewFile } from './preview-model';

GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfPreview({ file }: { file: PreviewFile }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(320);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(true);
  const [text, setText] = useState('');
  const [textView, setTextView] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(100, entry.contentRect.width - 32)),
    );
    observer.observe(body.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (file.size && file.size > 25 * 1024 * 1024) {
      setError('This PDF is too large to preview here. Download it to read the complete document.');
      setBusy(false);
      return;
    }
    let live = true;
    setError('');
    setDocument(null);
    setBusy(true);
    const loading = getDocument({
      url: fileUrl(file),
      enableXfa: false,
      disableAutoFetch: true,
      disableStream: true,
      useSystemFonts: true,
    });
    loading.promise
      .then((pdf) => {
        if (live) setDocument(pdf);
      })
      .catch((error) => {
        if (live) {
          setError(
            error.name === 'PasswordException'
              ? 'This PDF is password protected. Download it to open with your password.'
              : 'The PDF could not be opened. You can retry or download it.',
          );
          setBusy(false);
        }
      });
    return () => {
      live = false;
      void loading.destroy();
    };
  }, [file.id, retry]);
  useEffect(() => {
    if (!document) return;
    let live = true;
    let render: RenderTask | undefined;
    setBusy(true);
    setError('');
    setText('');
    void (async () => {
      const item = await document.getPage(page);
      if (!live || !canvas.current) return;
      const initial = item.getViewport({ scale: 1 });
      const viewport = item.getViewport({ scale: Math.min(2, width / initial.width) * zoom });
      // Cap the backing canvas; long or oversized pages must not allocate huge textures.
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(8_000_000 / (viewport.width * viewport.height)),
      );
      const element = canvas.current;
      element.width = Math.floor(viewport.width * ratio);
      element.height = Math.floor(viewport.height * ratio);
      element.style.width = viewport.width + 'px';
      element.style.height = viewport.height + 'px';
      render = item.render({ canvas: element, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      const content = await item.getTextContent();
      if (live)
        setText(
          content.items
            .map((value) => ('str' in value ? value.str + (value.hasEOL ? '\n' : ' ') : ''))
            .join(''),
        );
      await render.promise;
      if (live) setBusy(false);
    })().catch((error) => {
      if (live && error.name !== 'RenderingCancelledException') {
        setError('This page could not be displayed. Try again or download the PDF.');
        setBusy(false);
      }
    });
    return () => {
      live = false;
      render?.cancel();
    };
  }, [document, page, width, zoom]);
  return (
    <div className="document-preview pdf-preview">
      <div className="preview-toolbar" role="group" aria-label="PDF controls">
        <button
          className="icon"
          aria-label="Previous page"
          disabled={!document || page <= 1}
          onClick={() => setPage(page - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <span className="pdf-page-count">
          {document ? `${page} / ${document.numPages}` : 'PDF'}
        </span>
        <button
          className="icon"
          aria-label="Next page"
          disabled={!document || page >= document.numPages}
          onClick={() => setPage(page + 1)}
        >
          <ChevronRight size={16} />
        </button>
        <span className="preview-toolbar-spacer" />
        <button
          className="quiet-button"
          aria-pressed={textView}
          onClick={() => setTextView(!textView)}
        >
          {textView ? 'Page' : 'Text'}
        </button>
        <button
          className="icon"
          aria-label="Zoom out"
          disabled={zoom <= 0.5}
          onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}
        >
          <Minus size={16} />
        </button>
        <button className="quiet-button" onClick={() => setZoom(1)}>
          Fit
        </button>
        <button
          className="icon"
          aria-label="Zoom in"
          disabled={zoom >= 2}
          onClick={() => setZoom(Math.min(2, zoom + 0.25))}
        >
          <Plus size={16} />
        </button>
      </div>
      <div
        className="preview-document-scroll pdf-stage"
        ref={body}
        tabIndex={0}
        aria-label="PDF page"
      >
        {error && (
          <div className="preview-state ui-stack">
            <p role="alert">{error}</p>
            <button className="secondary" onClick={() => setRetry(retry + 1)}>
              Try again
            </button>
          </div>
        )}
        {busy && !error && (
          <div className="preview-caption" role="status">
            Rendering page…
          </div>
        )}
        <canvas
          ref={canvas}
          hidden={textView || !!error || busy}
          aria-label={`Page ${page} of ${document?.numPages || ''}. Use Text to read or copy this page.`}
        />
        {textView && !error && (
          <pre className="pdf-text">{text || (busy ? '' : 'No selectable text on this page.')}</pre>
        )}
      </div>
    </div>
  );
}
