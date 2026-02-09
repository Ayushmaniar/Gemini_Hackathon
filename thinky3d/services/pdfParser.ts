import * as pdfjsLib from 'pdfjs-dist';
// Vite: resolve worker from node_modules and get URL for dev + production
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const THUMBNAIL_MAX_WIDTH = 160;

export interface PdfExtractResult {
  text: string;
  numPages: number;
  /** Data URL of the first page as a thumbnail image */
  thumbnail: string;
}

/**
 * Renders the first page of a loaded PDF to a thumbnail data URL.
 */
async function renderFirstPageThumbnail(pdf: Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>): Promise<string> {
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const scale = THUMBNAIL_MAX_WIDTH / viewport.width;
  const scaledViewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = scaledViewport.width;
  canvas.height = scaledViewport.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const renderTask = page.render({
    canvasContext: ctx,
    viewport: scaledViewport,
    background: 'rgb(255, 255, 255)',
  });
  await renderTask.promise;
  return canvas.toDataURL('image/jpeg', 0.85);
}

/**
 * Extracts text from a PDF file (client-side).
 * Works with selectable text; scanned/image-only PDFs may return little or no text.
 * Also generates a thumbnail of the first page.
 */
export async function extractTextFromPdf(file: File): Promise<PdfExtractResult> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;
  const textParts: string[] = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .filter((item: { str?: string }) => 'str' in item)
      .map((item: { str: string }) => item.str)
      .join(' ');
    textParts.push(pageText);
  }

  const text = textParts.join('\n\n').trim();
  let thumbnail = '';
  try {
    thumbnail = await renderFirstPageThumbnail(pdf);
  } catch {
    // Non-fatal: thumbnail is optional
  }
  return { text, numPages, thumbnail };
}
