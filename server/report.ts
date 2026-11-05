import type { CaptureResult } from './capture.ts';

const htmlCharacters: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => htmlCharacters[character] ?? character);
}

function percentage(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (value / total) * 100));
}

const reportStyles = `
  :root {
    color-scheme: light dark;
    --canvas: #f5f6fb;
    --surface: #ffffff;
    --soft: #f3f4f9;
    --line: #dbdfea;
    --ink: #171b2d;
    --muted: #505b73;
    --accent: #4831a7;
    --accent-soft: #f0ebff;
    --warn: #713b08;
    --warn-soft: #fff4df;
    font-family: system-ui, sans-serif;
    color: var(--ink);
    background: var(--canvas);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --canvas: #11121b;
      --surface: #191b27;
      --soft: #222533;
      --line: #343849;
      --ink: #f5f4ff;
      --muted: #b2bad1;
      --accent: #c9b9ff;
      --accent-soft: #30254e;
      --warn: #ffce86;
      --warn-soft: #392a19;
    }
  }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; line-height: 1.5; }
  h1, h2, h3, p, dl, dd, figure { margin: 0; }
  a { color: var(--accent); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .wrap { width: min(100% - 2rem, 100rem); margin-inline: auto; }
  .brandbar { background: var(--surface); border-bottom: 1px solid var(--line); }
  .brandline { display: flex; align-items: center; flex-wrap: wrap; gap: .75rem; padding-block: .875rem; }
  .brand { display: flex; align-items: center; gap: .625rem; font-weight: 800; letter-spacing: -.025em; }
  .logo { width: 2rem; height: 2rem; padding: .375rem; color: #fff; background: #533abd; border-radius: .5rem; }
  .badge { color: var(--accent); background: var(--accent-soft); border-radius: 999px; padding: .15rem .6rem; font-size: .75rem; font-weight: 700; }
  .intro { display: grid; gap: 1.125rem; padding-block: clamp(1.5rem, 4vw, 3rem); }
  .eyebrow { color: var(--accent); font-size: .75rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
  h1 { margin-block: .25rem; font-size: clamp(1.625rem, 5vw, 2.625rem); line-height: 1.1; letter-spacing: -.04em; overflow-wrap: anywhere; }
  .page-index { padding: 1rem; margin-bottom: 1rem; }
  .page-index h2 { font-size: 1rem; }
  .page-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr)); gap: .5rem; margin: .75rem 0 0; padding: 0; list-style: none; }
  .page-list a { display: flex; align-items: center; gap: .65rem; min-height: 2.75rem; padding: .45rem .6rem; border: 1px solid var(--line); border-radius: .5rem; color: var(--ink); text-decoration: none; overflow-wrap: anywhere; }
  .page-list a:is(:hover, :focus-visible) { background: var(--accent-soft); }
  .review-page { scroll-margin-top: 1rem; }
  .review-page + .review-page { border-top: 1px solid var(--line); }
  .review-page h2 { margin-block: .25rem; font-size: clamp(1.375rem, 4vw, 2rem); line-height: 1.15; letter-spacing: -.025em; overflow-wrap: anywhere; }
  .source { color: var(--muted); overflow-wrap: anywhere; font-size: .875rem; }
  .facts { display: flex; gap: .65rem; flex-wrap: wrap; }
  .facts > div { padding: .55rem .8rem; background: var(--surface); border: 1px solid var(--line); border-radius: .625rem; }
  dt { color: var(--muted); font-size: .75rem; }
  dd { font-size: .875rem; font-weight: 700; }
  .scroll-area-jump { display: inline-flex; align-items: center; justify-self: start; min-height: 2.75rem; font-size: .875rem; font-weight: 700; text-underline-offset: .2em; }
  .warnings { padding: .75rem 1rem; border-radius: .625rem; color: var(--warn); background: var(--warn-soft); }
  .warnings p { font-weight: 700; }
  .warnings ul { margin: .2rem 0 0; padding-inline-start: 1.25rem; overflow-wrap: anywhere; }
  .workspace { display: grid; align-items: start; gap: 1rem; padding-bottom: 2rem; }
  .viewport-sequence { display: grid; gap: 1rem; margin: 0; padding: 0; list-style: none; }
  .viewport-sequence > li { min-width: 0; }
  .viewport-sequence .workspace { padding-bottom: 1rem; }
  .viewport-sequence .frame { width: min(100%, var(--frame-width)); margin-inline: auto; }
  .step-position { width: 100%; font-variant-numeric: tabular-nums; }
  .card { min-width: 0; border: 1px solid var(--line); border-radius: .75rem; background: var(--surface); }
  .card-head { padding: .875rem 1rem; border-bottom: 1px solid var(--line); }
  .card-head :is(h2, h3) { font-size: 1rem; }
  .card-head p, .empty { color: var(--muted); font-size: .875rem; }
  .structure-heading { scroll-margin-top: 1rem; }
  .map { max-height: min(55vh, 32rem); overflow: auto; padding: .5rem; margin: 0; list-style: none; }
  .map a { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: .65rem; padding: .4rem .5rem; margin-inline-start: var(--indent); min-height: 2.75rem; text-decoration: none; color: var(--ink); border-radius: .375rem; }
  .map a:is(:hover, :focus-visible) { background: var(--accent-soft); }
  .map a:focus-visible { outline-offset: -2px; }
  .index { color: var(--accent); background: var(--accent-soft); font-variant-numeric: tabular-nums; border-radius: .375rem; text-align: center; font-size: .75rem; padding: .2rem; min-width: 1.7rem; }
  .label { display: block; overflow-wrap: anywhere; font-size: .875rem; font-weight: 650; line-height: 1.3; }
  .tag { color: var(--muted); font-size: .72rem; overflow-wrap: anywhere; }
  .empty { padding: 1rem; }
  .capture-bar { display: flex; justify-content: space-between; flex-wrap: wrap; align-items: center; gap: .25rem 1rem; position: sticky; z-index: 2; top: 0; background: var(--surface); border-radius: .75rem .75rem 0 0; padding-block: .3rem; }
  .capture-bar a { display: inline-flex; align-items: center; min-height: 2.75rem; font-size: .875rem; font-weight: 700; text-underline-offset: .2em; }
  .capture-links { display: flex; flex-wrap: wrap; gap: 0 .75rem; }
  .frame { position: relative; overflow: clip; background: var(--soft); border-radius: 0 0 .7rem .7rem; }
  .frame img { display: block; width: 100%; height: auto; }
  .marker { position: absolute; inset: var(--top) auto auto var(--left); width: var(--width); height: var(--height); scroll-margin-top: 4.75rem; pointer-events: none; visibility: hidden; }
  .marker:target { visibility: visible; z-index: 1; background: #7454d61c; outline: 2px solid #6844d0; box-shadow: inset 0 0 0 2px #fff; }
  .marker:target::before { content: attr(data-index); position: absolute; inset: .25rem auto auto .25rem; min-width: 1.5rem; padding: .125rem .25rem; background: #4831a7; color: #fff; border: 1px solid #fff; border-radius: .25rem; text-align: center; font-size: .75rem; font-weight: 750; }
  .scroll-areas { display: grid; gap: .75rem; padding-bottom: 2rem; scroll-margin-top: 1rem; }
  .scroll-areas :is(h2, h3) { font-size: 1.25rem; }
  .scroll-areas header p { color: var(--muted); font-size: .875rem; }
  :is(.scroll-area, .viewport-reference) summary { min-height: 2.75rem; padding: .7rem 1rem; border-radius: .75rem; cursor: pointer; overflow-wrap: anywhere; }
  :is(.scroll-area, .viewport-reference) summary:hover { background: var(--soft); }
  :is(.scroll-area, .viewport-reference)[open] summary { border-bottom: 1px solid var(--line); border-radius: .75rem .75rem 0 0; }
  .scroll-area-title { font-weight: 700; }
  .scroll-area-meta { margin-inline-start: .5rem; color: var(--muted); font-size: .8rem; }
  .partial { display: inline-block; margin-inline-start: .5rem; padding: .1rem .45rem; border-radius: 999px; background: var(--warn-soft); color: var(--warn); font-size: .75rem; font-weight: 700; }
  .scroll-area-note { margin: .5rem; overflow-wrap: anywhere; font-size: .875rem; }
  .scroll-area-note p { font-weight: 400; }
  .scroll-area-view { max-height: min(60vh, 32rem); overflow: auto; overscroll-behavior-x: contain; background: var(--soft); border-radius: 0 0 .75rem .75rem; }
  .scroll-area-view:focus-visible { outline-offset: -3px; }
  .scroll-area-view img { display: block; }
  .viewport-reference { margin-bottom: 1rem; }
  .viewport-reference figure { padding: .75rem 1rem 1rem; }
  .viewport-reference figcaption { margin-bottom: .75rem; color: var(--muted); font-size: .875rem; }
  .viewport-reference img { display: block; max-width: 100%; height: auto; margin-inline: auto; border-radius: .5rem; }
  @media (min-width: 64rem) {
    .workspace { grid-template-columns: minmax(15rem, 20rem) minmax(0, 1fr); }
    .map-card { position: sticky; top: 1rem; }
    .map { max-height: calc(100vh - 8rem); }
  }
  @media print {
    .map, .workspace, .map-card, .capture-bar { max-height: none; overflow: visible; position: static; }
    .workspace { display: block; }
    .capture-bar a, .marker { display: none; }
    .map-card { margin-bottom: 1rem; }
  }
`;

