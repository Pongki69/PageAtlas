import {
  ArrowDownToLine, ArrowRight, Camera, Check, ChevronLeft, ChevronRight, CircleAlert, ExternalLink,
  Focus, Globe2, Layers3, ListTree, LoaderCircle, LockKeyhole, Maximize2, MoveVertical,
  Monitor, Moon, Smartphone, Square, Sun, Tablet, Target, X,
} from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react'
import './index.css'
const HomePage = lazy(() => import('./HomePage'))
import { presetSizes, resolveCaptureViewport, viewportLimits, type ViewportMode } from '../shared/viewports.ts'

const viewports = [
  { id: 'auto', label: 'Current screen', icon: Maximize2 },
  { id: 'desktop', label: 'Desktop', icon: Monitor },
  { id: 'tablet', label: 'Tablet', icon: Tablet },
  { id: 'mobile', label: 'Mobile', icon: Smartphone },
  { id: 'custom', label: 'Custom', icon: Focus },
] as const

type Viewport = ViewportMode
type Theme = 'light' | 'dark'
type CaptureActivity = 'capture' | 'open-sign-in' | 'capture-signed-in' | 'cancel-sign-in'
type CaptureTarget = { url: string; viewport: Viewport; width?: number; height?: number; signIn: boolean; crawl: boolean }

const activityLabels: Record<CaptureActivity, string> = {
  capture: 'Waiting for page content and capturing its design…',
  'open-sign-in': 'Opening a temporary browser window…',
  'capture-signed-in': 'Waiting for signed-in content and capturing the page…',
  'cancel-sign-in': 'Closing the sign-in window…',
}

const sessionKey = 'page-atlas-sign-in'

function rememberedSession() {
  try {
    return window.sessionStorage.getItem(sessionKey)
  } catch {
    return null
  }
}

interface Size {
  width: number
  height: number
}

interface Section extends Size {
  id: string
  label: string
  tag: string
  depth: number
  x: number
  y: number
}

interface Screenshot extends Size {
  screenshotUrl: string
}

interface ScrollRegion extends Screenshot {
  id: string
  label: string
  tag: string
  complete: boolean
  contentWidth?: number
  contentHeight?: number
  partialReason?: string
}

interface ViewportShot extends Screenshot {
  id: string
  label: string
  scrollX: number
  scrollY: number
  sections: Section[]
}

interface PageReview {
  id: string
  title: string
  url: string
  capturedAt: string
  viewport: Size
  page: Size
  screenshotUrl: string
  viewportScreenshot?: Screenshot
  viewportShots?: ViewportShot[]
  sections: Section[]
  scrollRegions: ScrollRegion[]
  warnings: string[]
  navigationLabel?: string
}

interface Review extends PageReview {
  linkedPages?: PageReview[]
  exploration?: {
    linksFound: number
    controlsFound: number
    controlsClicked: number
    viewsCaptured: number
    skipped: { label: string; reason: string }[]
  }
}

interface CaptureJob {
  id: string
  status: 'running' | 'cancelling' | 'complete' | 'cancelled' | 'failed'
  progress: number
  phase: string
  startedAt: string
  updatedAt: string
  pagesCaptured?: number
  viewsCaptured?: number
  logs: { id: number; time: string; message: string }[]
  result?: Review
  error?: string
  errorCode?: string
  sessionId?: string
  input?: { url: string; viewport: Viewport; width?: number; height?: number; crawl: boolean; allowDevCertificate: boolean }
}

function jobIsActive(job: CaptureJob | null) {
  return job?.status === 'running' || job?.status === 'cancelling'
}

async function currentCaptureJob(signal?: AbortSignal): Promise<CaptureJob | null> {
  const response = await fetch('/api/capture-job', { cache: 'no-store', signal })
  if (!response.ok) throw new Error((await responseFailure(response, 'Couldn’t check the current capture.')).message)
  const result: { job: CaptureJob | null } = await response.json()
  return result.job
}

