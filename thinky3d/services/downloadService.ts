import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import type { Course, Section, Slide, QuizQuestion, ControlParam, LearningLevel } from '../types';
import { getTextTheme, getAverageBrightness } from '../utils/colors';

// ============================================================================
// Helpers
// ============================================================================

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_').substring(0, 80);
}

function getSectionSlides(section: Section): Slide[] | null {
  const slides = section.content?.slides ?? section.partialContent?.slides;
  return slides && slides.length > 0 ? slides : null;
}

function getSectionQuiz(section: Section): QuizQuestion[] | null {
  const quiz = section.content?.quiz;
  return quiz && quiz.length > 0 ? quiz : null;
}

function getSectionSimCode(section: Section): string | null {
  const code = section.content?.interactiveConfig?.code;
  return code && code.trim().length > 0 ? code : null;
}

function getSectionSimParams(section: Section): ControlParam[] {
  return section.content?.interactiveConfig?.params ?? [];
}

function getSlideBackgroundCSS(slide: Slide): string {
  if (slide.backgroundGradient) {
    const { type, colors, direction = '135deg' } = slide.backgroundGradient;
    if (type === 'linear') {
      return `background: linear-gradient(${direction}, ${colors.join(', ')});`;
    } else {
      const pos = direction || '50% 50%';
      return `background: radial-gradient(circle at ${pos}, ${colors.join(', ')});`;
    }
  } else if (slide.backgroundColor) {
    return `background-color: ${slide.backgroundColor};`;
  }
  return 'background: linear-gradient(135deg, #1a1a2e, #16213e);';
}

function getSlideTextTheme(slide: Slide): 'light' | 'dark' {
  if (slide.theme === 'light') return 'light';
  if (slide.theme === 'dark') return 'dark';
  if (slide.backgroundGradient) {
    const avgBrightness = getAverageBrightness(slide.backgroundGradient.colors);
    return avgBrightness > 128 ? 'dark' : 'light';
  } else if (slide.backgroundColor) {
    return getTextTheme(slide.backgroundColor);
  }
  return 'light';
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================================
// Page-by-page renderer: html2canvas each div, add as image to jsPDF
// ============================================================================

/**
 * Render an array of DOM elements one-by-one with html2canvas and add each
 * as a full-page image to a jsPDF document. Returns the PDF as a Blob.
 *
 * Each element is temporarily appended to document.body, rendered, then removed.
 * The download progress overlay (z-50) covers the briefly-visible element.
 */
async function renderPagesToPdf(
  pages: HTMLElement[],
  pageWidth: number,
  pageHeight: number,
  orientation: 'landscape' | 'portrait',
): Promise<Blob> {
  const pdf = new jsPDF({
    orientation,
    unit: 'px',
    format: [pageWidth, pageHeight],
    hotfixes: ['px_scaling'],
    compress: true,
  });

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];

    // Append to body so html2canvas can compute styles and render
    document.body.appendChild(page);

    // Let the browser lay out the element before capturing
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // MathJax typeset if available
    try {
      if ((window as any).MathJax?.typesetPromise) {
        await (window as any).MathJax.typesetPromise([page]);
      }
    } catch (_) { /* ignore */ }

    const canvas = await html2canvas(page, {
      scale: 2,
      useCORS: true,
      logging: false,
      width: pageWidth,
      height: pageHeight,
      windowWidth: pageWidth,
      windowHeight: pageHeight,
    });

    document.body.removeChild(page);

    const imgData = canvas.toDataURL('image/jpeg', 0.92);

    if (i > 0) pdf.addPage([pageWidth, pageHeight], orientation);
    pdf.addImage(imgData, 'JPEG', 0, 0, pageWidth, pageHeight);
  }

  return pdf.output('blob');
}

// ============================================================================
// Build page elements
// ============================================================================

