import { captionPages } from './caption-pages';
export type CaptionEntry = { id: string; text: string; interrupted?: boolean };

/**
 * Live captions, growing word by word with the audio. The line before stays
 * faintly visible so a new line never replaces the last one abruptly.
 * The full conversation is kept with the recap, so there is nothing to page.
 */
export function LiveThought({ entries }: { entries: CaptionEntry[] }) {
  const pages = entries.flatMap((entry) =>
    captionPages(entry.text).map((text, index) => ({
      id: `${entry.id}-${index}`,
      text,
    })),
  );
  const current = pages[pages.length - 1];
  const previous = pages[pages.length - 2];
  return (
    <div className="chief-captions ui-stack">
      <div className="chief-current-thought" role="log" aria-label="Live captions" aria-live="off">
        {current ? (
          <>
            {previous && (
              <p className="chief-caption chief-caption-previous" key={previous.id}>
                {previous.text}
              </p>
            )}
            <p className="chief-caption" key={current.id}>
              {current.text}
            </p>
          </>
        ) : (
          <p className="chief-caption-placeholder">A little space to think together.</p>
        )}
      </div>
    </div>
  );
}
