import { ArchiveX, ArrowRight, Camera, Check, ChevronDown, ChevronRight, FileDown, Focus, Globe2, Layers3, LockKeyhole, Monitor, Smartphone, Timer } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import reviewDark from './assets/review-preview-dark.png?inline'
import reviewLight from './assets/review-preview-light.png?inline'
import './HomePage.css'

function ProductPreview() {
  const [step, setStep] = useState<'capture' | 'review' | 'export'>('capture')
  return <div className="landing-demo product-preview">
    <div className="product-preview-header"><span><Layers3 size={19} aria-hidden="true" /> PageAtlas</span><span className="preview-label">Product tour</span></div>
    <div className="preview-steps" role="group" aria-label="Explore the PageAtlas workflow">
      {(['capture', 'review', 'export'] as const).map((value, index) => <button key={value} type="button" aria-pressed={step === value} onClick={() => setStep(value)}><span>{String(index + 1).padStart(2, '0')}</span>{value === 'capture' ? 'Capture' : value === 'review' ? 'Review' : 'Export'}</button>)}
    </div>
    <div className="preview-tour-content" key={step}>
      {step === 'capture' ? <>
        <div className="preview-pane-heading"><span className="preview-overline">Start with a URL</span><h2>Your website. Your screen size.</h2><p>Set up a capture in a few simple choices.</p></div>
        <div className="preview-url"><Globe2 size={17} aria-hidden="true" /><span>https://your-site.com</span></div>
        <div className="preview-devices"><span><Monitor size={17} aria-hidden="true" /> Desktop</span><span><Smartphone size={17} aria-hidden="true" /> Mobile</span><span><Focus size={17} aria-hidden="true" /> Custom</span></div>
        <div className="preview-setting"><span><Check size={14} aria-hidden="true" /></span><div><strong>Capture linked pages</strong><p>Keep related screens in one review.</p></div></div>
        <a className="preview-action" href="#capture"><Camera size={16} aria-hidden="true" /> Open capture workspace <ArrowRight size={16} aria-hidden="true" /></a>
      </> : step === 'review' ? <>
        <div className="preview-pane-heading"><span className="preview-overline">The details, in view</span><h2>A page. Its structure. All together.</h2><p>A sample review of the PageAtlas homepage.</p></div>
        <div className="preview-review-image"><img className="workspace-preview-dark" src={reviewDark} width="1392" height="820" alt="Actual PageAtlas review panels with a screenshot on the left and the page structure on the right" fetchPriority="high" /><img className="workspace-preview-light" src={reviewLight} width="1392" height="820" alt="Actual PageAtlas review panels with a screenshot on the left and the page structure on the right" fetchPriority="high" /></div>
        <div className="preview-review-note"><span><Focus size={14} aria-hidden="true" /> Full-size image viewer</span><span><Layers3 size={14} aria-hidden="true" /> Page-by-page gallery</span></div>
      </> : <>
        <div className="preview-pane-heading"><span className="preview-overline">Ready to share</span><h2>Keep the format that fits.</h2><p>Your review travels with you, even offline.</p></div>
        <div className="preview-formats"><div><span className="format-file">PDF</span><h3>Just the screenshots</h3><p>Each captured image on its own page, ready to share.</p></div><div><span className="format-file">HTML</span><h3>The complete review</h3><p>Screenshots, page navigation, and structure maps in one file.</p></div></div>
        <div className="preview-export-note"><LockKeyhole size={17} aria-hidden="true" /><p>Exporting clears the temporary review.<br /><strong>Your downloaded file is yours to keep.</strong></p></div>
      </>}
    </div>
    <div className="preview-tour-footer"><span><span className="preview-status-dot" /> Built for visual reviews</span><button type="button" onClick={() => setStep(step === 'capture' ? 'review' : step === 'review' ? 'export' : 'capture')}>{step === 'export' ? 'Back to capture' : 'Next step'}<ArrowRight size={15} aria-hidden="true" /></button></div>
  </div>
}