function buildSlideDivider(sectionIndex: number, title: string): HTMLElement {
  const div = document.createElement('div');
  div.style.cssText = `
    position: absolute; left: 0; top: 0;
    width: 1024px; height: 768px; display: flex; flex-direction: column;
    align-items: center; justify-content: center; text-align: center;
    background: linear-gradient(135deg, #0a0a1f 0%, #1a1a3e 50%, #0d0d2b 100%);
    box-sizing: border-box; padding: 60px; z-index: 40; pointer-events: none;
    font-family: system-ui, -apple-system, sans-serif;
  `;
  div.innerHTML = `
    <div style="font-size: 18px; font-weight: 600; letter-spacing: 4px; text-transform: uppercase;
      color: #4285f4; margin-bottom: 24px;">
      Chapter ${sectionIndex + 1}
    </div>
    <div style="font-size: 42px; font-weight: 700; color: #ffffff; line-height: 1.3; max-width: 800px;">
      ${escapeHtml(title)}
    </div>
    <div style="width: 80px; height: 4px; margin-top: 32px; border-radius: 2px;
      background: linear-gradient(90deg, #4285f4, #34a853);"></div>
  `;
  return div;
}

function buildSlidePageElement(slide: Slide): HTMLElement {
  const theme = getSlideTextTheme(slide);
  const textColor = theme === 'light' ? '#f4f6f6' : '#1c2833';
  const mutedColor = theme === 'light' ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)';
  const bgCSS = getSlideBackgroundCSS(slide);

  const page = document.createElement('div');
  page.style.cssText = `
    position: absolute; left: 0; top: 0;
    width: 1024px; height: 768px; ${bgCSS}
    box-sizing: border-box; padding: 48px 56px; overflow: hidden;
    display: flex; flex-direction: column;
    font-family: system-ui, -apple-system, sans-serif;
    z-index: 40; pointer-events: none;
  `;

  const titleEl = document.createElement('h2');
  titleEl.style.cssText = `
    font-size: 32px; font-weight: 700; margin: 0 0 24px 0; line-height: 1.3;
    color: ${textColor};
  `;
  titleEl.textContent = slide.title;

  const contentEl = document.createElement('div');
  contentEl.style.cssText = `
    flex: 1; overflow: hidden; color: ${textColor}; font-size: 18px; line-height: 1.7;
  `;
  contentEl.innerHTML = applyInlineStyles(slide.content, textColor, mutedColor);

  page.appendChild(titleEl);
  page.appendChild(contentEl);
  return page;
}

