# PageAtlas

PageAtlas captures a website or browser-based app and turns it into a design review. Mobile reviews contain individual viewport screenshots taken while scrolling each page. Desktop and tablet reviews use full-page screenshots. Export the review as one HTML file that opens offline in a browser.

## Run on Windows

Install Node.js 22.18 or newer and use an installed copy of Microsoft Edge or Google Chrome. Open PowerShell in this folder and run the following commands.

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd start
```

Open [PageAtlas](http://127.0.0.1:4317) and leave the PowerShell window open while you use it. For development, `npm.cmd run dev` starts the app with live updates. To use another Chromium executable, set `PAGEATLAS_BROWSER` to its path before starting.

## Capture and export

1. Paste a public HTTP or HTTPS URL, or use the URL printed by a dev server running on this computer. PageAtlas accepts `localhost` and IP addresses assigned to this computer. For an HTTPS dev server you recognize, select **Allow local development certificate** or choose **Allow local certificate and retry** if a certificate error appears.
2. Choose Desktop (1440 × 900), Tablet (768 × 1024), or Mobile (390 × 844). Turn on **Capture linked pages** to include the app's navigation, then start the capture.
3. Use **Captured page** to switch screens. In Mobile mode, choose **Scroll view** to inspect each viewport and its structure map. Desktop and tablet captures include separate independently scrolling areas.
4. Export the review to one `.html` file. Multi-page exports include a page index and work offline.

Linked-page mode uses browser HTML and accessibility semantics to discover navigation across frameworks. It follows links, button-styled links, explicit route attributes, and bounded view queries. It also explores recognizable navigation buttons, tabs, and menu disclosures, including views that change without a new URL. It captures up to 30 views within its time and image-size limits and attempts up to 24 navigation controls. The review reports skipped controls and limit warnings. Coverage depends on the controls the site exposes and the pages accessible to the current account.

During control exploration, PageAtlas blocks data-changing HTTP requests and intercepts new windows. Forms and controls that appear to save, delete, pay, or submit are excluded from exploration. Apps that need an unsupported interaction or a write request to reveal a screen can produce a skipped-control notice.

Mobile mode scrolls down the document, main app panel, and independently scrollable cards. It records up to 30 viewport screenshots per page, with overlapping scroll positions for continuity. Sticky headers, floating controls, and bottom navigation appear in their actual positions in each view. The export groups these independent images in order under each captured page.

Before each page and scroll view, PageAtlas waits for visible loading indicators to clear, images and fonts to finish, and content to settle. Persistent loading produces a retry notice or a skipped-page warning. A mobile sequence can stop with a warning after its completed views if the next view stays loading.

For desktop and tablet captures, detected pinned bottom navigation is preserved in **Original viewport**. The full-page screenshot shows the underlying page content with the bottom overlay removed.

The structure map uses visible HTML headings and landmarks and can infer layout blocks on pages that lack them. The service keeps up to five recent reviews in memory and can remove older reviews to make room for large captures. Public captures expire after an hour, and signed-in captures expire after 15 minutes. Save the exported file to keep a review.

PageAtlas examines up to six scroll areas from the main document, including horizontal and vertical overflow. Mobile mode includes those areas as labeled viewport steps. Desktop and tablet modes assemble separate panel images. The review flags capture limits and skipped areas. Long or continuously loading panels can exceed those limits.

Desktop and tablet panels share a 25-second capture allowance, up to 96 tiles, and a 12-megapixel limit per image. PageAtlas retries once when lazy content changes a panel's dimensions. A partial panel shows its captured size, full content size, and the specific reason capture stopped.

## Capture a page that requires sign-in

1. Enter the site's HTTPS address, choose a viewport, and select **Sign in, then capture**. Turn on **Capture linked pages** if you want a multi-page review.
2. Open the temporary browser window from PageAtlas. Check the address, then sign in directly on the site and complete any verification it requires.
3. Navigate to the page you want and leave that tab active. Return to PageAtlas and select **Capture signed-in page**.

The temporary browser closes after a capture, cancellation, or 10 minutes of waiting. PageAtlas uses that browser's session for the capture. The exported source shows the site's origin so the page path and URL parameters stay out of the review metadata. Screenshots, headings, and exported files can contain visible account information.