const panelLabels = ['Overview', 'Features', 'How it works', 'Privacy', 'FAQ', 'Get started']
const ease = (t: number) => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
// Eased one-section-per-gesture scrolling for large screens with a mouse or trackpad.
const guidedScrollQuery = '(min-width: 1101px) and (min-height: 701px) and (pointer: fine) and (prefers-reduced-motion: no-preference)'

export default function HomePage() {
  const landingRef = useRef<HTMLDivElement>(null)
  const [activePanel, setActivePanel] = useState(0)
  const scrollTo = useRef<(index: number) => void>(() => {})
  const goToPanel = (index: number) => scrollTo.current(index)

  useEffect(() => {
    const root = landingRef.current
    if (!root) return
    const panels = Array.from(root.querySelectorAll<HTMLElement>('.landing-panel'))
    const guided = window.matchMedia(guidedScrollQuery)
    const maxScroll = () => document.documentElement.scrollHeight - window.innerHeight
    // Hero aligns to the top of the page (with the header); the closing panel shares the last screen with the footer.
    const targets = () => panels.map((panel, index) => index === 0 ? 0 : index === panels.length - 1 ? maxScroll() : Math.min(maxScroll(), panel.getBoundingClientRect().top + window.scrollY))
    let frame = 0
    let animating = false
    let lastWheel = 0
    let wheelSum = 0

    const animateTo = (top: number) => {
      cancelAnimationFrame(frame)
      const start = window.scrollY
      const distance = top - start
      if (Math.abs(distance) < 2) return
      const duration = Math.min(1100, 650 + Math.abs(distance) * .25)
      const began = performance.now()
      animating = true
      const step = (now: number) => {
        const t = Math.min(1, (now - began) / duration)
        window.scrollTo({ top: start + distance * ease(t), behavior: 'instant' })
        if (t < 1) frame = requestAnimationFrame(step)
        else animating = false
      }
      frame = requestAnimationFrame(step)
    }
    scrollTo.current = index => {
      const top = targets()[index]
      if (top === undefined) return
      if (guided.matches) animateTo(top)
      else window.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    }

    // Returns the scroll target in the given direction, or null when native scrolling should continue
    // (inside a section taller than the screen).
    const nextTarget = (direction: 1 | -1) => {
      const y = window.scrollY
      // Allow moves that would leave only a sliver of the current section unseen.
      const reach = window.innerHeight + Math.min(160, window.innerHeight * .18)
      const list = targets()
      if (direction > 0) {
        const next = list.find(top => top > y + 2)
        if (next === undefined) return null
        return next - y > reach ? null : next
      }
      const previous = [...list].reverse().find(top => top < y - 2)
      if (previous === undefined) return null
      return y - previous > reach ? null : previous
    }

    const onWheel = (event: WheelEvent) => {
      if (!guided.matches || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      const now = performance.now()
      const quiet = now - lastWheel > 180
      lastWheel = now
      const direction = event.deltaY > 0 ? 1 : -1
      // Wait for trackpad momentum to settle before starting the next section move.
      if (animating) { event.preventDefault(); return }
      if (quiet) wheelSum = 0
      const target = nextTarget(direction)
      if (target === null) return
      event.preventDefault()
      wheelSum += event.deltaY
      if (Math.abs(wheelSum) < 30 && !quiet) return
      if (Math.abs(wheelSum) < 4) return
      wheelSum = 0
      animateTo(target)
    }

    const onKey = (event: KeyboardEvent) => {
      if (!guided.matches || event.altKey || event.ctrlKey || event.metaKey) return
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return
      const keys: Record<string, 1 | -1> = { PageDown: 1, ArrowDown: 1, PageUp: -1, ArrowUp: -1 }
      if (event.key === ' ' && !target.closest('button, a, summary')) keys[' '] = event.shiftKey ? -1 : 1
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        animateTo(event.key === 'Home' ? 0 : maxScroll())
        return
      }
      const direction = keys[event.key]
      if (!direction) return
      if (animating) { event.preventDefault(); return }
      const next = nextTarget(direction)
      if (next === null) return
      event.preventDefault()
      animateTo(next)
    }

    const stop = () => { cancelAnimationFrame(frame); animating = false }
    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey)
    window.addEventListener('touchstart', stop, { passive: true })
    window.addEventListener('mousedown', stop)

    let observer: IntersectionObserver | undefined
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) setActivePanel(panels.indexOf(entry.target as HTMLElement))
      }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 })
      panels.forEach(panel => observer!.observe(panel))
    }
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('touchstart', stop)
      window.removeEventListener('mousedown', stop)
    }
  }, [])

  useEffect(() => {
    const root = landingRef.current
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (!root || motion.matches || !('IntersectionObserver' in window)) return
    const targets = Array.from(root.querySelectorAll<HTMLElement>('.landing-section-title, .landing-card-grid article, .landing-steps li, .landing-privacy, .landing-faq details, .landing-final'))
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('is-visible')
        observer.unobserve(entry.target)
      }
    }, { threshold: .08, rootMargin: '0px 0px -24px 0px' })
    targets.forEach(element => {
      element.classList.add('landing-reveal')
      if (element.matches('article, li')) element.style.setProperty('--reveal-delay', `${Array.from(element.parentElement!.children).indexOf(element) * 90}ms`)
      observer.observe(element)
    })
    const panels = Array.from(root.querySelectorAll<HTMLElement>('.landing-panel'))
    panels[0]?.classList.add('is-active')
    const panelObserver = new IntersectionObserver(entries => {
      for (const entry of entries) entry.target.classList.toggle('is-active', entry.isIntersecting)
    }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 })
    panels.forEach(panel => panelObserver.observe(panel))
    root.dataset.motion = 'ready'
    const stopMotion = () => {
      if (!motion.matches) return
      delete root.dataset.motion
      observer.disconnect()
      panelObserver.disconnect()
    }
    motion.addEventListener('change', stopMotion)
    return () => { observer.disconnect(); panelObserver.disconnect(); motion.removeEventListener('change', stopMotion); delete root.dataset.motion }
  }, [])
  return <div className="landing" ref={landingRef}>
    <nav className="landing-dots" aria-label="Page sections">
      {panelLabels.map((label, index) => <button key={label} type="button" aria-current={activePanel === index ? 'true' : undefined} onClick={() => goToPanel(index)}><span className="landing-dot-label">{label}</span><span className="landing-dot" aria-hidden="true" /></button>)}
    </nav>
    <section className="landing-panel landing-hero" aria-labelledby="home-heading">
      <div className="landing-hero-copy">
        <p className="eyebrow"><Focus size={15} aria-hidden="true" /> Website & web app capture</p>
        <h1 id="home-heading">Every page.<br />One clear <span>picture.</span></h1>
        <p className="landing-lead">Turn websites into visual reviews you can explore and share. Capture linked pages, compare layouts, and keep the screens that matter.</p>
        <div className="landing-actions">
          <a className="landing-button landing-primary" href="#capture">Start capturing <ArrowRight size={18} aria-hidden="true" /></a>
          <a className="landing-text-link" href="#how-it-works">See how it works <ChevronRight size={16} aria-hidden="true" /></a>
        </div>
        <div className="landing-benefits"><span><Check size={15} aria-hidden="true" /> Desktop to mobile</span><span><Check size={15} aria-hidden="true" /> HTML & PDF exports</span><span><Check size={15} aria-hidden="true" /> Runs locally</span></div>
      </div>
      <ProductPreview />
      <a className="landing-scroll-cue" href="#features" onClick={event => { event.preventDefault(); goToPanel(1) }}><span>Scroll to explore</span><ChevronDown size={16} aria-hidden="true" /></a>
    </section>

    <section className="landing-panel landing-features" id="features" aria-labelledby="features-heading">
      <div className="landing-section-title"><p className="landing-kicker">A clearer way to review</p><h2 id="features-heading">From browsing to the bigger picture.</h2><p>For designers, developers, and anyone who needs to show how a website looks.</p></div>
      <div className="landing-card-grid">
        <article><span className="landing-feature-icon"><Layers3 size={23} /></span><h3>Explore beyond the first page</h3><p>Discover linked pages, navigation menus, tabs, and dialogs. Keep related screens together in one review.</p></article>
        <article><span className="landing-feature-icon"><Monitor size={23} /></span><h3>See it at the right size</h3><p>Match your current window, choose a device preset, or enter custom dimensions to review responsive layouts.</p></article>
        <article><span className="landing-feature-icon"><FileDown size={23} /></span><h3>Share something useful</h3><p>Export an interactive HTML review or a PDF of captured screenshots. Your files open without PageAtlas.</p></article>
      </div>
    </section>

    <section className="landing-panel landing-how" id="how-it-works" aria-labelledby="how-heading">
      <div className="landing-section-title"><p className="landing-kicker">Three simple steps</p><h2 id="how-heading">A URL is all you need to start.</h2><p>No setup and no account. Pick a page, look around, and take the review with you.</p></div>
      <ol className="landing-steps">
        <li><span>01</span><h3>Choose your view</h3><p>Paste a website address and pick a capture size. Use the temporary sign-in browser for pages that need an account.</p></li>
        <li><span>02</span><h3>Look around</h3><p>Browse the gallery, open screenshots in the image viewer, and use the structure map to find the details.</p></li>
        <li><span>03</span><h3>Export and move on</h3><p>Download HTML or PDF. Exporting or choosing Done clears the temporary review and its capture history.</p></li>
      </ol>
    </section>

    <section className="landing-panel" aria-labelledby="privacy-heading"><div className="landing-privacy">
      <div className="landing-privacy-copy"><span className="landing-feature-icon"><LockKeyhole size={24} /></span><p className="landing-kicker">Useful captures. Temporary storage.</p><h2 id="privacy-heading">Keep your exports.<br />Leave the clutter behind.</h2><p>PageAtlas runs on your computer and holds just the current review in temporary memory. It clears that review after export or when you choose Done. Unfinished reviews expire after 15 minutes.</p><p className="landing-privacy-note">Screenshots can include visible account details. Downloaded files stay on your device.</p></div>
      <ul className="landing-privacy-points">
        <li><span><ArchiveX size={19} aria-hidden="true" /></span><div><strong>No review archive</strong><p>Reviews live in temporary memory, never in a saved history.</p></div></li>
        <li><span><Timer size={19} aria-hidden="true" /></span><div><strong>Sign-in browser closes</strong><p>It shuts after capture, cancellation, or ten minutes.</p></div></li>
        <li><span><FileDown size={19} aria-hidden="true" /></span><div><strong>Exports are yours</strong><p>Keep HTML or PDF files wherever you like. They work offline.</p></div></li>
      </ul>
    </div></section>

    <section className="landing-panel landing-faq" aria-labelledby="faq-heading"><div className="landing-section-title"><p className="landing-kicker">Good to know</p><h2 id="faq-heading">A few things before you capture.</h2><p>Still curious? Open the capture workspace and try it on your own site. Nothing is saved after you finish.</p></div>
      <div className="landing-faq-list">
      <details><summary>Can I capture a web app that requires sign-in?</summary><p>Yes. Choose “Sign in, then capture” in the workspace. Sign in directly in the temporary browser, navigate to the page you want, and return to PageAtlas to begin.</p></details>
      <details><summary>Will it capture every page automatically?</summary><p>Linked-page capture explores links and supported navigation controls, up to 30 views within its time and size limits. Access permissions, loading states, and unsupported interactions can limit coverage. Capture notes show what was skipped.</p></details>
      <details><summary>What is the difference between HTML and PDF?</summary><p>HTML includes the review, structure maps, and navigation between pages. PDF includes only captured screenshots, with each image fitted to its own sheet. Both formats work offline.</p></details>
      </div>
    </section>

    <section className="landing-panel" aria-labelledby="final-heading"><div className="landing-final"><span className="landing-feature-icon"><Camera size={23} aria-hidden="true" /></span><h2 id="final-heading">Your next review starts here.</h2><p>Open a page. See the details. Share the picture.</p><a className="landing-button landing-primary" href="#capture">Open capture workspace <ArrowRight size={18} aria-hidden="true" /></a><div className="landing-benefits"><span><Check size={15} aria-hidden="true" /> HTML &amp; PDF exports</span><span><Check size={15} aria-hidden="true" /> No account needed</span><span><Check size={15} aria-hidden="true" /> Runs locally</span></div></div></section>
  </div>
}