/** Apply inline styles to slide HTML content so it renders without Tailwind */
function applyInlineStyles(html: string, textColor: string, mutedColor: string): string {
  const temp = document.createElement('div');
  temp.innerHTML = html;

  temp.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(el => {
    const heading = el as HTMLElement;
    const level = parseInt(heading.tagName[1]);
    const sizes: Record<number, string> = { 1: '28px', 2: '24px', 3: '21px', 4: '18px', 5: '16px', 6: '14px' };
    heading.style.fontSize = sizes[level] || '18px';
    heading.style.fontWeight = '700';
    heading.style.color = textColor;
    heading.style.marginTop = '16px';
    heading.style.marginBottom = '8px';
    heading.style.lineHeight = '1.3';
  });

  temp.querySelectorAll('p').forEach(el => {
    (el as HTMLElement).style.marginBottom = '10px';
    (el as HTMLElement).style.lineHeight = '1.7';
  });

  temp.querySelectorAll('ul').forEach(el => {
    (el as HTMLElement).style.paddingLeft = '24px';
    (el as HTMLElement).style.marginBottom = '10px';
    (el as HTMLElement).style.listStyleType = 'disc';
  });
  temp.querySelectorAll('ol').forEach(el => {
    (el as HTMLElement).style.paddingLeft = '24px';
    (el as HTMLElement).style.marginBottom = '10px';
    (el as HTMLElement).style.listStyleType = 'decimal';
  });
  temp.querySelectorAll('li').forEach(el => {
    (el as HTMLElement).style.marginBottom = '4px';
    (el as HTMLElement).style.lineHeight = '1.6';
  });

  temp.querySelectorAll('strong, b').forEach(el => {
    (el as HTMLElement).style.fontWeight = '700';
  });

  temp.querySelectorAll('em, i').forEach(el => {
    (el as HTMLElement).style.fontStyle = 'italic';
  });

  temp.querySelectorAll('pre').forEach(el => {
    (el as HTMLElement).style.cssText = `
      background: rgba(0,0,0,0.3); border-radius: 8px; padding: 12px 16px;
      font-family: 'Fira Code', monospace; font-size: 14px; overflow-x: auto;
      margin-bottom: 12px;
    `;
  });

  temp.querySelectorAll('code').forEach(el => {
    if (el.parentElement?.tagName !== 'PRE') {
      (el as HTMLElement).style.cssText = `
        background: rgba(0,0,0,0.2); border-radius: 4px; padding: 2px 6px;
        font-family: 'Fira Code', monospace; font-size: 0.9em;
      `;
    }
  });

  temp.querySelectorAll('blockquote').forEach(el => {
    (el as HTMLElement).style.cssText = `
      border-left: 4px solid ${mutedColor}; padding-left: 16px;
      margin: 12px 0; color: ${mutedColor}; font-style: italic;
    `;
  });

  temp.querySelectorAll('table').forEach(el => {
    (el as HTMLElement).style.cssText = `
      width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 15px;
    `;
  });
  temp.querySelectorAll('th').forEach(el => {
    (el as HTMLElement).style.cssText = `
      padding: 8px 12px; text-align: left; font-weight: 700;
      border-bottom: 2px solid ${mutedColor};
    `;
  });
  temp.querySelectorAll('td').forEach(el => {
    (el as HTMLElement).style.cssText = `
      padding: 6px 12px; border-bottom: 1px solid rgba(128,128,128,0.3);
    `;
  });

  return temp.innerHTML;
}

// ============================================================================
// PDF Generation - Slides
// ============================================================================

async function generateSlidesPdf(sections: Section[]): Promise<Blob> {
  const pages: HTMLElement[] = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const slides = getSectionSlides(section);
    if (!slides) continue;

    // Section divider page
    pages.push(buildSlideDivider(i, section.title));

    // Individual slide pages
    for (const slide of slides) {
      pages.push(buildSlidePageElement(slide));
    }
  }

  if (pages.length === 0) throw new Error('No slides available to export.');

  return renderPagesToPdf(pages, 1024, 768, 'landscape');
}

// ============================================================================
// PDF Generation - Quizzes
// ============================================================================

function buildQuizTitlePage(topic: string): HTMLElement {
  const page = document.createElement('div');
  page.style.cssText = `
    position: absolute; left: 0; top: 0;
    width: 794px; height: 1123px; display: flex; flex-direction: column;
    align-items: center; justify-content: center; text-align: center;
    background: linear-gradient(135deg, #0a0a1f 0%, #1a1a3e 50%, #0d0d2b 100%);
    box-sizing: border-box; padding: 60px; z-index: 40; pointer-events: none;
    font-family: system-ui, -apple-system, sans-serif;
  `;
  page.innerHTML = `
    <div style="font-size: 16px; font-weight: 600; letter-spacing: 4px; text-transform: uppercase;
      color: #34a853; margin-bottom: 24px;">Quiz & Assessment</div>
    <div style="font-size: 38px; font-weight: 700; color: #ffffff; line-height: 1.3;
      max-width: 600px;">${escapeHtml(topic)}</div>
    <div style="width: 80px; height: 4px; margin-top: 32px; border-radius: 2px;
      background: linear-gradient(90deg, #4285f4, #34a853);"></div>
    <div style="margin-top: 40px; font-size: 14px; color: rgba(255,255,255,0.5);">
      Correct answers are highlighted in green
    </div>
  `;
  return page;
}

