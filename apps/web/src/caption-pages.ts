// Break between phrases, preserving earlier pages as a streamed reply grows.
export function captionPages(text: string, limit = 140): string[] {
  const pages: string[] = [];
  let page = '';
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    if (page && page.length + word.length + 1 > limit) {
      pages.push(page);
      page = '';
    }
    page += (page ? ' ' : '') + word;
    if (page.length >= limit * 0.6 && /[.!?;,:]["'”’)]*$/.test(word)) {
      pages.push(page);
      page = '';
    }
  }
  if (page) pages.push(page);
  return pages;
}