function renderPage(review: CaptureResult, pageNumber?: number): string {
  const title = escapeHtml(review.title || 'Page review');
  const source = escapeHtml(review.url);
  const pageId = pageNumber ? `page-${pageNumber}` : undefined;
  const viewportShots = review.viewportShots ?? [];
  const viewportReference = viewportShots.length ? undefined : review.viewportScreenshot;
  const mappedElements = viewportShots.length
    ? viewportShots.reduce((total, shot) => total + shot.sections.length, 0)
    : review.sections.length;
  const id = (part: string) => pageId ? `${pageId}-${part}` : part;
  const heading = pageNumber ? 'h2' : 'h1';
  const sectionHeading = pageNumber ? 'h3' : 'h2';
  const capturedAt = new Date(review.capturedAt);
  const captureTime = new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(capturedAt);
  function renderWorkspace(shot?: NonNullable<CaptureResult['viewportShots']>[number], step?: number): string {
    const { width, height } = shot ?? review.page;
    const sections = shot?.sections ?? review.sections;
    const screenshot = shot?.screenshot ?? review.screenshot;
    const captureId = (part: string) => id(shot ? `step-${step}-${part}` : part);
    const caption = shot ? `Step ${step}` : 'Full-page screenshot';
    const mapItems = sections.map((section, index) => {
      const indent = Math.min(4, Math.max(0, Math.trunc(section.depth))) * 0.35;
      return `<li><a href="#${captureId(`region-${index + 1}`)}" style="--indent:${indent}rem">
        <span class="index" aria-hidden="true">${index + 1}</span>
        <span><span class="label">${escapeHtml(section.label)}</span>
        <span class="tag">&lt;${escapeHtml(section.tag)}&gt;</span></span>
      </a></li>`;
    }).join('');
    const markers = sections.map((section, index) => {
      const left = percentage(section.x, width);
      const top = percentage(section.y, height);
      const markerWidth = Math.min(100 - left, percentage(section.width, width));
      const markerHeight = Math.min(100 - top, percentage(section.height, height));
      return `<div id="${captureId(`region-${index + 1}`)}" class="marker" role="group" tabindex="-1"
        aria-label="${escapeHtml(section.label)} in the screenshot" data-index="${index + 1}"
        style="--left:${left}%;--top:${top}%;--width:${markerWidth}%;--height:${markerHeight}%"></div>`;
    }).join('');
    return `<div class="workspace">
      <nav class="card map-card" aria-labelledby="${captureId('structure')}">
        <div class="card-head">
          <${sectionHeading} class="structure-heading" id="${captureId('structure')}" tabindex="-1">${shot ? `Step ${step} structure` : 'Structure map'}</${sectionHeading}>
          ${mapItems ? '<p>Select an element to highlight it in the screenshot.</p>' : ''}
        </div>
        ${mapItems ? `<ol class="map" role="list">${mapItems}</ol>` : '<p class="empty">No visible headings or landmarks were found.</p>'}
      </nav>
      <figure class="card" aria-labelledby="${captureId('screenshot-heading')}">
        <figcaption class="card-head capture-bar">
          <${sectionHeading} id="${captureId('screenshot-heading')}">${caption}</${sectionHeading}>
          <div class="capture-links">
            <a href="#${captureId('structure')}">Structure map ↑</a>
            ${pageId ? '<a href="#page-index">Page index ↑</a>' : ''}
          </div>
          ${shot ? `<p class="step-position">${escapeHtml(shot.label)} · Scroll position ${shot.scrollX}, ${shot.scrollY} px</p>` : ''}
        </figcaption>
        <div class="frame" style="--frame-width:${width}px">
          <img src="${escapeHtml(screenshot)}" width="${width}" height="${height}"${shot || (pageNumber && pageNumber > 1) ? ' loading="lazy" decoding="async"' : ''} alt="${shot ? `Viewport step ${step}` : 'Full-page screenshot'} of ${title}">
          ${markers}
        </div>
      </figure>
    </div>`;
  }
  const warnings = review.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');
  const scrollAreas = review.scrollRegions.map((region) => {
    const label = escapeHtml(region.label);
    const dimensions = `Captured ${region.width} × ${region.height} px.${region.contentWidth && region.contentHeight
      ? ` Full content ${region.contentWidth} × ${region.contentHeight} px.` : ''}`;
    return `<details class="card scroll-area">
      <summary><span class="scroll-area-title">${label}</span>
        <span class="scroll-area-meta">&lt;${escapeHtml(region.tag)}&gt; · ${region.width} × ${region.height} px</span>
        ${region.complete ? '' : '<span class="partial">Partial capture</span>'}
      </summary>
      ${region.complete ? '' : `<aside class="warnings scroll-area-note" aria-label="Partial capture of ${label}">
        <p><strong>${label}.</strong> ${escapeHtml(region.partialReason || 'The capture ended before this area finished.')}</p>
        <p>${escapeHtml(dimensions)}</p>
      </aside>`}
      <div class="scroll-area-view" role="region" tabindex="0" aria-label="Scrollable preview of ${label}">
        <img src="${escapeHtml(region.screenshot)}" width="${region.width}" height="${region.height}" loading="lazy" decoding="async" alt="Screenshot of ${label}">
      </div>
    </details>`;
  }).join('');

  return `${pageId ? `<article class="review-page" id="${pageId}" tabindex="-1" aria-labelledby="${id('title')}">` : ''}
    <header class="intro">
      <div>
        <p class="eyebrow">${pageNumber ? `Page ${pageNumber}` : 'Design and structure'}</p>
        <${heading} id="${id('title')}">${title}</${heading}>
        <p class="source">${source}</p>
        ${viewportShots.length ? '<p class="source">Each step shows the browser viewport at a different scroll position, including fixed navigation.</p>' : ''}
      </div>
      <dl class="facts">
        <div><dt>Viewport</dt><dd>${review.viewport.width} × ${review.viewport.height} px</dd></div>
        ${viewportShots.length ? `<div><dt>Viewport steps</dt><dd>${viewportShots.length}</dd></div>` : `<div><dt>Screenshot</dt><dd>${review.page.width} × ${review.page.height} px</dd></div>`}
        <div><dt>Mapped elements</dt><dd>${mappedElements}</dd></div>
        <div><dt>Captured</dt><dd><time datetime="${escapeHtml(review.capturedAt)}">${escapeHtml(captureTime)}</time></dd></div>
      </dl>
      ${review.exploration ? `<p class="source">Navigation exploration found ${review.exploration.linksFound} links and ${review.exploration.controlsFound} controls. Clicked ${review.exploration.controlsClicked} controls and captured ${review.exploration.viewsCaptured} views.</p>
      ${review.exploration.skipped.length ? `<details class="card scroll-area">
        <summary>Skipped navigation controls (${review.exploration.skipped.length})</summary>
        <ul class="source">${review.exploration.skipped.map(item => `<li><strong>${escapeHtml(item.label)}</strong> ${escapeHtml(item.reason)}</li>`).join('')}</ul>
      </details>` : ''}` : ''}
      ${scrollAreas ? `<a class="scroll-area-jump" href="#${id('scroll-areas')}">View independently scrolling areas ↓</a>` : ''}
      ${warnings ? `<aside class="warnings" aria-label="Capture notes"><p>Capture notes</p><ul>${warnings}</ul></aside>` : ''}
    </header>
    ${viewportReference ? `<details class="card viewport-reference">
      <summary><span class="scroll-area-title">Original viewport</span><span class="scroll-area-meta">${viewportReference.width} × ${viewportReference.height} px</span></summary>
      <figure>
        <figcaption>See the pinned bottom navigation in its original position in the browser viewport.</figcaption>
        <img src="${escapeHtml(viewportReference.screenshot)}" width="${viewportReference.width}" height="${viewportReference.height}" loading="lazy" decoding="async" alt="Original browser viewport for ${title}">
      </figure>
    </details>` : ''}
    ${viewportShots.length ? `<ol class="viewport-sequence" role="list" aria-label="Viewport screenshot sequence">${viewportShots.map((shot, index) => `<li>${renderWorkspace(shot, index + 1)}</li>`).join('')}</ol>` : renderWorkspace()}
    ${scrollAreas ? `<section class="scroll-areas" id="${id('scroll-areas')}" aria-labelledby="${id('scroll-areas-heading')}" tabindex="-1">
      <header>
        <${sectionHeading} id="${id('scroll-areas-heading')}">Independently scrolling areas</${sectionHeading}>
        <p>Open an area to review its captured content.</p>
      </header>
      ${scrollAreas}
    </section>` : ''}
    ${pageId ? '</article>' : ''}`;
}