function buildQuizSectionPage(
  sectionIndex: number,
  sectionTitle: string,
  questions: QuizQuestion[],
): HTMLElement {
  const page = document.createElement('div');
  page.style.cssText = `
    position: absolute; left: 0; top: 0;
    width: 794px; min-height: 1123px;
    box-sizing: border-box; padding: 40px 50px;
    font-family: system-ui, -apple-system, sans-serif;
    background: #0f0f23; z-index: 40; pointer-events: none;
  `;

  // Section header
  let html = `
    <div style="margin-bottom: 24px;">
      <div style="font-size: 12px; font-weight: 600; letter-spacing: 3px; text-transform: uppercase;
        color: #34a853; margin-bottom: 8px;">Chapter ${sectionIndex + 1}</div>
      <div style="font-size: 26px; font-weight: 700; color: #ffffff; margin-bottom: 12px;">
        ${escapeHtml(sectionTitle)}
      </div>
      <div style="width: 100%; height: 2px; background: linear-gradient(90deg, #4285f4, transparent);"></div>
    </div>
  `;

  // Questions
  const optionLabels = ['A', 'B', 'C', 'D'];
  for (let q = 0; q < questions.length; q++) {
    const question = questions[q];
    const optionsHtml = question.options.map((opt, optIdx) => {
      const isCorrect = optIdx === question.correctAnswerIndex;
      const bgColor = isCorrect ? '#d1fae5' : '#1e1e3a';
      const borderColor = isCorrect ? '#059669' : '#2a2a4a';
      const textColor = isCorrect ? '#064e3b' : '#e0e0f0';
      const checkmark = isCorrect ? '<span style="margin-right: 6px; color: #059669;">&#10003;</span>' : '';
      const fontWeight = isCorrect ? '600' : '400';

      return `
        <div style="padding: 10px 14px; margin-bottom: 6px; border-radius: 8px;
          background: ${bgColor}; border: 2px solid ${borderColor};
          color: ${textColor}; font-weight: ${fontWeight}; font-size: 15px; line-height: 1.5;">
          ${checkmark}<strong>${optionLabels[optIdx]}.</strong> ${escapeHtml(opt)}
        </div>
      `;
    }).join('');

    html += `
      <div style="margin-bottom: 20px;">
        <div style="font-size: 16px; font-weight: 700; color: #ffffff; margin-bottom: 10px; line-height: 1.5;">
          <span style="color: #4285f4; margin-right: 8px;">Q${q + 1}.</span> ${escapeHtml(question.question)}
        </div>
        ${optionsHtml}
      </div>
    `;
  }

  page.innerHTML = html;
  return page;
}

async function generateQuizzesPdf(sections: Section[], topic: string): Promise<Blob> {
  const pages: HTMLElement[] = [buildQuizTitlePage(topic)];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const quiz = getSectionQuiz(section);
    if (!quiz) continue;
    pages.push(buildQuizSectionPage(i, section.title, quiz));
  }

  if (pages.length <= 1) throw new Error('No quizzes available to export.');

  return renderPagesToPdf(pages, 794, 1123, 'portrait');
}

// ============================================================================
// Simulation HTML Generation (unchanged)
// ============================================================================

