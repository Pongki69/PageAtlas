import {
  ArrowDownToLine, ArrowRight, Camera, Check, ChevronRight, CircleAlert, ExternalLink,
  Focus, Globe2, Layers3, ListTree, LoaderCircle, LockKeyhole, Maximize2, MoveVertical,
  Monitor, Moon, Smartphone, Sun, Tablet, Target,
} from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import './index.css'

const viewports = [
  { id: 'desktop', label: 'Desktop', dimensions: '1440 × 900', icon: Monitor },
  { id: 'tablet', label: 'Tablet', dimensions: '768 × 1024', icon: Tablet },
  { id: 'mobile', label: 'Mobile', dimensions: '390 × 844', icon: Smartphone },
] as const

type Viewport = typeof viewports[number]['id']
type Theme = 'light' | 'dark'
type CaptureActivity = 'capture' | 'open-sign-in' | 'capture-signed-in' | 'cancel-sign-in'
type CaptureTarget = { url: string; viewport: Viewport; signIn: boolean; crawl: boolean }

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

export default function App() {
  const [theme, setTheme] = useState(initialTheme)
  const [url, setUrl] = useState('')
  const [allowDevCertificate, setAllowDevCertificate] = useState(false)
  const [viewport, setViewport] = useState<Viewport>('desktop')
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
  const sessionHeadingRef = useRef<HTMLHeadingElement>(null)
  const captureButtonRef = useRef<HTMLButtonElement>(null)
  const hadSession = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const screenshotRef = useRef<HTMLDivElement>(null)
  const pending = activity !== null
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
  const progress = activity && (crawl && (activity === 'capture' || activity === 'capture-signed-in')
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

    void requestCapture({ url: target, viewport, signIn, crawl }, Boolean(developmentOrigin && allowDevCertificate))
  }

  async function requestCapture(target: CaptureTarget, useDevCertificate: boolean) {
    if (pending || sessionId) return

    setCertificateRetry(null)
    setStatus('')
    setError('')
    setActivity(target.signIn ? 'open-sign-in' : 'capture')
    try {
      const response = await fetch(target.signIn ? '/api/sign-in' : '/api/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target.url, viewport: target.viewport, crawl: target.crawl, allowDevCertificate: useDevCertificate }),
      })
      if (!response.ok) {
        const failure = await responseFailure(response, 'The capture service is unavailable. Try again in a moment.')
        setError(failure.message)
        if (!useDevCertificate && failure.code === 'LOCAL_DEV_CERTIFICATE_REQUIRED') setCertificateRetry(target)
        return
      }
      if (target.signIn) {
        const result: { id: string } = await response.json()
        setSessionId(result.id)
      } else {
        showReview(await response.json())
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
      const response = await fetch(`/api/sign-in/${encodeURIComponent(sessionId)}/capture`, { method: 'POST' })
      if (!response.ok) {
        setError((await responseFailure(response, 'Couldn’t capture the signed-in page. Try again.')).message)
        if (response.status !== 409 && response.status !== 429) setSessionId(null)
        return
      }
      setSessionId(null)
      showReview(await response.json())
    } catch {
      setError('Couldn’t reach the capture service. Check that PageAtlas is running and try again.')
    } finally {
      setActivity(null)
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
      <a className="skip-link" href="#main-content">Skip to capture</a>
      <header className="app-header">
        <div className="page-container header-content">
          <div className="brand">
            <span className="brand-mark"><Layers3 size={21} strokeWidth={2.2} aria-hidden="true" /></span>
            <span>PageAtlas</span>
            <span className="brand-context">Design review</span>
          </div>
          <div className="header-actions">
            <span className="local-indicator"><span aria-hidden="true" /> Local workspace</span>
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

      <main className="page-container main-content" id="main-content">
        <section className="intro" aria-labelledby="intro-heading">
          <p className="eyebrow"><Focus size={15} aria-hidden="true" /> Visual page audit</p>
          <h1 id="intro-heading">See the whole page<span>.</span></h1>
          <p>Capture page designs, explore their structure, and export a review you can share.</p>
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
                {viewports.map(({ id, label, dimensions, icon: Icon }) => (
                  <label key={id} className="viewport-option" title={`${label} (${dimensions})`}>
                    <input type="radio" name="viewport" value={id} checked={viewport === id} onChange={() => {
                      clearCertificateRetry()
                      setViewport(id)
                    }} />
                    <span><Icon size={17} aria-hidden="true" />{label}<span className="sr-only"> ({dimensions} pixels)</span></span>
                  </label>
                ))}
              </div>
              {viewport === 'mobile' && <p className="viewport-mode-help">Mobile captures each scroll position as a separate viewport screenshot.</p>}
            </fieldset>
            <div>
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
              {activity === 'open-sign-in' ? 'Opening browser…' : pending ? 'Capturing…' : signIn ? 'Open sign-in window' : crawl ? 'Capture app pages' : 'Capture page'}
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
                <a className="export-button" href={`/api/reviews/${encodeURIComponent(review.id)}/export`} download>
                  <ArrowDownToLine size={18} aria-hidden="true" /> {capturedPages.length > 1 ? 'Export all pages' : 'Export review'}
                </a>
              </div>
            )}
          </div>

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

        <footer className="app-footer">
          <span><Layers3 size={15} aria-hidden="true" /> PageAtlas</span>
          <p>Each review exports as one self-contained HTML file.</p>
        </footer>
      </main>
    </div>
  )
}