export function renderReport(review: CaptureResult): string {
  const title = escapeHtml(review.title || 'Page review');
  const pages = [review, ...(review.linkedPages ?? [])];
  const multiPage = pages.length > 1;
  const pageIndex = multiPage ? `<header class="intro">
      <div>
        <p class="eyebrow">Linked pages review · ${pages.length} pages</p>
        <h1>${title}</h1>
      </div>
    </header>
    <nav class="card page-index" id="page-index" tabindex="-1" aria-labelledby="page-index-heading">
      <h2 id="page-index-heading">Captured pages</h2>
      <ol class="page-list" role="list">${pages.map((page, index) => `<li><a href="#page-${index + 1}">
        <span class="index" aria-hidden="true">${index + 1}</span>
        <span>${escapeHtml(page.navigationLabel || page.title || `Page ${index + 1}`)}</span>
      </a></li>`).join('')}</ol>
    </nav>` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | PageAtlas</title>
  <style>${reportStyles}</style>
</head>
<body>
  <header class="brandbar">
    <div class="wrap brandline">
      <span class="brand"><svg class="logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 8h18M9 8v13m4-9h4m-4 4h4"/></svg>PageAtlas</span>
      <span class="badge">Review export</span>
    </div>
  </header>
  <main class="wrap">
    ${pageIndex}
    ${multiPage ? pages.map((page, index) => renderPage(page, index + 1)).join('') : renderPage(review)}
  </main>
</body>
</html>`;
}