function initialTheme(): Theme {
  try {
    return window.localStorage.getItem('page-atlas-theme') === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function normalizeUrl(input: string) {
  const value = input.trim()
  if (/^https?:\/\//i.test(value)) return value
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?=[:/?#]|$)/i.test(value)) return `http://${value}`
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return value
  return `https://${value}`
}

function developmentCertificateOrigin(target: string) {
  try {
    const { protocol, hostname, origin } = new URL(target)
    const localName = hostname === 'localhost' || hostname === 'localhost.'
    const localIpv4 = /^(?:10|127|169\.254|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\./.test(hostname)
      && /^(?:\d+\.){3}\d+$/.test(hostname)
    const localIpv6 = hostname === '[::1]' || /^\[(?:f[cd][\da-f]{2}|fe[89ab][\da-f]):/.test(hostname)
    return protocol === 'https:' && (localName || localIpv4 || localIpv6) ? origin : null
  } catch {
    return null
  }
}

async function responseFailure(response: Response, fallback: string) {
  const failure: unknown = await response.json().catch(() => null)
  if (!failure || typeof failure !== 'object') return { message: fallback }
  return {
    message: 'error' in failure && typeof failure.error === 'string' ? failure.error || fallback : fallback,
    code: 'code' in failure && typeof failure.code === 'string' ? failure.code : undefined,
  }
}

function EmptyPreview() {
  return (
    <div className="empty-preview">
      <div className="preview-art" aria-hidden="true">
        <div className="art-window">
          <div className="art-chrome"><i /><i /><i /><span /></div>
          <div className="art-content">
            <div className="art-nav"><i /><span /><span /><span /></div>
            <div className="art-hero">
              <div className="art-text"><i /><i /><b /></div>
              <div className="art-orbit"><i /><b /></div>
            </div>
            <div className="art-columns"><span /><span /><span /></div>
          </div>
        </div>
        <span className="art-pin art-pin-first">01</span>
        <span className="art-pin art-pin-second">02</span>
        <span className="art-pin art-pin-third">03</span>
      </div>
      <h3>Your capture starts here</h3>
      <p>Enter a URL and choose a viewport to review a page.</p>
    </div>
  )
}

function StructurePanel({ review, selected, onSelect }: {
  review: Pick<PageReview, 'sections'> | null
  selected: string | null
  onSelect: (section: Section) => void
}) {
  return (
    <aside className="map-panel" aria-labelledby="structure-heading">
      <div className="map-heading">
        <div>
          <h3 id="structure-heading">Page structure</h3>
          <p>Headings and landmarks</p>
        </div>
        {review && <span className="count-badge" aria-label={`${review.sections.length} sections`}>{review.sections.length}</span>}
      </div>
      {review?.sections.length ? (
        <ol className="structure-list" aria-label="Mapped sections">
          {review.sections.map((section, index) => (
            <li key={section.id}>
              <button
                type="button"
                className="section-row"
                aria-pressed={selected === section.id}
                style={{ paddingInlineStart: 10 + Math.max(0, Math.min(4, section.depth)) * 10 }}
                onClick={() => onSelect(section)}
              >
                <span className="section-number">{String(index + 1).padStart(2, '0')}</span>
                <span className="section-details">
                  <span className="section-label" title={section.label}>{section.label}</span>
                  <span className="section-tag">{section.tag}</span>
                </span>
                <ChevronRight className="section-chevron" size={15} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <div className="empty-map">
          <div className="map-symbol"><ListTree size={21} aria-hidden="true" /></div>
          <p className="empty-map-title">{review ? 'No landmarks found' : 'No sections mapped yet'}</p>
          <p>{review ? 'The full screenshot is available for review.' : 'The page outline will appear here after a capture.'}</p>
        </div>
      )}
      {review?.sections.length ? <p className="map-hint"><Target size={15} aria-hidden="true" /> Select a section to locate it.</p> : null}
    </aside>
  )
}

function ScrollArea({ region }: { region: ScrollRegion }) {
  const [imageError, setImageError] = useState(false)

  return (
    <details className="scroll-area">
      <summary>
        <span className="scroll-area-label">{region.label}</span>
        <span className="scroll-area-meta">
          <span>{region.tag} · {region.width.toLocaleString()} × {region.height.toLocaleString()} px</span>
          {!region.complete && <span className="partial-badge">Partial capture</span>}
        </span>
        <ChevronRight className="scroll-area-chevron" size={17} aria-hidden="true" />
      </summary>
      <div className="scroll-area-content">
        {!region.complete && (
          <div className="notice" style={{ marginBottom: 8 }}>
            <CircleAlert size={18} aria-hidden="true" />
            <div>
              <p><strong>{region.label}.</strong> {region.partialReason || 'The capture ended before this area finished.'}</p>
              <p>Captured {region.width.toLocaleString()} × {region.height.toLocaleString()} px.
                {region.contentWidth && region.contentHeight
                  ? ` Full content ${region.contentWidth.toLocaleString()} × ${region.contentHeight.toLocaleString()} px.`
                  : ''}</p>
            </div>
          </div>
        )}
        {imageError ? (
          <p className="notice error-notice" role="alert"><CircleAlert size={18} aria-hidden="true" />This image couldn’t load. Capture the page again to refresh it.</p>
        ) : (
          <div className="scroll-area-image" tabIndex={0} role="region" aria-label={`Screenshot of ${region.label}`}>
            <img
              src={region.screenshotUrl}
              width={region.width}
              height={region.height}
              loading="lazy"
              decoding="async"
              alt={`Content captured inside ${region.label}`}
              onError={() => setImageError(true)}
            />
          </div>
        )}
      </div>
    </details>
  )
}

function ViewportReference({ capture, pageName }: { capture: Screenshot; pageName: string }) {
  const [imageError, setImageError] = useState(false)

  return (
    <details className="scroll-area viewport-reference">
      <summary>
        <span className="scroll-area-label">Original viewport</span>
        <span className="scroll-area-meta">{capture.width.toLocaleString()} × {capture.height.toLocaleString()} px</span>
        <ChevronRight className="scroll-area-chevron" size={17} aria-hidden="true" />
      </summary>
      <div className="scroll-area-content">
        <p className="viewport-reference-caption">See the pinned bottom navigation in its original position. The page capture below shows the content.</p>
        {imageError ? (
          <p className="notice error-notice" role="alert"><CircleAlert size={18} aria-hidden="true" />The original viewport couldn’t load. Capture the page again to refresh it.</p>
        ) : (
          <img
            src={capture.screenshotUrl}
            width={capture.width}
            height={capture.height}
            loading="lazy"
            decoding="async"
            alt={`Original viewport of ${pageName} with pinned bottom navigation`}
            onError={() => setImageError(true)}
          />
        )}
      </div>
    </details>
  )
}

function ExplorationSummary({ exploration }: { exploration: NonNullable<Review['exploration']> }) {
  return (
    <div className="page-picker exploration-summary" aria-label="Navigation exploration results">
      <div className="page-picker-copy">
        <p className="page-picker-count">
          {exploration.controlsClicked.toLocaleString()} controls clicked · {exploration.viewsCaptured.toLocaleString()} views captured
        </p>
        <p>{exploration.linksFound.toLocaleString()} links discovered · {exploration.controlsFound.toLocaleString()} controls discovered</p>
      </div>
      {exploration.skipped.length > 0 && (
        <details className="scroll-area exploration-skips">
          <summary>
            <span className="scroll-area-label">Skipped controls ({exploration.skipped.length.toLocaleString()})</span>
            <ChevronRight className="scroll-area-chevron" size={17} aria-hidden="true" />
          </summary>
          <div className="scroll-area-content">
            <ul className="exploration-skipped-list">
              {exploration.skipped.map((control, index) => (
                <li key={`${index}-${control.label}`}>
                  <strong>{control.label || 'Unnamed control'}</strong>
                  <p>{control.reason}</p>
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}
    </div>
  )
}

function CaptureProgress({ job, stopping, onStop }: { job: CaptureJob; stopping: boolean; onStop: () => void }) {
  const logScrollRef = useRef<HTMLDivElement>(null)
  const followLogs = useRef(true)
  const latestLogId = job.logs.at(-1)?.id
  const active = jobIsActive(job)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  const seconds = Math.max(0, Math.round(((active ? now : Date.parse(job.updatedAt)) - Date.parse(job.startedAt)) / 1000))
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? '' : 's'}`
  const percent = job.status === 'complete' ? 100 : Math.max(0, Math.min(99, Math.round(job.progress)))
  const title = job.status === 'running' ? 'Capture in progress'
    : job.status === 'cancelling' ? 'Stopping capture'
      : job.status === 'complete' ? 'Capture complete'
        : job.status === 'cancelled' ? 'Capture stopped' : 'Capture needs attention'

  useEffect(() => {
    const log = logScrollRef.current
    if (log && followLogs.current) log.scrollTop = log.scrollHeight
  }, [latestLogId])

  return (
    <section className="workspace capture-progress" aria-labelledby="capture-progress-heading">
      <div className="capture-progress-heading">
        <div>
          <h2 id="capture-progress-heading">{title}</h2>
          <p role="status">{job.status === 'cancelling' ? 'Closing the capture browser…'
            : job.status === 'complete' ? `Finished in ${elapsed}.`
              : job.status === 'cancelled' ? `Stopped after ${elapsed}. Nothing was saved.`
                : job.status === 'failed' ? `Stopped with an error after ${elapsed}. Check the activity log below.` : job.phase}</p>
        </div>
        {active && (
          <button className="export-button stop-capture" type="button" onClick={onStop} disabled={stopping || job.status === 'cancelling'}>
            {stopping || job.status === 'cancelling' ? <LoaderCircle className="spinner" size={16} aria-hidden="true" /> : <Square size={15} aria-hidden="true" />}
            {stopping || job.status === 'cancelling' ? 'Stopping…' : 'Stop capture'}
          </button>
        )}
      </div>
      <div className="capture-progress-label">
        <span>{active ? 'Estimated progress' : 'Progress'}</span>
        <strong>{percent}%</strong>
      </div>
      <progress aria-label={active ? 'Estimated capture progress' : 'Capture progress'} max={100} value={percent}>{percent}%</progress>
      <div className="capture-progress-meta">
        <p>{active ? `Elapsed ${elapsed} · safe to refresh, the capture keeps running` : `Elapsed ${elapsed}`}</p>
        <p>{count(job.pagesCaptured ?? 0, 'page')} · {count(job.viewsCaptured ?? 0, 'screenshot')}</p>
      </div>
      <details className="capture-logs" open={active || job.status === 'failed'}>
        <summary>Activity log <span>{job.logs.length}</span></summary>
        <div className="capture-log-scroll" ref={logScrollRef} tabIndex={0} role="region" aria-label="Capture activity log" onScroll={event => {
          const log = event.currentTarget
          followLogs.current = log.scrollHeight - log.clientHeight - log.scrollTop < 48
        }}>
          {job.logs.length ? (
            <ol role="log" aria-live="polite" aria-relevant="additions">
              {job.logs.map(entry => (
                <li key={entry.id}>
                  <time dateTime={entry.time}>{new Date(entry.time).toLocaleTimeString([], { hour12: false })}</time>
                  <span>{entry.message}</span>
                </li>
              ))}
            </ol>
          ) : <p className="capture-log-empty">Waiting for the first capture event…</p>}
        </div>
      </details>
    </section>
  )
}

function CaptureViewer({ pages, initialPageId, onSelect, onClose }: {
  pages: PageReview[]
  initialPageId: string
  onSelect: (pageId: string, shotId?: string) => void
  onClose: () => void
}) {
  const pictures = pages.flatMap<{ pageId: string; shotId: string | undefined; url: string; name: string }>((page, index) => {
    const name = page.navigationLabel || page.title || `Page ${index + 1}`
    return page.viewportShots?.length ? page.viewportShots.map((shot, shotIndex) => ({
      pageId: page.id, shotId: shot.id, url: shot.screenshotUrl,
      name: page.viewportShots!.length > 1 ? `${name} · View ${shotIndex + 1} of ${page.viewportShots!.length}` : name,
    })) : [{ pageId: page.id, shotId: undefined, url: page.screenshotUrl, name }]
  })
  const [index, setIndex] = useState(() => Math.max(0, pictures.findIndex(picture => picture.pageId === initialPageId)))
  const [failed, setFailed] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const picture = pictures[index]
  useEffect(() => {
    const element = dialog.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    element?.showModal()
    return () => {
      element?.close()
      document.body.style.overflow = previousOverflow
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])
  function move(next: number) {
    if (next < 0 || next >= pictures.length) return
    setIndex(next)
    setFailed(false)
    const selected = pictures[next]!
    onSelect(selected.pageId, selected.shotId)
  }
  if (!picture) return null
  return <dialog ref={dialog} className="capture-viewer" aria-labelledby="viewer-title" aria-describedby="viewer-count" onCancel={event => { event.preventDefault(); onClose() }} onClick={event => {
    if (event.target !== event.currentTarget) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
  }} onKeyDown={event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'ArrowLeft') { event.preventDefault(); move(index - 1) }
    if (event.key === 'ArrowRight') { event.preventDefault(); move(index + 1) }
  }}>
    <header className="viewer-header">
      <div aria-live="polite"><h2 id="viewer-title">{picture.name}</h2><p id="viewer-count">Image {index + 1} of {pictures.length}</p></div>
      <button type="button" className="icon-button" aria-label="Close image viewer" onClick={onClose} autoFocus><X size={21} aria-hidden="true" /></button>
    </header>
    <div className="viewer-stage">
      <button type="button" className="icon-button viewer-nav" aria-label="Previous image" disabled={index === 0} onClick={() => move(index - 1)}><ChevronLeft size={25} aria-hidden="true" /></button>
      <div className="viewer-image" onPointerDown={event => { if (event.pointerType === 'touch') pointer.current = { x: event.clientX, y: event.clientY } }} onPointerUp={event => {
        const start = pointer.current
        pointer.current = null
        if (!start) return
        const delta = event.clientX - start.x
        if (Math.abs(delta) > 60 && Math.abs(delta) > Math.abs(event.clientY - start.y) * 1.5) move(index + (delta < 0 ? 1 : -1))
      }} onPointerCancel={() => { pointer.current = null }}>
        {failed ? <p role="alert">This image is no longer available. Close the viewer and capture the page again.</p> : <img key={picture.url} src={picture.url} alt={picture.name} onError={() => setFailed(true)} draggable={false} />}
      </div>
      <button type="button" className="icon-button viewer-nav" aria-label="Next image" disabled={index === pictures.length - 1} onClick={() => move(index + 1)}><ChevronRight size={25} aria-hidden="true" /></button>
    </div>
    <p className="viewer-help">Use the arrows to browse · Swipe on touch screens · Esc to close</p>
  </dialog>
}

export default function App() {
  const [screen, setScreen] = useState<'home' | 'capture'>(() => window.location.hash === '#capture' ? 'capture' : 'home')
  useEffect(() => {
    const navigate = () => {
      if (!['', '#home', '#capture'].includes(window.location.hash)) return
      setScreen(window.location.hash === '#capture' ? 'capture' : 'home')
      window.scrollTo({ top: 0, behavior: 'instant' })
    }
    window.addEventListener('hashchange', navigate)
    return () => window.removeEventListener('hashchange', navigate)
  }, [])
  const [theme, setTheme] = useState(initialTheme)
  const [url, setUrl] = useState('')
  const [allowDevCertificate, setAllowDevCertificate] = useState(false)
  const [viewport, setViewport] = useState<Viewport>('auto')
  const [windowSize, setWindowSize] = useState<Size>(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const [customWidth, setCustomWidth] = useState('1920')
  const [customHeight, setCustomHeight] = useState('1080')
  useEffect(() => {
    const resize = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const [crawl, setCrawl] = useState(true)
  const [sessionId, setSessionId] = useState(rememberedSession)
  const [signIn, setSignIn] = useState(sessionId !== null)
  const [review, setReview] = useState<Review | null>(null)
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null)
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [activity, setActivity] = useState<CaptureActivity | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [certificateRetry, setCertificateRetry] = useState<CaptureTarget | null>(null)
  const [imageError, setImageError] = useState(false)
  const [job, setJob] = useState<CaptureJob | null>(null)
  const [jobSyncing, setJobSyncing] = useState(true)
  const [jobsSynced, setJobsSynced] = useState(false)
  const [jobConnectionError, setJobConnectionError] = useState('')
  const [stopping, setStopping] = useState(false)
  const [reviewAction, setReviewAction] = useState<'export' | 'pdf' | 'delete' | null>(null)
  const [viewerPageId, setViewerPageId] = useState<string | null>(null)
  const jobRef = useRef<CaptureJob | null>(null)
  const handledJob = useRef<string | null>(null)
  const restoredInput = useRef<string | null>(null)
  const dismissedReviews = useRef(new Set<string>())
  const sessionHeadingRef = useRef<HTMLHeadingElement>(null)
  const captureButtonRef = useRef<HTMLButtonElement>(null)
  const hadSession = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const screenshotRef = useRef<HTMLDivElement>(null)
  const activeJob = jobIsActive(job)
  const pending = activity !== null || activeJob || jobSyncing || !jobsSynced || reviewAction !== null
  const developmentOrigin = developmentCertificateOrigin(normalizeUrl(url))
  const capturedPages = review ? [review, ...(review.linkedPages ?? [])] : []
  const currentPage = capturedPages.find((page) => page.id === selectedPageId) ?? review
  const viewportShots = currentPage?.viewportShots ?? []
  const currentShot = viewportShots.find((shot) => shot.id === selectedShotId) ?? viewportShots[0]
  const shotIndex = Math.max(0, viewportShots.findIndex((shot) => shot.id === currentShot?.id))
  const previewSize = currentShot ?? currentPage?.page
  const previewSections = currentShot?.sections ?? currentPage?.sections ?? []
  const previewUrl = currentShot?.screenshotUrl ?? currentPage?.screenshotUrl
  const mobileReview = currentPage ? currentPage.viewport.width <= 600 : viewport === 'mobile'
  const screenshotLabel = currentShot || mobileReview ? 'Viewport screenshot' : 'Full-page screenshot'
  const selectedSection = previewSections.find((section) => section.id === selected)
  const scrollRegions = currentPage?.scrollRegions ?? []
  const progress = jobSyncing ? 'Checking for a running capture…' : activeJob ? job?.phase : activity && (crawl && (activity === 'capture' || activity === 'capture-signed-in')
    ? 'Clicking navigation controls and capturing app screens…'
    : activityLabels[activity])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      window.localStorage.setItem('page-atlas-theme', theme)
    } catch {
      // The theme can still change when persistent storage is unavailable.
    }
  }, [theme])

  useEffect(() => {
    try {
      if (sessionId) window.sessionStorage.setItem(sessionKey, sessionId)
      else window.sessionStorage.removeItem(sessionKey)
    } catch {
      // The temporary window remains available while this page stays open.
    }
  }, [sessionId])

  useEffect(() => {
    if (pending || hadSession.current === (sessionId !== null)) return
    if (sessionId) sessionHeadingRef.current?.focus({ preventScroll: true })
    else captureButtonRef.current?.focus({ preventScroll: true })
    hadSession.current = sessionId !== null
  }, [pending, sessionId])

  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    void currentCaptureJob(controller.signal).then(current => {
      if (disposed) return
      applyCaptureJob(current)
      setJobsSynced(true)
      setJobConnectionError('')
    }).catch(() => {
      if (!disposed) setJobConnectionError('Couldn’t check the current capture. Reconnect before starting another capture.')
    }).finally(() => {
      if (!disposed) setJobSyncing(false)
    })
    return () => {
      disposed = true
      controller.abort()
    }
  }, [])

  useEffect(() => {
    if (!activeJob) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    async function poll() {
      try {
        const current = await currentCaptureJob(controller.signal)
        if (disposed) return
        applyCaptureJob(current)
        setJobsSynced(true)
        setJobConnectionError('')
      } catch {
        if (!disposed) setJobConnectionError('Connection interrupted. Reconnecting to the running capture…')
      }
      if (!disposed) timer = setTimeout(() => void poll(), 800)
    }
    timer = setTimeout(() => void poll(), 800)
    return () => {
      disposed = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [activeJob, job?.id])

  function selectPage(id: string) {
    setSelectedPageId(id)
    setSelectedShotId(null)
    setSelected(null)
    setImageError(false)
  }

  function selectShot(id: string) {
    setSelectedShotId(id)
    setSelected(null)
    setImageError(false)
  }

  function showReview(result: Review) {
    selectPage(result.id)
    setReview(result)
    const count = 1 + (result.linkedPages?.length ?? 0)
    setStatus(result.linkedPages ? `${count} ${count === 1 ? 'page' : 'pages'} captured` : 'Capture complete')
  }

  function clearReview(message: string) {
    setViewerPageId(null)
    if (review) dismissedReviews.current.add(review.id)
    setReview(null)
    selectPage('')
    jobRef.current = null
    setJob(null)
    handledJob.current = null
    restoredInput.current = null
    setUrl('')
    setError('')
    setCertificateRetry(null)
    setStatus(message)
  }

  async function finishReview(format: 'html' | 'pdf' | 'delete') {
    if (!review || pending) return
    const exporting = format !== 'delete'
    setReviewAction(format === 'html' ? 'export' : format)
    setError('')
    try {
      const response = await fetch(`/api/reviews/${encodeURIComponent(review.id)}${exporting ? format === 'pdf' ? '/export-pdf' : '/export' : ''}`, { method: exporting ? 'POST' : 'DELETE' })
      if (!response.ok) throw new Error((await responseFailure(response, 'Couldn’t finish this review. Please try again.')).message)
      if (exporting) {
        const blob = await response.blob()
        const objectUrl = URL.createObjectURL(blob)
        const download = document.createElement('a')
        download.href = objectUrl
        download.download = `pageatlas-${format === 'pdf' ? 'captures' : 'review'}-${review.id.slice(0, 8)}.${format}`
        download.click()
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
      }
      clearReview(exporting ? `${format.toUpperCase()} download started. Captured data deleted from PageAtlas.` : 'Review deleted. Ready for a new capture.')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Couldn’t finish this review. Please try again.')
    } finally {
      setReviewAction(null)
    }
  }

  function applyCaptureJob(current: CaptureJob | null) {
    if (current?.result && dismissedReviews.current.has(current.result.id)) return
    const previous = jobRef.current
    if (current && previous?.id === current.id && Date.parse(current.updatedAt) < Date.parse(previous.updatedAt)) return
    if (current && previous?.id === current.id && ((previous.status === 'cancelling' && current.status === 'running') || (!jobIsActive(previous) && jobIsActive(current)))) return
    jobRef.current = current
    setJob(current)
    if (!current) {
      if (jobIsActive(previous)) {
        setStatus('')
        setError('The capture is no longer running. You can start a new capture.')
      }
      return
    }

    if (current.input && restoredInput.current !== current.id) {
      restoredInput.current = current.id
      setUrl(current.input.url)
      setViewport(current.input.viewport)
      if (current.input.viewport === 'custom' && current.input.width && current.input.height) {
        setCustomWidth(String(current.input.width))
        setCustomHeight(String(current.input.height))
      }
      setCrawl(current.input.crawl)
      setAllowDevCertificate(current.input.allowDevCertificate)
      setSignIn(false)
    }
    if (jobIsActive(current)) {
      setSessionId(null)
      if (previous?.id !== current.id) {
        setError('')
        setStatus('')
        setCertificateRetry(null)
      }
      return
    }
    if (handledJob.current === current.id) return
    handledJob.current = current.id
    if (current.status === 'failed' && current.sessionId) setSessionId(current.sessionId)
    else if (jobIsActive(previous)) setSessionId(null)
    setCertificateRetry(null)
    if (current.status === 'complete') {
      setError('')
      if (current.result) showReview(current.result)
      else setStatus('Capture complete')
    } else if (current.status === 'cancelled') {
      setError('')
      setStatus('Capture stopped')
    } else {
      setStatus('')
      setError(current.error || 'The capture couldn’t finish. Review the activity log and try again.')
      if (current.sessionId) setSignIn(true)
      if (current.errorCode === 'LOCAL_DEV_CERTIFICATE_REQUIRED' && current.input && !current.input.allowDevCertificate) {
        setCertificateRetry({ ...current.input, signIn: false })
      }
    }
  }

  async function syncCaptureJob() {
    setJobSyncing(true)
    try {
      applyCaptureJob(await currentCaptureJob())
      setJobsSynced(true)
      setJobConnectionError('')
    } catch {
      setJobConnectionError('Couldn’t reconnect. Check that PageAtlas is running and try again.')
    } finally {
      setJobSyncing(false)
    }
  }

  function changeUrl(value: string) {
    const target = normalizeUrl(value)
    if (developmentCertificateOrigin(target) !== developmentOrigin) setAllowDevCertificate(false)
    if (target !== normalizeUrl(url)) clearCertificateRetry()
    setUrl(value)
  }

  function clearCertificateRetry() {
    if (!certificateRetry) return
    setCertificateRetry(null)
    setError('')
  }

  function startCapture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending || sessionId) return

    const target = normalizeUrl(url)
    try {
      const parsed = new URL(target)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error()
    } catch {
      setCertificateRetry(null)
      setStatus('')
      setError('Enter a valid web address, such as https://example.com.')
      return
    }

    try {
      const size = resolveCaptureViewport(viewport,
        viewport === 'auto' ? window.innerWidth : Number(customWidth),
        viewport === 'auto' ? window.innerHeight : Number(customHeight))
      void requestCapture({ url: target, ...size, signIn, crawl }, Boolean(developmentOrigin && allowDevCertificate))
    } catch (error) {
      setStatus('')
      setError(error instanceof Error ? error.message : 'Choose a valid capture size.')
    }
  }

  async function requestCapture(target: CaptureTarget, useDevCertificate: boolean) {
    if (pending || sessionId) return

    setCertificateRetry(null)
    setStatus('')
    setError('')
    setActivity(target.signIn ? 'open-sign-in' : 'capture')
    try {
      const response = await fetch(target.signIn ? '/api/sign-in' : '/api/capture-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target.url, viewport: target.viewport, width: target.width, height: target.height, crawl: target.crawl, allowDevCertificate: useDevCertificate }),
      })
      if (!response.ok) {
        const failure = await responseFailure(response, 'The capture service is unavailable. Try again in a moment.')
        setError(failure.message)
        if (!useDevCertificate && failure.code === 'LOCAL_DEV_CERTIFICATE_REQUIRED') setCertificateRetry(target)
        if (response.status === 409 || response.status === 429) await syncCaptureJob()
        return
      }
      if (target.signIn) {
        const result: { id: string } = await response.json()
        setSessionId(result.id)
      } else {
        const result: { job: CaptureJob } = await response.json()
        applyCaptureJob(result.job)
      }
    } catch {
      setError('Couldn’t reach the capture service. Check that PageAtlas is running and try again.')
    } finally {
      setActivity(null)
    }
  }

  async function finishSignIn() {
    if (!sessionId || pending) return

    setError('')
    setActivity('capture-signed-in')
    try {
      const response = await fetch('/api/capture-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      if (!response.ok) {
        setError((await responseFailure(response, 'Couldn’t capture the signed-in page. Try again.')).message)
        if (response.status !== 409 && response.status !== 429) setSessionId(null)
        if (response.status === 409 || response.status === 429) await syncCaptureJob()
        return
      }
      setSessionId(null)
      const result: { job: CaptureJob } = await response.json()
      applyCaptureJob(result.job)
    } catch {
      setError('Couldn’t reach the capture service. Check that PageAtlas is running and try again.')
    } finally {
      setActivity(null)
    }
  }

  async function stopCapture() {
    const current = jobRef.current
    if (!current || !jobIsActive(current) || current.status === 'cancelling' || stopping) return
    setStopping(true)
    setError('')
    try {
      const response = await fetch(`/api/capture-job/${encodeURIComponent(current.id)}/cancel`, { method: 'POST' })
      if (!response.ok) {
        setError((await responseFailure(response, 'Couldn’t stop this capture. Try again.')).message)
        return
      }
      const result: { job: CaptureJob } = await response.json()
      applyCaptureJob(result.job)
    } catch {
      setError('Couldn’t reach the capture service to stop it. Reconnect and try again.')
    } finally {
      setStopping(false)
    }
  }

  async function cancelSignIn() {
    if (!sessionId || pending) return

    setError('')
    setActivity('cancel-sign-in')
    try {
      const response = await fetch(`/api/sign-in/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      if (!response.ok && response.status !== 404 && response.status !== 410) {
        setError((await responseFailure(response, 'Couldn’t close the sign-in window. Try again.')).message)
        return
      }
      setSessionId(null)
      setStatus('Sign-in session closed')
    } catch {
      setError('Couldn’t reach the capture service. Check that PageAtlas is running and try again.')
    } finally {
      setActivity(null)
    }
  }

  function selectSection(section: Section) {
    setSelected(section.id)
    const scroll = scrollRef.current
    const screenshot = screenshotRef.current
    if (!scroll || !screenshot || !previewSize) return

    const screenshotBounds = screenshot.getBoundingClientRect()
    const screenshotTop = screenshotBounds.top - scroll.getBoundingClientRect().top + scroll.scrollTop
    const destination = screenshotTop + section.y * screenshotBounds.height / previewSize.height
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    scroll.scrollTo({
      top: Math.max(0, destination - 24),
      behavior,
    })
    if (window.matchMedia('(max-width: 669px)').matches) scroll.scrollIntoView({ block: 'center', behavior })
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="app-header">
        <div className="page-container header-content">
          <a className="brand" href="#home" aria-label="PageAtlas home">
            <span className="brand-mark"><Layers3 size={21} strokeWidth={2.2} aria-hidden="true" /></span>
            <span>PageAtlas</span>
            <span className="brand-context">Design review</span>
          </a>
          <div className="header-actions">
            <nav className="site-nav" aria-label="Main navigation"><a className="nav-home" href="#home" aria-current={screen === 'home' ? 'page' : undefined}>Home</a><a href="#capture" aria-current={screen === 'capture' ? 'page' : undefined}>Capture</a></nav>
            <button
              type="button"
              className="icon-button"
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
            </button>
          </div>
        </div>
      </header>

      <main className={`page-container ${screen === 'home' ? 'landing-main' : 'main-content'}`} id="main-content">
        {screen === 'home' ? <Suspense fallback={<p className="landing-loading" role="status">Loading PageAtlas…</p>}><HomePage /></Suspense> : <>
        <section className="intro" aria-labelledby="intro-heading">
          <p className="eyebrow"><Focus size={15} aria-hidden="true" /> Capture workspace</p>
          <h1 id="intro-heading">Capture your next page<span>.</span></h1>
          <p>Choose a website and screen size. Explore its pages, then export a visual review.</p>
        </section>

        {sessionId ? (
          <section className="capture-card" aria-labelledby="sign-in-heading" aria-busy={pending}>
            <div className="sign-in-panel">
              <div className="sign-in-copy">
                <h2 id="sign-in-heading" tabIndex={-1} ref={sessionHeadingRef}>Sign in to continue</h2>
                <ol>
                  <li>Sign in directly on the website in the temporary browser window and complete any security prompts.</li>
                  <li>Navigate to the page where you want the capture to start and leave that tab selected.</li>
                  <li>Return to PageAtlas and choose <strong>Capture signed-in page</strong>.</li>
                </ol>
                <p>The browser closes after capture, cancellation, or ten minutes. Reviews can include visible account data.</p>
              </div>
              <div className="sign-in-actions">
                <button type="button" className="capture-button" onClick={finishSignIn} disabled={pending}>
                  {activity === 'capture-signed-in' ? <LoaderCircle className="spinner" size={19} aria-hidden="true" /> : <Camera size={19} aria-hidden="true" />}
                  {activity === 'capture-signed-in' ? 'Capturing…' : 'Capture signed-in page'}
                </button>
                <button type="button" className="export-button" onClick={cancelSignIn} disabled={pending}>
                  {activity === 'cancel-sign-in' ? 'Closing…' : 'Cancel sign-in'}
                </button>
              </div>
            </div>
          </section>
        ) : (
          <form className="capture-card" onSubmit={startCapture} aria-label="Capture setup">
            <div className="capture-field">
              <label className="field-label" htmlFor="page-url">Website or web app URL</label>
              <div className="url-field">
                <Globe2 size={19} aria-hidden="true" />
                <input
                  id="page-url"
                  type="text"
                  inputMode="url"
                  autoComplete="url"
                  spellCheck={false}
                  required
                  maxLength={2048}
                  placeholder="https://example.com"
                  value={url}
                  aria-describedby="capture-hint"
                  disabled={pending}
                  onChange={(event) => changeUrl(event.currentTarget.value)}
                />
              </div>
            </div>
            <fieldset className="viewport-field" disabled={pending}>
              <legend className="field-label">Viewport</legend>
              <div className="viewport-options">
                {viewports.map(({ id, label, icon: Icon }) => {
                  const size = id === 'auto' ? windowSize : id === 'custom' ? { width: customWidth, height: customHeight } : presetSizes[id]
                  const dimensions = `${size.width} × ${size.height}`
                  return (
                  <label key={id} className="viewport-option" title={`${label} (${dimensions})`}>
                    <input type="radio" name="viewport" value={id} checked={viewport === id} onChange={() => {
                      clearCertificateRetry()
                      setViewport(id)
                    }} />
                    <span><Icon size={17} aria-hidden="true" />{label}<span className="sr-only"> ({dimensions} pixels)</span></span>
                  </label>
                  )
                })}
              </div>
              {viewport === 'auto' && <p className="viewport-mode-help">{windowSize.width} × {windowSize.height} pixels. Matches this browser’s visible page area; resize the window to change it.</p>}
              {viewport === 'custom' && <div className="custom-viewport">
                <label>Width (px)<input type="number" min={viewportLimits.minWidth} max={viewportLimits.maxWidth} step="1" required value={customWidth} onChange={event => { clearCertificateRetry(); setCustomWidth(event.currentTarget.value) }} /></label>
                <label>Height (px)<input type="number" min={viewportLimits.minHeight} max={viewportLimits.maxHeight} step="1" required value={customHeight} onChange={event => { clearCertificateRetry(); setCustomHeight(event.currentTarget.value) }} /></label>
              </div>}
              {viewport === 'mobile' && <p className="viewport-mode-help">Mobile captures each scroll position as a separate viewport screenshot.</p>}
            </fieldset>
            <div className="capture-options">
              <div className="capture-option">
                <label>
                  <input type="checkbox" checked={crawl} disabled={pending} aria-describedby="linked-pages-help" onChange={event => {
                    clearCertificateRetry()
                    setCrawl(event.currentTarget.checked)
                  }} />
                  <span>Capture linked pages</span>
                </label>
                <p id="linked-pages-help">Click navigation buttons and explore links, tabs, and menus. Up to 30 views can take a few minutes.</p>
              </div>
              <div className="capture-option">
                <label>
                  <input type="checkbox" checked={signIn} disabled={pending} aria-describedby="sign-in-help" onChange={event => {
                    clearCertificateRetry()
                    setSignIn(event.currentTarget.checked)
                  }} />
                  <span>Sign in, then capture</span>
                </label>
                <p id="sign-in-help">For pages that require an account.</p>
              </div>
              {developmentOrigin && (
                <div className="capture-option">
                  <label>
                    <input type="checkbox" checked={allowDevCertificate} disabled={pending} aria-describedby="dev-certificate-help" onChange={event => setAllowDevCertificate(event.currentTarget.checked)} />
                    <span>Allow local development certificate</span>
                  </label>
                  <p id="dev-certificate-help">Enable only for a development app running on this computer.</p>
                </div>
              )}
            </div>
            <button className="capture-button" type="submit" disabled={pending} ref={captureButtonRef}>
              {pending ? <LoaderCircle className="spinner" size={19} aria-hidden="true" /> : <Camera size={19} aria-hidden="true" />}
              {jobSyncing ? 'Checking capture…' : !jobsSynced ? 'Capture unavailable' : activeJob ? 'Capture in progress' : activity === 'open-sign-in' ? 'Opening browser…' : pending ? 'Starting capture…' : signIn ? 'Open sign-in window' : crawl ? 'Capture app pages' : 'Capture page'}
              {!pending && (signIn ? <ExternalLink size={17} aria-hidden="true" /> : <ArrowRight size={17} aria-hidden="true" />)}
            </button>
          </form>
        )}

        <div className="capture-status">
          <p id="capture-hint"><LockKeyhole size={14} aria-hidden="true" /> Captures run on this computer.</p>
          <p className="state-status" role="status">
            {progress || (sessionId ? 'Waiting for sign-in' : status && <><Check size={16} aria-hidden="true" /> {status}</>)}
          </p>
        </div>

        {jobConnectionError && (
          <div className="notice error-notice capture-error">
            <p role="alert"><CircleAlert size={18} aria-hidden="true" />{jobConnectionError}</p>
            <button type="button" className="export-button" disabled={jobSyncing} onClick={() => void syncCaptureJob()}>
              {jobSyncing ? 'Reconnecting…' : 'Reconnect'}
            </button>
          </div>
        )}
        {error && (
          <div className="notice error-notice capture-error">
            <p role="alert"><CircleAlert size={18} aria-hidden="true" />{error}</p>
            {certificateRetry && (
              <button type="button" className="export-button" disabled={pending} onClick={() => void requestCapture(certificateRetry, true)}>
                Allow local certificate and retry
              </button>
            )}
          </div>
        )}
        {job && <CaptureProgress key={job.id} job={job} stopping={stopping} onStop={() => void stopCapture()} />}
        {currentPage?.warnings.map((warning, index) => <p className="notice" key={`${index}-${warning}`}><CircleAlert size={18} aria-hidden="true" />{warning}</p>)}

        <section className="workspace" aria-labelledby="workspace-heading" aria-busy={pending}>
          <div className="workspace-toolbar">
            <div className="workspace-title">
              <span className="workspace-icon"><Maximize2 size={18} aria-hidden="true" /></span>
              <div>
                <h2 id="workspace-heading" title={currentPage?.title}>{currentPage?.title || 'Capture workspace'}</h2>
                <p>{previewSize ? `${previewSize.width.toLocaleString()} × ${previewSize.height.toLocaleString()} px · ${screenshotLabel}` : 'Page screenshots and structure map'}</p>
              </div>
            </div>
            {review && (
              <div className="workspace-actions">
                {scrollRegions.length > 0 && (
                  <a className="scroll-areas-link" href="#scroll-areas-heading">
                    {scrollRegions.length} {scrollRegions.length === 1 ? 'scroll area' : 'scroll areas'} ↓
                  </a>
                )}
                <button type="button" className="export-button" disabled={pending} onClick={() => void finishReview('pdf')} title="All captured page screenshots, without review controls or structure maps">
                  <ArrowDownToLine size={18} aria-hidden="true" /> {reviewAction === 'pdf' ? 'Creating PDF…' : 'Export all pages as PDF'}
                </button>
                <button type="button" className="export-button" disabled={pending} onClick={() => void finishReview('html')}>
                  <ArrowDownToLine size={18} aria-hidden="true" /> {reviewAction === 'export' ? 'Exporting…' : capturedPages.length > 1 ? 'Export all pages' : 'Export review'}
                </button>
                <button type="button" className="export-button" disabled={pending} onClick={() => void finishReview('delete')}>
                  <Check size={18} aria-hidden="true" /> {reviewAction === 'delete' ? 'Deleting…' : 'Done · delete review'}
                </button>
              </div>
            )}
          </div>

          {review && <p className="review-privacy">Temporary review · Exporting or choosing Done deletes screenshots, page details, and capture history from PageAtlas. Unfinished reviews expire after 15 minutes.</p>}

          {review?.exploration && <ExplorationSummary exploration={review.exploration} />}

          {review?.linkedPages && currentPage && (
            <div className="page-picker">
              <div className="page-picker-copy">
                <p className="page-picker-count">{capturedPages.length} {capturedPages.length === 1 ? 'page' : 'pages'} captured</p>
                <p>{capturedPages.length > 1 ? 'Each page has its own screenshot and structure map.' : 'Enter another page URL to capture it separately.'}</p>
              </div>
              {capturedPages.length > 1 && (
                <label className="page-picker-field">
                  <span className="field-label">Captured page</span>
                  <select value={currentPage.id} onChange={event => selectPage(event.currentTarget.value)}>
                    {capturedPages.map((page, index) => (
                      <option value={page.id} key={page.id}>
                        {String(index + 1).padStart(2, '0')} · {page.navigationLabel || page.title || `Page ${index + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}

          {currentShot && (
            <div className="page-picker shot-picker">
              <div className="page-picker-copy">
                <p className="page-picker-count" role="status">View {shotIndex + 1} of {viewportShots.length}</p>
                <p>Each scroll position keeps fixed navigation in its original place.</p>
              </div>
              <label className="page-picker-field">
                <span className="field-label">Scroll view</span>
                <select value={currentShot.id} onChange={event => selectShot(event.currentTarget.value)}>
                  {viewportShots.map((shot, index) => (
                    <option value={shot.id} key={shot.id}>{String(index + 1).padStart(2, '0')} · {shot.label || `View ${index + 1}`}</option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <div className="workspace-grid">
            <div className="preview-pane">
              {currentPage && previewSize ? (
                <div className="captured-preview" key={`${currentPage.id}-${currentShot?.id ?? 'page'}`}>
                  <div className="address-bar"><Globe2 size={15} aria-hidden="true" /><span title={currentPage.url}>{currentPage.url}</span></div>
                  {currentPage.viewportScreenshot && !currentShot && (
                    <ViewportReference capture={currentPage.viewportScreenshot} pageName={currentPage.title || currentPage.url} />
                  )}
                  <div className={`preview-scroll${currentShot ? ' viewport-shot-preview' : ''}`} ref={scrollRef} tabIndex={0} role="region" aria-label={screenshotLabel}>
                    {imageError ? (
                      <p className="notice error-notice"><CircleAlert size={18} aria-hidden="true" />The screenshot couldn’t load. Capture the page again to refresh it.</p>
                    ) : (
                      <div className="screenshot" style={{ maxWidth: previewSize.width, aspectRatio: `${previewSize.width} / ${previewSize.height}` }} ref={screenshotRef}>
                        <img
                          src={previewUrl}
                          width={previewSize.width}
                          height={previewSize.height}
                          alt={`${screenshotLabel} of ${currentPage.title || currentPage.url}${currentShot ? `, view ${shotIndex + 1} of ${viewportShots.length}` : ''}`}
                          onError={() => setImageError(true)}
                        />
                        {selectedSection && (
                          <span className="section-highlight" aria-hidden="true" style={{
                            left: `${selectedSection.x * 100 / previewSize.width}%`,
                            top: `${selectedSection.y * 100 / previewSize.height}%`,
                            width: `${selectedSection.width * 100 / previewSize.width}%`,
                            height: `${selectedSection.height * 100 / previewSize.height}%`,
                          }} />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ) : <EmptyPreview />}
            </div>
            <StructurePanel key={`${currentPage?.id}-${currentShot?.id ?? 'page'}`} review={currentPage ? { sections: previewSections } : null} selected={selected} onSelect={selectSection} />
          </div>
          {review && <nav className="capture-gallery" aria-label="Captured page gallery">
            <div className="gallery-heading">
              <h3>All captured pages</h3>
              <span className="count-badge">{capturedPages.length}</span>
            </div>
            <ol className="gallery-strip">
              {capturedPages.map((page, index) => {
                const name = page.navigationLabel || page.title || `Page ${index + 1}`
                return <li key={page.id}>
                  <button type="button" className="gallery-thumbnail" aria-label={`View page ${index + 1}: ${name}`} aria-pressed={currentPage?.id === page.id} onClick={() => {
                    selectPage(page.id)
                    setViewerPageId(page.id)
                  }}>
                    <img src={page.viewportShots?.[0]?.screenshotUrl ?? page.screenshotUrl} alt="" loading="lazy" decoding="async" />
                    <span className="gallery-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                    <span className="gallery-caption" aria-hidden="true">{name}</span>
                  </button>
                </li>
              })}
            </ol>
          </nav>}
        </section>

        {currentPage && !currentShot && (
          <section className="workspace scroll-areas" aria-labelledby="scroll-areas-heading" aria-busy={pending}>
            <div className="workspace-toolbar">
              <div className="workspace-title">
                <span className="workspace-icon"><MoveVertical size={18} aria-hidden="true" /></span>
                <div>
                  <h2 id="scroll-areas-heading" tabIndex={-1}>Independently scrolling areas</h2>
                  <p>Open a capture to review content inside its own scroll area.</p>
                </div>
              </div>
              <span className="count-badge" aria-label={`${scrollRegions.length} captured scroll areas`}>{scrollRegions.length}</span>
            </div>
            {scrollRegions.length ? (
              <div className="scroll-area-list">
                {scrollRegions.map((region) => <ScrollArea key={`${currentPage.id}-${region.id}`} region={region} />)}
              </div>
            ) : <p className="scroll-area-empty">This review has no separate scroll area captures.</p>}
          </section>
        )}

        </>}
        <footer className="app-footer">
          <div className="footer-main">
            <div className="footer-product">
              <a className="footer-brand" href="#home"><span className="footer-brand-mark"><Layers3 size={22} aria-hidden="true" /></span> PageAtlas</a>
              <p>A clearer view of every page. Built for the details that matter.</p>
              <span className="footer-status"><span className="footer-status-dot" aria-hidden="true" /> Runs locally on your computer</span>
            </div>
            <nav className="footer-nav" aria-label="Footer navigation">
              <p className="footer-credit-label">Explore</p>
              <div><a href="#home">Home <ChevronRight size={14} aria-hidden="true" /></a><a href="#capture">Capture workspace <ChevronRight size={14} aria-hidden="true" /></a></div>
            </nav>
            <div className="developer-credit">
              <p className="footer-credit-label">Made by</p>
              <a href="https://www.facebook.com/Pongki23/" target="_blank" rel="noopener noreferrer"><span className="developer-avatar" aria-hidden="true">AP</span><span className="developer-name">Alfonso A. Panisales<small>Designer & developer · Connect on Facebook</small></span><ArrowRight size={17} aria-hidden="true" /><span className="sr-only"> (Facebook, opens in a new tab)</span></a>
            </div>
          </div>
          <div className="footer-bottom">
            <span className="footer-privacy"><LockKeyhole size={13} aria-hidden="true" /> Temporary captures. Your exports to keep.</span>
            <div className="footer-bottom-end">
              <p className="footer-copyright">© {new Date().getFullYear()} PageAtlas</p>
              <button type="button" className="footer-top" onClick={() => window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })}>Back to top <ArrowRight size={13} aria-hidden="true" /></button>
            </div>
          </div>
        </footer>
      </main>
      {review && viewerPageId && <CaptureViewer key={review.id} pages={capturedPages} initialPageId={viewerPageId} onClose={() => setViewerPageId(null)} onSelect={(pageId, shotId) => {
        selectPage(pageId)
        setSelectedShotId(shotId ?? null)
      }} />}
    </div>
  )
}
