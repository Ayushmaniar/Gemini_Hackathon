/**
 * HTML utility functions for slide content processing
 */

// ============================================================================
// Unicode Subscript / Superscript -> HTML <sub>/<sup> conversion
// ============================================================================
// LLMs sometimes output Unicode sub/superscript characters (e.g. e⁻, H₂O)
// instead of LaTeX ($e^{-}$, $H_2O$). These bypass MathJax and may render as
// boxes (☒) if the web font lacks the glyphs. Converting them to proper HTML
// <sub>/<sup> tags guarantees correct rendering in all browsers/fonts.

const SUPERSCRIPT_MAP: Record<string, string> = {
  '\u2070': '0', '\u00B9': '1', '\u00B2': '2', '\u00B3': '3',
  '\u2074': '4', '\u2075': '5', '\u2076': '6', '\u2077': '7',
  '\u2078': '8', '\u2079': '9', '\u207A': '+', '\u207B': '-',
  '\u207C': '=', '\u207D': '(', '\u207E': ')', '\u207F': 'n',
};

const SUBSCRIPT_MAP: Record<string, string> = {
  '\u2080': '0', '\u2081': '1', '\u2082': '2', '\u2083': '3',
  '\u2084': '4', '\u2085': '5', '\u2086': '6', '\u2087': '7',
  '\u2088': '8', '\u2089': '9', '\u208A': '+', '\u208B': '-',
  '\u208C': '=', '\u208D': '(', '\u208E': ')',
};

const SUPERSCRIPT_CHARS = Object.keys(SUPERSCRIPT_MAP).join('');
const SUBSCRIPT_CHARS = Object.keys(SUBSCRIPT_MAP).join('');

// Match one or more consecutive superscript characters
const SUPERSCRIPT_RE = new RegExp(`[${SUPERSCRIPT_CHARS}]+`, 'g');
// Match one or more consecutive subscript characters
const SUBSCRIPT_RE = new RegExp(`[${SUBSCRIPT_CHARS}]+`, 'g');

/**
 * Convert Unicode superscript/subscript characters in an HTML string to
 * proper <sup>/<sub> tags so they render correctly regardless of font support.
 *
 * Example: "H₂O" -> "H<sub>2</sub>O",  "e⁻" -> "e<sup>-</sup>"
 */
export function sanitizeUnicodeMath(html: string): string {
  // Replace superscripts: consecutive superscript chars -> <sup>ASCII</sup>
  let result = html.replace(SUPERSCRIPT_RE, (match) => {
    const ascii = [...match].map(ch => SUPERSCRIPT_MAP[ch] || ch).join('');
    return `<sup>${ascii}</sup>`;
  });

  // Replace subscripts: consecutive subscript chars -> <sub>ASCII</sub>
  result = result.replace(SUBSCRIPT_RE, (match) => {
    const ascii = [...match].map(ch => SUBSCRIPT_MAP[ch] || ch).join('');
    return `<sub>${ascii}</sub>`;
  });

  return result;
}

/**
 * Compress slide HTML to maintain slide-like density
 * Removes verbose content, limits bullets, and trims paragraphs
 *
 * @param html - Raw HTML content from slide generation
 * @param slideTitle - Optional slide title to remove duplicate headings
 * @returns Compressed HTML suitable for slide presentation
 */
export function compressSlideHtml(html: string, slideTitle?: string): string {
  // Keep slide-like density even if the model outputs verbose HTML.
  // This runs client-side, so we can use DOMParser safely.
  try {
    // First pass: Remove any image tags using regex (fast early filter)
    // This catches hallucinated images before DOM parsing
    html = html.replace(/<img[^>]*>/gi, '');

    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div id="__root__">${html}</div>`, 'text/html');
    const root = doc.getElementById('__root__');
    if (!root) return html;

    // Remove any hallucinated image tags (LLMs sometimes generate fake img elements)
    const images = Array.from(root.querySelectorAll('img'));
    for (const img of images) {
      // Replace image with a text description if alt text exists
      if (img.alt) {
        const replacement = doc.createElement('p');
        replacement.className = 'text-sm italic text-gray-400 border-l-2 border-gray-600 pl-3';
        replacement.textContent = `[Visual: ${img.alt}]`;
        img.replaceWith(replacement);
      } else {
        img.remove();
      }
    }

    // Remove duplicated heading that matches the slide title (common LLM pattern)
    if (slideTitle) {
      const headings = Array.from(root.querySelectorAll('h1,h2,h3'));
      for (const h of headings) {
        const t = (h.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.toLowerCase() === slideTitle.toLowerCase()) {
          h.remove();
          break;
        }
      }
    }

    const sentenceTrim = (text: string, maxSentences: number) => {
      const cleaned = text.replace(/\s+/g, ' ').trim();
      if (!cleaned) return cleaned;
      const parts = cleaned.split(/(?<=[.!?])\s+/);
      if (parts.length <= maxSentences) return cleaned;
      return parts.slice(0, maxSentences).join(' ');
    };

    // Trim paragraphs that are too long
    const paragraphs = Array.from(root.querySelectorAll('p'));
    for (const p of paragraphs) {
      const txt = (p.textContent || '').trim();
      if (txt.length > 240) {
        p.textContent = sentenceTrim(txt, 2);
      }
    }

    // Limit list items (most common source of text bloat)
    for (const list of Array.from(root.querySelectorAll('ul,ol'))) {
      const items = Array.from(list.querySelectorAll(':scope > li'));
      items.slice(5).forEach(li => li.remove());
      for (const li of items.slice(0, 5)) {
        const t = (li.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length > 110) {
          li.textContent = t.slice(0, 107) + '…';
        }
      }
    }

    // Cap excessive paragraphs (keep structure; avoid deleting boxes/grids)
    const topLevelParagraphs = Array.from(root.children).filter(el => el.tagName === 'P');
    if (topLevelParagraphs.length > 4) {
      topLevelParagraphs.slice(4).forEach(el => el.remove());
    }

    // Final pass: convert any Unicode sub/superscripts to HTML <sub>/<sup>
    return sanitizeUnicodeMath(root.innerHTML);
  } catch {
    return sanitizeUnicodeMath(html);
  }
}
