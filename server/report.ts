import type { CaptureResult } from './capture.ts';

type ViewportShot = NonNullable<CaptureResult['viewportShots']>[number];

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

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function routeOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
  } catch {
    return url;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'UTC', timeZoneName: 'short',
  }).format(date);
}

function pageName(page: CaptureResult, index: number): string {
  return page.navigationLabel || page.title || `Page ${index + 1}`;
}

function pageStats(page: CaptureResult) {
  const steps = page.viewportShots?.length ?? 0;
  return {
    steps,
    screenshots: (steps || 1) + (page.viewportScreenshot && !steps ? 1 : 0),
    elements: steps ? page.viewportShots!.reduce((total, shot) => total + shot.sections.length, 0) : page.sections.length,
    scrollAreas: page.scrollRegions.length,
    notes: page.warnings.length,
  };
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
  html { scroll-padding-top: 4.5rem; }
  body { margin: 0; line-height: 1.5; }
  h1, h2, h3, p, dl, dd, figure { margin: 0; }
  a { color: var(--accent); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .wrap { width: min(100% - 2rem, 100rem); margin-inline: auto; }
  .brandbar { position: sticky; top: 0; z-index: 5; background: var(--surface); border-bottom: 1px solid var(--line); }
  .brandline { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem .75rem; min-height: 3.5rem; padding-block: .5rem; }
  .brand { display: flex; align-items: center; gap: .625rem; font-weight: 800; letter-spacing: -.025em; }
  .logo { width: 2rem; height: 2rem; padding: .375rem; color: #fff; background: #533abd; border-radius: .5rem; }
  .badge { color: var(--accent); background: var(--accent-soft); border-radius: 999px; padding: .15rem .6rem; font-size: .75rem; font-weight: 700; }
  .brand-title { flex: 1 1 12rem; min-width: 0; color: var(--muted); font-size: .875rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .brand-link { display: inline-flex; align-items: center; min-height: 2.75rem; font-size: .875rem; font-weight: 700; text-underline-offset: .2em; }
  .eyebrow { color: var(--accent); font-size: .75rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
  h1 { margin-block: .25rem; font-size: clamp(1.625rem, 5vw, 2.625rem); line-height: 1.1; letter-spacing: -.04em; overflow-wrap: anywhere; }
  .source { color: var(--muted); overflow-wrap: anywhere; font-size: .875rem; }
  .source code, .route { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .8125rem; }

  .overview { display: grid; gap: 1.25rem; padding-block: clamp(1.5rem, 4vw, 2.5rem) 1.25rem; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr)); gap: .5rem; }
  .summary > div { padding: .75rem .9rem; background: var(--surface); border: 1px solid var(--line); border-radius: .75rem; }
  .summary dt { color: var(--muted); font-size: .75rem; }
  .summary dd { font-size: 1.25rem; font-weight: 800; font-variant-numeric: tabular-nums; letter-spacing: -.02em; overflow-wrap: anywhere; }
  .summary dd.small { font-size: .9rem; font-weight: 700; }
  .guide { padding: .75rem 1rem; color: var(--muted); background: var(--surface); border: 1px dashed var(--line); border-radius: .75rem; font-size: .875rem; }
  .guide strong { color: var(--ink); }

  .page-index { padding: 0; margin-bottom: 1.5rem; scroll-margin-top: 4.5rem; }
  .page-index .card-head { display: flex; justify-content: space-between; flex-wrap: wrap; gap: .25rem 1rem; align-items: baseline; }
  .page-list { margin: 0; padding: .375rem; list-style: none; }
  .page-list a { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .25rem .85rem; min-height: 3.25rem; padding: .55rem .65rem; border-radius: .5rem; color: var(--ink); text-decoration: none; }
  .page-list li + li a { border-top: 1px solid var(--line); border-radius: 0; }
  .page-list a:is(:hover, :focus-visible) { background: var(--accent-soft); border-radius: .5rem; }
  .page-list .name { display: block; font-weight: 700; overflow-wrap: anywhere; }
  .page-list .route { display: block; color: var(--muted); overflow-wrap: anywhere; }
  .page-list .meta { display: flex; flex-wrap: wrap; justify-content: end; gap: .3rem; }
  .chip { display: inline-block; padding: .1rem .5rem; border-radius: 999px; background: var(--soft); color: var(--muted); font-size: .72rem; font-weight: 650; white-space: nowrap; }
  .chip.warn { background: var(--warn-soft); color: var(--warn); }
  @media (max-width: 40rem) {
    .page-list a { grid-template-columns: auto minmax(0, 1fr); }
    .page-list .meta { grid-column: 2; justify-content: start; }
  }

  .review-page { padding-block: 1.75rem 1rem; scroll-margin-top: 3.75rem; }
  .review-page + .review-page { border-top: 3px solid var(--line); }
  .page-head { display: grid; gap: 1rem; padding-bottom: 1.25rem; }
  .page-head h2 { margin-block: .2rem; font-size: clamp(1.375rem, 4vw, 2rem); line-height: 1.15; letter-spacing: -.025em; overflow-wrap: anywhere; }
  .page-head-top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: start; gap: .5rem 1rem; }
  .pager { display: flex; flex-wrap: wrap; gap: .375rem; }
  .pager a, .pager span { display: inline-flex; align-items: center; min-height: 2.5rem; padding: .3rem .8rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--surface); font-size: .8125rem; font-weight: 700; text-decoration: none; }
  .pager span { color: var(--muted); opacity: .55; }
  .pager a:is(:hover, :focus-visible) { background: var(--accent-soft); }
  .facts { display: flex; gap: .5rem; flex-wrap: wrap; }
  .facts > div { padding: .45rem .75rem; background: var(--surface); border: 1px solid var(--line); border-radius: .625rem; }
  .facts dt { color: var(--muted); font-size: .72rem; }
  .facts dd { font-size: .875rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .jump { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .5rem; margin: 0; padding: 0; list-style: none; font-size: .8125rem; }
  .jump-label { color: var(--muted); font-weight: 700; margin-inline-end: .25rem; }
  .jump a { display: inline-flex; align-items: center; min-height: 2.25rem; padding-inline: .6rem; border-radius: 999px; background: var(--accent-soft); font-weight: 700; text-decoration: none; }
  .jump a:is(:hover, :focus-visible) { text-decoration: underline; }

  .section-title { display: flex; align-items: baseline; flex-wrap: wrap; gap: .25rem .75rem; margin-block: .5rem .75rem; scroll-margin-top: 4.5rem; }
  .section-title :is(h2, h3) { font-size: 1.125rem; }
  .section-title p { color: var(--muted); font-size: .8125rem; }
  .warnings { padding: .75rem 1rem; border-radius: .625rem; color: var(--warn); background: var(--warn-soft); }
  .warnings summary { min-height: 2rem; font-weight: 700; cursor: pointer; }
  .warnings ul { margin: .4rem 0 0; padding-inline-start: 1.25rem; overflow-wrap: anywhere; font-size: .875rem; }
  .exploration { padding: .75rem 1rem; }
  .exploration summary { min-height: 2rem; font-weight: 700; cursor: pointer; }
  .exploration p { color: var(--muted); font-size: .875rem; }
  .exploration ul { margin: .5rem 0 0; padding-inline-start: 1.25rem; color: var(--muted); font-size: .8125rem; overflow-wrap: anywhere; }

  .workspace { display: grid; align-items: start; gap: 1rem; padding-bottom: 1.5rem; }
  .viewport-sequence { display: grid; gap: 1.25rem; margin: 0; padding: 0; list-style: none; }
  .viewport-sequence > li { min-width: 0; scroll-margin-top: 4.5rem; }
  .viewport-sequence .workspace { padding-bottom: 0; }
  .viewport-sequence .frame { width: min(100%, var(--frame-width)); margin-inline: auto; }
  .step-position { width: 100%; color: var(--muted); font-size: .8125rem; font-variant-numeric: tabular-nums; }
  .card { min-width: 0; border: 1px solid var(--line); border-radius: .75rem; background: var(--surface); }
  .card-head { padding: .875rem 1rem; border-bottom: 1px solid var(--line); }
  .card-head :is(h2, h3, h4) { font-size: 1rem; }
  .card-head p, .empty { color: var(--muted); font-size: .8125rem; }
  .structure-heading { scroll-margin-top: 4.5rem; }
  .map { max-height: min(55vh, 32rem); overflow: auto; padding: .5rem; margin: 0; list-style: none; }
  .map a { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: .65rem; padding: .4rem .5rem; margin-inline-start: var(--indent); min-height: 2.75rem; text-decoration: none; color: var(--ink); border-radius: .375rem; }
  .map a:is(:hover, :focus-visible) { background: var(--accent-soft); }
  .map a:focus-visible { outline-offset: -2px; }
  .index { color: var(--accent); background: var(--accent-soft); font-variant-numeric: tabular-nums; border-radius: .375rem; text-align: center; font-size: .75rem; font-weight: 700; padding: .2rem; min-width: 1.7rem; }
  .label { display: block; overflow-wrap: anywhere; font-size: .875rem; font-weight: 650; line-height: 1.3; }
  .tag { color: var(--muted); font-size: .72rem; overflow-wrap: anywhere; }
  .empty { padding: 1rem; }
  .capture-bar { display: flex; justify-content: space-between; flex-wrap: wrap; align-items: center; gap: .25rem 1rem; position: sticky; z-index: 2; top: 3.5rem; background: var(--surface); border-radius: .75rem .75rem 0 0; padding-block: .3rem; }
  .capture-bar a { display: inline-flex; align-items: center; min-height: 2.75rem; font-size: .8125rem; font-weight: 700; text-underline-offset: .2em; }
  .capture-links { display: flex; flex-wrap: wrap; gap: 0 .75rem; }
  .frame { position: relative; overflow: clip; background: var(--soft); border-radius: 0 0 .7rem .7rem; }
  .frame img { display: block; width: 100%; height: auto; }
  .marker { position: absolute; inset: var(--top) auto auto var(--left); width: var(--width); height: var(--height); scroll-margin-top: 8rem; pointer-events: none; visibility: hidden; }
  .marker:target { visibility: visible; z-index: 1; background: #7454d61c; outline: 2px solid #6844d0; box-shadow: inset 0 0 0 2px #fff; }
  .marker:target::before { content: attr(data-index); position: absolute; inset: .25rem auto auto .25rem; min-width: 1.5rem; padding: .125rem .25rem; background: #4831a7; color: #fff; border: 1px solid #fff; border-radius: .25rem; text-align: center; font-size: .75rem; font-weight: 750; }

  .scroll-areas { display: grid; gap: .75rem; padding-bottom: 1.5rem; scroll-margin-top: 4.5rem; }
  :is(.scroll-area, .viewport-reference) summary { min-height: 2.75rem; padding: .7rem 1rem; border-radius: .75rem; cursor: pointer; overflow-wrap: anywhere; }
  :is(.scroll-area, .viewport-reference) summary:hover { background: var(--soft); }
  :is(.scroll-area, .viewport-reference)[open] summary { border-bottom: 1px solid var(--line); border-radius: .75rem .75rem 0 0; }
  .scroll-area-title { font-weight: 700; }
  .scroll-area-meta { margin-inline-start: .5rem; color: var(--muted); font-size: .8rem; }
  .partial { display: inline-block; margin-inline-start: .5rem; padding: .1rem .45rem; border-radius: 999px; background: var(--warn-soft); color: var(--warn); font-size: .75rem; font-weight: 700; }
  .scroll-area-note { margin: .5rem; overflow-wrap: anywhere; font-size: .875rem; }
  .scroll-area-view { max-height: min(60vh, 32rem); overflow: auto; overscroll-behavior-x: contain; background: var(--soft); border-radius: 0 0 .75rem .75rem; }
  .scroll-area-view:focus-visible { outline-offset: -3px; }
  .scroll-area-view img { display: block; }
  .viewport-reference { margin-bottom: 1rem; }
  .viewport-reference figure { padding: .75rem 1rem 1rem; }
  .viewport-reference figcaption { margin-bottom: .75rem; color: var(--muted); font-size: .875rem; }
  .viewport-reference img { display: block; max-width: 100%; height: auto; margin-inline: auto; border-radius: .5rem; }
  .review-page:focus, .page-index:focus, .section-title:focus, .scroll-areas:focus { outline: none; }
  @media (max-width: 40rem) {
    html { scroll-padding-top: .5rem; }
    .brandbar { position: static; }
    .brand-title { display: none; }
    .capture-bar { top: 0; }
  }
  .report-footer { padding-block: 1.5rem 2.5rem; color: var(--muted); font-size: .8125rem; border-top: 1px solid var(--line); }
  @media (min-width: 64rem) {
    .workspace { grid-template-columns: minmax(15rem, 20rem) minmax(0, 1fr); }
    .map-card { position: sticky; top: 4.5rem; }
    .map { max-height: calc(100vh - 11rem); }
  }
  @media print {
    html { scroll-padding-top: 0; }
    .brandbar, .map, .workspace, .map-card, .capture-bar { max-height: none; overflow: visible; position: static; }
    .workspace { display: block; }
    .capture-bar a, .marker, .pager, .jump, .brand-link { display: none; }
    .map-card { margin-bottom: 1rem; }
    .review-page { break-before: page; }
    .viewport-sequence > li { break-inside: avoid-page; }
  }
`;

function renderWorkspace(
  review: CaptureResult,
  id: (part: string) => string,
  headingLevel: number,
  title: string,
  lazy: boolean,
  shot?: ViewportShot,
  step?: number,
  totalSteps?: number,
): string {
  const heading = `h${headingLevel}`;
  const { width, height } = shot ?? review.page;
  const sections = shot?.sections ?? review.sections;
  const screenshot = shot?.screenshot ?? review.screenshot;
  const captureId = (part: string) => id(shot ? `step-${step}-${part}` : part);
  const caption = shot ? `Step ${step} of ${totalSteps}` : 'Full-page screenshot';
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
          <${heading} class="structure-heading" id="${captureId('structure')}" tabindex="-1">${shot ? `Step ${step} structure` : 'Structure map'}</${heading}>
          <p>${mapItems ? `${plural(sections.length, 'element')}. Select one to outline it in the screenshot.` : 'No visible headings or landmarks were found.'}</p>
        </div>
        ${mapItems ? `<ol class="map" role="list">${mapItems}</ol>` : ''}
      </nav>
      <figure class="card" aria-labelledby="${captureId('screenshot-heading')}">
        <figcaption class="card-head capture-bar">
          <${heading} id="${captureId('screenshot-heading')}">${caption}</${heading}>
          <div class="capture-links">
            <a href="#${captureId('structure')}">Structure map ↑</a>
          </div>
          ${shot ? `<p class="step-position">${escapeHtml(shot.label)} · scrolled to ${shot.scrollX}, ${shot.scrollY} px</p>` : `<p class="step-position">${width} × ${height} px</p>`}
        </figcaption>
        <div class="frame" style="--frame-width:${width}px">
          <img src="${escapeHtml(screenshot)}" width="${width}" height="${height}"${lazy || shot ? ' loading="lazy" decoding="async"' : ''} alt="${shot ? `Viewport step ${step}` : 'Full-page screenshot'} of ${title}">
          ${markers}
        </div>
      </figure>
    </div>`;
}

function renderPage(review: CaptureResult, index: number, total: number): string {
  const multiPage = total > 1;
  const pageNumber = index + 1;
  const title = escapeHtml(review.title || 'Page review');
  const name = escapeHtml(pageName(review, index));
  const pageId = `page-${pageNumber}`;
  const id = (part: string) => `${pageId}-${part}`;
  const stats = pageStats(review);
  const viewportShots = review.viewportShots ?? [];
  const viewportReference = viewportShots.length ? undefined : review.viewportScreenshot;
  const pageHeading = multiPage ? 'h2' : 'h1';
  const subLevel = multiPage ? 3 : 2;
  const sub = `h${subLevel}`;

  const pager = multiPage ? `<nav class="pager" aria-label="Page ${pageNumber} navigation">
      ${pageNumber > 1 ? `<a href="#page-${pageNumber - 1}">← Previous</a>` : '<span aria-hidden="true">← Previous</span>'}
      <a href="#page-index">All pages</a>
      ${pageNumber < total ? `<a href="#page-${pageNumber + 1}">Next →</a>` : '<span aria-hidden="true">Next →</span>'}
    </nav>` : '';

  const jumpLinks = [
    [viewportShots.length ? id('steps') : id('screenshot-heading'), viewportShots.length ? `Viewport steps (${viewportShots.length})` : 'Screenshot'],
    [viewportShots.length ? id('step-1-structure') : id('structure'), 'Structure map'],
    ...(review.scrollRegions.length ? [[id('scroll-areas'), `Scrollable areas (${review.scrollRegions.length})`]] : []),
    ...(review.warnings.length ? [[id('notes'), `Capture notes (${review.warnings.length})`]] : []),
  ].map(([href, label]) => `<li><a href="#${href}">${label}</a></li>`).join('');

  const warnings = review.warnings.length ? `<details class="warnings" id="${id('notes')}" open>
      <summary>Capture notes (${review.warnings.length}) — things to know about this capture</summary>
      <ul>${review.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>
    </details>` : '';

  const exploration = review.exploration ? `<details class="card exploration">
      <summary>Navigation exploration — ${plural(review.exploration.viewsCaptured, 'view')} captured</summary>
      <p>Found ${plural(review.exploration.linksFound, 'link')} and ${plural(review.exploration.controlsFound, 'navigation control')}; clicked ${review.exploration.controlsClicked}.${review.exploration.skipped.length ? ` Skipped ${review.exploration.skipped.length}:` : ''}</p>
      ${review.exploration.skipped.length ? `<ul>${review.exploration.skipped.map(item => `<li><strong>${escapeHtml(item.label)}</strong> — ${escapeHtml(item.reason)}</li>`).join('')}</ul>` : ''}
    </details>` : '';

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

  const stepStrip = viewportShots.length > 1 ? `<ol class="jump" aria-label="Jump to a viewport step">
      <li class="jump-label" aria-hidden="true">Steps</li>
      ${viewportShots.map((_shot, step) => `<li><a href="#${id(`step-${step + 1}-screenshot-heading`)}" aria-label="Step ${step + 1}">${step + 1}</a></li>`).join('')}
    </ol>` : '';

  const body = viewportShots.length
    ? `<div class="section-title" id="${id('steps')}" tabindex="-1">
        <${sub}>Viewport steps</${sub}>
        <p>Each step is the browser viewport at a different scroll position, including fixed navigation.</p>
      </div>
      ${stepStrip}
      <ol class="viewport-sequence" role="list" aria-label="Viewport screenshot sequence">${viewportShots.map((shot, step) =>
        `<li>${renderWorkspace(review, id, subLevel + 1, title, true, shot, step + 1, viewportShots.length)}</li>`).join('')}</ol>`
    : renderWorkspace(review, id, subLevel, title, index > 0);

  return `<article class="review-page" id="${pageId}" tabindex="-1" aria-labelledby="${id('title')}">
    <header class="page-head">
      <div class="page-head-top">
        <div>
          <p class="eyebrow">${multiPage ? `Page ${pageNumber} of ${total}` : 'Page review'}</p>
          <${pageHeading} id="${id('title')}">${name}</${pageHeading}>
          ${name !== title ? `<p class="source">Page title: ${title}</p>` : ''}
          <p class="source"><code>${escapeHtml(review.url)}</code></p>
        </div>
        ${pager}
      </div>
      <dl class="facts">
        <div><dt>Viewport</dt><dd>${review.viewport.width} × ${review.viewport.height} px</dd></div>
        ${stats.steps ? `<div><dt>Viewport steps</dt><dd>${stats.steps}</dd></div>` : `<div><dt>Full page</dt><dd>${review.page.width} × ${review.page.height} px</dd></div>`}
        <div><dt>Mapped elements</dt><dd>${stats.elements}</dd></div>
        ${stats.scrollAreas ? `<div><dt>Scrollable areas</dt><dd>${stats.scrollAreas}</dd></div>` : ''}
        <div><dt>Captured</dt><dd><time datetime="${escapeHtml(review.capturedAt)}">${escapeHtml(formatTime(review.capturedAt))}</time></dd></div>
      </dl>
      <ul class="jump" aria-label="On this page"><li class="jump-label" aria-hidden="true">On this page</li>${jumpLinks}</ul>
      ${warnings}
      ${exploration}
    </header>
    ${viewportReference ? `<details class="card viewport-reference">
      <summary><span class="scroll-area-title">Original viewport</span><span class="scroll-area-meta">${viewportReference.width} × ${viewportReference.height} px</span></summary>
      <figure>
        <figcaption>The browser viewport as it appeared, with the pinned bottom navigation in its original position.</figcaption>
        <img src="${escapeHtml(viewportReference.screenshot)}" width="${viewportReference.width}" height="${viewportReference.height}" loading="lazy" decoding="async" alt="Original browser viewport for ${title}">
      </figure>
    </details>` : ''}
    ${body}
    ${scrollAreas ? `<section class="scroll-areas" id="${id('scroll-areas')}" aria-labelledby="${id('scroll-areas-heading')}" tabindex="-1">
      <div class="section-title">
        <${sub} id="${id('scroll-areas-heading')}">Scrollable areas</${sub}>
        <p>Panels that scroll independently of the page. Open one to see its full captured content.</p>
      </div>
      ${scrollAreas}
    </section>` : ''}
  </article>`;
}

export function renderReport(review: CaptureResult): string {
  const pages = [review, ...(review.linkedPages ?? [])];
  const multiPage = pages.length > 1;
  const title = escapeHtml(review.title || 'Page review');
  const allStats = pages.map(pageStats);
  const totals = allStats.reduce((sum, stats) => ({
    screenshots: sum.screenshots + stats.screenshots + stats.scrollAreas,
    elements: sum.elements + stats.elements,
    notes: sum.notes + stats.notes,
  }), { screenshots: 0, elements: 0, notes: 0 });

  const overview = multiPage ? `<section class="overview" aria-labelledby="report-title">
      <div>
        <p class="eyebrow">Design review · ${originOf(review.url)}</p>
        <h1 id="report-title">${title}</h1>
        <p class="source">Started from <code>${escapeHtml(review.url)}</code></p>
      </div>
      <dl class="summary">
        <div><dt>Pages captured</dt><dd>${pages.length}</dd></div>
        <div><dt>Screenshots</dt><dd>${totals.screenshots}</dd></div>
        <div><dt>Mapped elements</dt><dd>${totals.elements}</dd></div>
        <div><dt>Capture notes</dt><dd>${totals.notes}</dd></div>
        <div><dt>Viewport</dt><dd class="small">${review.viewport.width} × ${review.viewport.height} px</dd></div>
        <div><dt>Captured</dt><dd class="small"><time datetime="${escapeHtml(review.capturedAt)}">${escapeHtml(formatTime(review.capturedAt))}</time></dd></div>
      </dl>
      <p class="guide"><strong>How to read this review:</strong> pick a page below. Each page has its screenshot beside a structure map of headings and landmarks; select an item in the map to outline it on the screenshot. Use <strong>Previous</strong>, <strong>Next</strong> and <strong>All pages</strong> to move between pages.</p>
    </section>
    <nav class="card page-index" id="page-index" tabindex="-1" aria-labelledby="page-index-heading">
      <div class="card-head">
        <h2 id="page-index-heading">All pages</h2>
        <p>${plural(pages.length, 'page')} in the order they were captured</p>
      </div>
      <ol class="page-list" role="list">${pages.map((page, index) => {
        const stats = allStats[index]!;
        return `<li><a href="#page-${index + 1}">
        <span class="index" aria-hidden="true">${index + 1}</span>
        <span><span class="name">${escapeHtml(pageName(page, index))}</span><span class="route">${escapeHtml(routeOf(page.url))}</span></span>
        <span class="meta">
          <span class="chip">${stats.steps ? plural(stats.steps, 'step') : 'Full page'}</span>
          ${stats.scrollAreas ? `<span class="chip">${plural(stats.scrollAreas, 'scroll area')}</span>` : ''}
          ${stats.notes ? `<span class="chip warn">${plural(stats.notes, 'note')}</span>` : ''}
        </span>
      </a></li>`;
      }).join('')}</ol>
    </nav>` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | PageAtlas review</title>
  <style>${reportStyles}</style>
</head>
<body>
  <header class="brandbar">
    <div class="wrap brandline">
      <span class="brand"><svg class="logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 8h18M9 8v13m4-9h4m-4 4h4"/></svg>PageAtlas</span>
      <span class="badge">Review export</span>
      <span class="brand-title">${title}${multiPage ? ` · ${plural(pages.length, 'page')}` : ''}</span>
      ${multiPage ? '<a class="brand-link" href="#page-index">All pages</a>' : ''}
    </div>
  </header>
  <main class="wrap">
    ${overview}
    ${pages.map((page, index) => renderPage(page, index, pages.length)).join('')}
  </main>
  <footer class="wrap report-footer">
    Exported from PageAtlas. Captured ${escapeHtml(formatTime(review.capturedAt))} at ${review.viewport.width} × ${review.viewport.height} px. This file works offline; screenshots are embedded.
  </footer>
</body>
</html>`;
}