function generateSimulationHtml(section: Section, sectionIndex: number): string {
  const code = getSectionSimCode(section)!;
  const params = getSectionSimParams(section);
  const title = section.title;

  const controlsHtml = params.map(p => {
    if (p.controlType === 'toggle') {
      const isOn = !!p.defaultValue;
      return `
        <div class="control-card toggle-card">
          <div class="toggle-row">
            <div class="toggle-icon-label">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${isOn ? '#ff8a5b' : '#a0a0c0'}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" id="toggle-icon-${p.name}"><rect x="1" y="5" width="15" height="14" rx="2"/><path d="M16 3l5 5-5 5"/></svg>
              <label class="control-label">${escapeHtml(p.label)}</label>
            </div>
            <button type="button" class="toggle-btn ${isOn ? 'on' : ''}" id="toggle-btn-${p.name}"
              onclick="(function(n,btn){
                var on = !btn.classList.contains('on');
                btn.classList.toggle('on', on);
                document.getElementById('toggle-icon-'+n).style.stroke = on ? '#ff8a5b' : '#a0a0c0';
                updateParam(n, on ? 1 : 0);
              })('${p.name}', this)">
              <span class="toggle-knob"></span>
            </button>
          </div>
        </div>
      `;
    }
    if (p.controlType === 'button') {
      return `
        <button class="action-btn" onclick="updateParam('${p.name}', (parseFloat(this.dataset.count) || 0) + 1); this.dataset.count = (parseFloat(this.dataset.count) || 0) + 1;" data-count="${p.defaultValue}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 15l-2 5L9 9l11 4-5 2z"/><path d="M14.828 14.828L21 21"/></svg>
          ${escapeHtml(p.label)}
        </button>
      `;
    }
    // Default: slider
    const min = p.min ?? 0;
    const max = p.max ?? 100;
    const fillPct = ((p.defaultValue - min) / (max - min)) * 100;
    return `
      <div class="control-card slider-card">
        <div class="slider-header">
          <label class="control-label">${escapeHtml(p.label)}</label>
          <span class="slider-value" id="val-${p.name}">${p.defaultValue}</span>
        </div>
        <input type="range" class="styled-range" min="${min}" max="${max}" step="${p.step ?? 1}"
          value="${p.defaultValue}" id="slider-${p.name}"
          style="background: linear-gradient(to right, #4285f4 0%, #34a853 ${fillPct}%, #1a1a3e ${fillPct}%, #1a1a3e 100%)"
          oninput="(function(el,n,mn,mx){
            var v = parseFloat(el.value);
            var pct = ((v - mn) / (mx - mn)) * 100;
            el.style.background = 'linear-gradient(to right, #4285f4 0%, #34a853 '+pct+'%, #1a1a3e '+pct+'%, #1a1a3e 100%)';
            document.getElementById('val-'+n).textContent = v % 1 === 0 ? v : v.toFixed(1);
            updateParam(n, v);
          })(this,'${p.name}',${min},${max})">
      </div>
    `;
  }).join('\n');

  const defaultParamsObj: Record<string, number> = {};
  params.forEach(p => { defaultParamsObj[p.name] = p.defaultValue; });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Interactive Simulation</title>
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@19",
      "react/jsx-runtime": "https://esm.sh/react@19/jsx-runtime",
      "react-dom/client": "https://esm.sh/react-dom@19/client",
      "three": "https://esm.sh/three@0.172.0",
      "@react-three/fiber": "https://esm.sh/@react-three/fiber@9?external=react,react-dom,three",
      "@react-three/drei": "https://esm.sh/@react-three/drei@10?external=react,react-dom,three,@react-three/fiber"
    }
  }
  </script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a1f; color: #e0e0f0; font-family: system-ui, -apple-system, sans-serif; overflow: hidden; }
    #root { width: 100vw; height: 100vh; display: flex; }
    #canvas-container { flex: 1; position: relative; }

    /* ── Controls Panel ── */
    #controls-panel {
      width: 310px; background: #0d0d2b; border-left: 2px solid rgba(255,255,255,0.06);
      padding: 24px 20px; overflow-y: auto; flex-shrink: 0;
    }
    #controls-panel::-webkit-scrollbar { width: 6px; }
    #controls-panel::-webkit-scrollbar-track { background: transparent; }
    #controls-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
    .panel-header {
      display: flex; align-items: center; gap: 10px; margin-bottom: 20px;
      color: #ff8a5b;
    }
    .panel-header svg { flex-shrink: 0; }
    .panel-header h2 {
      font-size: 13px; font-weight: 900; letter-spacing: 1.5px; text-transform: uppercase;
      margin: 0; line-height: 1.2;
    }

    /* ── Control Cards ── */
    .control-card {
      border: 2px solid rgba(255,255,255,0.08); border-radius: 14px;
      padding: 16px; margin-bottom: 14px;
      background: rgba(18, 18, 45, 0.5);
      transition: border-color 0.2s;
    }
    .control-card:hover { border-color: rgba(255,255,255,0.15); }
    .control-label {
      font-size: 13px; font-weight: 700; color: #e0e0f0; margin: 0;
    }

    /* ── Slider ── */
    .slider-header {
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;
    }
    .slider-value {
      font-size: 13px; font-weight: 700; font-family: 'SF Mono', 'Fira Code', monospace;
      color: white; padding: 3px 12px; border-radius: 8px;
      background: linear-gradient(135deg, #4285f4, #34a853);
      min-width: 40px; text-align: center;
    }
    .styled-range {
      -webkit-appearance: none; appearance: none;
      width: 100%; height: 10px; border-radius: 6px; outline: none;
      cursor: pointer; border: none;
    }
    .styled-range::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 22px; height: 22px; border-radius: 50%;
      background: white; border: 3px solid #4285f4;
      box-shadow: 0 2px 8px rgba(66, 133, 244, 0.4);
      cursor: pointer; margin-top: -1px;
      transition: box-shadow 0.2s, transform 0.15s;
    }
    .styled-range::-webkit-slider-thumb:hover {
      box-shadow: 0 2px 14px rgba(66, 133, 244, 0.6);
      transform: scale(1.1);
    }
    .styled-range::-moz-range-thumb {
      width: 22px; height: 22px; border-radius: 50%;
      background: white; border: 3px solid #4285f4;
      box-shadow: 0 2px 8px rgba(66, 133, 244, 0.4);
      cursor: pointer;
    }
    .styled-range::-moz-range-track {
      height: 10px; border-radius: 6px; background: transparent;
    }

    /* ── Toggle ── */
    .toggle-card { padding: 14px 16px; }
    .toggle-row {
      display: flex; align-items: center; justify-content: space-between;
    }
    .toggle-icon-label {
      display: flex; align-items: center; gap: 10px;
    }
    .toggle-btn {
      position: relative; width: 52px; height: 28px; border-radius: 28px;
      background: #1a1a3e; border: 2px solid rgba(255,255,255,0.1);
      cursor: pointer; transition: background 0.3s, border-color 0.3s;
      padding: 0; flex-shrink: 0;
    }
    .toggle-btn.on {
      background: linear-gradient(135deg, #4285f4, #34a853);
      border-color: rgba(255,255,255,0.2);
      box-shadow: 0 2px 12px rgba(66, 133, 244, 0.3);
    }
    .toggle-knob {
      position: absolute; top: 3px; left: 3px;
      width: 20px; height: 20px; border-radius: 50%;
      background: white; box-shadow: 0 1px 4px rgba(0,0,0,0.3);
      transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      pointer-events: none;
    }
    .toggle-btn.on .toggle-knob { transform: translateX(24px); }

    /* ── Button ── */
    .action-btn {
      width: 100%; padding: 12px 16px; border: none; border-radius: 12px; cursor: pointer;
      font-size: 14px; font-weight: 700; color: white; letter-spacing: 0.5px;
      background: linear-gradient(135deg, #8b5cf6, #a78bfa); transition: all 0.2s;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      margin-bottom: 14px;
    }
    .action-btn:hover { transform: scale(1.03); filter: brightness(1.1); }
    .action-btn:active { transform: scale(0.97); }

    /* ── Header & Footer ── */
    .header-bar {
      position: absolute; top: 0; left: 0; right: 0; padding: 16px 20px;
      background: linear-gradient(to bottom, rgba(0,0,0,0.5), transparent);
      z-index: 10; display: flex; align-items: center; gap: 12px;
    }
    .header-bar .badge {
      padding: 6px 14px; border-radius: 10px; font-size: 11px; font-weight: 700;
      letter-spacing: 1.5px; text-transform: uppercase; color: white;
      background: linear-gradient(135deg, #4285f4, #34a853); border: 2px solid rgba(255,255,255,0.2);
    }
    .header-bar .title { font-size: 16px; font-weight: 600; color: white; }
    .footer-info {
      position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%);
      font-size: 11px; color: rgba(255,255,255,0.4); z-index: 10;
    }
  </style>
</head>
<body>
  <div id="root">
    <div id="canvas-container">
      <div class="header-bar">
        <span class="badge">LIVE 3D SIMULATION</span>
        <span class="title">${escapeHtml(title)}</span>
      </div>
      <div class="footer-info">Generated by Thinky3D &middot; Drag to rotate &middot; Scroll to zoom</div>
    </div>
    <div id="controls-panel">
      <div class="panel-header">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
        <h2>Simulation<br>Controls</h2>
      </div>
      ${controlsHtml || '<p style="color:#a0a0c0; font-size:13px;">No adjustable parameters.</p>'}
    </div>
  </div>

  <script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import * as THREE from 'three';
    import { Canvas, useFrame, useThree } from '@react-three/fiber';
    import { OrbitControls, PerspectiveCamera, Environment, Text } from '@react-three/drei';

    function lcFirst(s) { return s.charAt(0).toLowerCase() + s.slice(1); }
    function extractMaterialProps(mat) {
      const props = {};
      if (mat.color && typeof mat.color.getHexString === 'function') props.color = '#' + mat.color.getHexString();
      if (mat.wireframe !== undefined) props.wireframe = mat.wireframe;
      if (mat.transparent !== undefined) props.transparent = mat.transparent;
      if (mat.opacity !== undefined && mat.opacity !== 1) props.opacity = mat.opacity;
      if (mat.side !== undefined && mat.side !== THREE.FrontSide) props.side = mat.side;
      if (mat.emissive && typeof mat.emissive.getHexString === 'function') {
        const hex = mat.emissive.getHexString();
        if (hex !== '000000') props.emissive = '#' + hex;
      }
      if (mat.metalness !== undefined && mat.metalness !== 0) props.metalness = mat.metalness;
      if (mat.roughness !== undefined && mat.roughness !== 1) props.roughness = mat.roughness;
      if (mat.size !== undefined) props.size = mat.size;
      return props;
    }

    const origCE = React.createElement;
    function safeCE(type, props, ...children) {
      const fixed = children.map(c => {
        if (c && typeof c === 'object') {
          if (c.isBufferGeometry && c.type && c.type !== 'BufferGeometry') {
            const el = lcFirst(c.type);
            const args = c.parameters ? Object.values(c.parameters) : [];
            return origCE(el, args.length ? { args } : undefined);
          }
          if (c.isMaterial && c.type) {
            return origCE(lcFirst(c.type), extractMaterialProps(c));
          }
        }
        return c;
      });
      let fp = props;
      const pc = [];
      if (typeof type === 'string' && type === 'mesh' && props) {
        fp = { ...props };
        if (fp.geometry && fp.geometry.isBufferGeometry && fp.geometry.type && fp.geometry.type !== 'BufferGeometry') {
          const g = fp.geometry; pc.push(origCE(lcFirst(g.type), g.parameters ? { args: Object.values(g.parameters) } : undefined));
          delete fp.geometry;
        }
        if (fp.material && fp.material.isMaterial) {
          pc.push(origCE(lcFirst(fp.material.type), extractMaterialProps(fp.material)));
          delete fp.material;
        }
      }
      return origCE(type, fp, ...pc, ...fixed);
    }
    const SafeReact = new Proxy(React, { get(t, p) { return p === 'createElement' ? safeCE : t[p]; } });

    let currentParams = ${JSON.stringify(defaultParamsObj)};
    let rerender = null;

    window.updateParam = function(name, value) {
      currentParams = { ...currentParams, [name]: value };
      if (rerender) rerender({ ...currentParams });
    };

    function GeneratedScene({ params }) {
      const three = useThree();
      try {
        const func = new Function('args', \`
          const { React, THREE, useFrame, useThree, Text, params } = args;
          ${code.replace(/`/g, '\\`').replace(/\$/g, '\\$')}
        \`);
        return func({ React: SafeReact, THREE, useFrame, useThree: () => three, Text, params });
      } catch (e) {
        console.error('Simulation error:', e);
        return safeCE('group', null,
          safeCE('mesh', null, safeCE('boxGeometry', null), safeCE('meshBasicMaterial', { color: 'red', wireframe: true }))
        );
      }
    }

    function App() {
      const [params, setParams] = React.useState(currentParams);
      rerender = setParams;
      return safeCE(Canvas, { shadows: true, style: { width: '100%', height: '100%' } },
        safeCE(PerspectiveCamera, { makeDefault: true, position: [8, 6, 8], fov: 50 }),
        safeCE(OrbitControls, { makeDefault: true }),
        safeCE('ambientLight', { intensity: 0.5 }),
        safeCE('directionalLight', { position: [10, 15, 10], intensity: 1.0, castShadow: true }),
        safeCE('directionalLight', { position: [-5, 5, -5], intensity: 0.3 }),
        safeCE(Environment, { preset: 'night' }),
        safeCE(GeneratedScene, { params })
      );
    }

    const canvasContainer = document.getElementById('canvas-container');
    const root = createRoot(canvasContainer);
    root.render(safeCE(App, null));
  </script>
</body>
</html>`;
}

// ============================================================================
// Main Orchestrator
// ============================================================================

export async function downloadAllContent(
  course: Course,
  courseLevel: LearningLevel,
  onProgress: (step: string, percent: number) => void
): Promise<void> {
  const sections = course.sections.filter(s => s.content || s.partialContent);

  if (sections.length === 0) {
    throw new Error('No content has been generated yet. Generate at least one section first.');
  }

  const hasSlides = sections.some(s => getSectionSlides(s) !== null);
  const hasQuizzes = sections.some(s => getSectionQuiz(s) !== null);
  const simsAvailable = sections
    .map((s, i) => ({ section: s, index: i }))
    .filter(({ section }) => getSectionSimCode(section) !== null);

  const zip = new JSZip();

  if (hasSlides) {
    onProgress('Generating slides PDF...', 10);
    try {
      const slidesBlob = await generateSlidesPdf(sections);
      zip.file('Slides.pdf', slidesBlob);
    } catch (e) {
      console.warn('Slides PDF generation failed:', e);
    }
  }

  if (hasQuizzes) {
    onProgress('Generating quizzes PDF...', 40);
    try {
      const quizzesBlob = await generateQuizzesPdf(sections, course.topic);
      zip.file('Quizzes.pdf', quizzesBlob);
    } catch (e) {
      console.warn('Quizzes PDF generation failed:', e);
    }
  }

  if (simsAvailable.length > 0) {
    onProgress('Packaging simulations...', 60);
    for (const { section, index } of simsAvailable) {
      const fileName = `${String(index + 1).padStart(2, '0')}_${sanitizeFilename(section.title)}_Simulation.html`;
      const html = generateSimulationHtml(section, index);
      zip.file(`Simulations/${fileName}`, html);
    }
  }

  if (Object.keys(zip.files).length === 0) {
    throw new Error('No exportable content found.');
  }

  onProgress('Creating zip archive...', 80);
  const zipBlob = await zip.generateAsync({ type: 'blob' });

  onProgress('Downloading...', 95);
  const zipName = `${sanitizeFilename(course.topic)}.zip`;
  saveAs(zipBlob, zipName);

  onProgress('Done!', 100);
}
