<p align="center">
  <img src="public/favicon.svg" width="88" height="88" alt="PageAtlas logo">
</p>

<h1 align="center">PageAtlas</h1>

<p align="center"><strong>Capture a website or web app and turn it into a visual design review.</strong></p>

<p align="center">
  <a href="#-quick-start">Quick start</a> ·
  <a href="#-features">Features</a> ·
  <a href="#-using-pageatlas">Using PageAtlas</a> ·
  <a href="#-host-it-online">Host it online</a> ·
  <a href="#-troubleshooting">Troubleshooting</a>
</p>

<p align="center">
  <img src="src/assets/review-preview-dark.png" width="760" alt="A PageAtlas review with a page screenshot on the left and its structure map on the right">
</p>

---

## ✨ Features

- **Full-page and mobile screenshots.** Desktop and tablet reviews use full-page screenshots. Mobile reviews take a screenshot at each scroll position.
- **Explores your app for you.** PageAtlas follows links and clicks tabs, menus, and navigation buttons to capture up to 30 views.
- **Structure map.** Each page shows its headings, landmarks, and layout blocks next to the screenshot.
- **Pages behind a sign-in.** Sign in through a temporary browser window, then capture what you see.
- **Offline export.** Download the review as one HTML file that opens without internet, or as a PDF of the screenshots.
- **Private by default.** Reviews stay in memory and are deleted after export or after 15 minutes.

## 🚀 Quick start

You need [Node.js 22.18+](https://nodejs.org) and Microsoft Edge or Google Chrome.

```sh
git clone https://github.com/Pongki69/PageAtlas.git
cd PageAtlas
npm ci && npm run build && npm start
```

Then open **[http://127.0.0.1:4317](http://127.0.0.1:4317)**. On Windows you can double-click **Start PageAtlas.bat** instead.

---

## 💻 Set it up on your computer

Running PageAtlas on your computer gives you every feature, including captures of local dev servers and signed-in pages. Your captures never leave your computer.

### Step 1: Install what PageAtlas needs

| Requirement | Notes |
| --- | --- |
| **Node.js 22.18 or newer** | Download the LTS version from [nodejs.org](https://nodejs.org). Check with `node --version`. |
| **Microsoft Edge or Google Chrome** | PageAtlas uses the browser you already have to take screenshots. Edge comes with Windows. |
| **Git** *(optional)* | To download and update the code. You can download a ZIP instead. |

### Step 2: Download PageAtlas

- **With Git:** run `git clone https://github.com/Pongki69/PageAtlas.git`.
- **Without Git:** choose **Code → Download ZIP** on the [repository page](https://github.com/Pongki69/PageAtlas), then extract it.

### Step 3: Start it

**Windows:** double-click **Start PageAtlas.bat** in the PageAtlas folder. The first start installs and builds the app, which takes a minute or two. Your browser opens when it's ready.

| Launcher option | What it does |
| --- | --- |
| **1. Start / open** | Starts PageAtlas, or opens it if it's already running. |
| **2. Restart server with the latest changes** | Rebuilds and restarts after you update the code. |
| **3. Stop server** | Stops PageAtlas. |
| **4. Close this menu** | Closes the menu. PageAtlas keeps running in the background. |

**Any system (Windows, macOS, Linux):** run these commands in the PageAtlas folder, and keep the terminal open while you use it.

```sh
npm ci
npm run build
npm start
```

> [!TIP]
> If Windows PowerShell blocks `npm`, type `npm.cmd` instead.

### Step 4: Open the app

Go to **[http://127.0.0.1:4317](http://127.0.0.1:4317)** and choose **Start capturing**. Bookmark `http://127.0.0.1:4317/#capture` to open the workspace directly.

### Updating

Run `git pull` (or download a new ZIP), then choose **2. Restart server with the latest changes**, or run `npm ci`, `npm run build`, and `npm start` again.

> [!WARNING]
> Stopping or restarting PageAtlas clears captures in progress and unsaved reviews. Export anything you want to keep first.

---

## 📸 Using PageAtlas

### Capture a page

1. **Paste a web address.** Any public HTTP or HTTPS address works, and so do dev servers running on your computer, such as `localhost`.
2. **Choose a screen size.** See the table below.
3. **Choose what to capture.** **Capture linked pages** is on by default and explores the app. Turn it off to capture a single page.
4. **Start the capture.** A progress panel shows the current step, page and screenshot counts, and a live activity log. You can refresh the page or select **Stop capture** at any time.
5. **Review the result.** Use **Captured page** to switch pages. In mobile mode, choose **Scroll view** to step through each screenshot.

| Screen size | Dimensions |
| --- | --- |
| **Current screen** *(default)* | Matches the visible area of your PageAtlas window. Resize the window to change it. |
| **Desktop** | 1920 × 1080 (Full HD) |
| **Tablet** | 768 × 1024 |
| **Mobile** | 390 × 844, with one screenshot per scroll position |
| **Custom** | Any width and height you enter |

Sizes are in browser layout pixels. The size stays the same for the whole capture, including sign-in and linked pages.

> [!NOTE]
> For an HTTPS dev server that uses its own certificate, select **Allow local development certificate**, or choose **Allow local certificate and retry** if a certificate error appears.

### Export a review

| Format | What you get |
| --- | --- |
| **HTML** | One file that works offline, with screenshots, structure maps, scrollable areas, and capture notes. Multi-page reviews start with a summary and a page index, and each page has **Previous / All pages / Next** links. Prints with each page on a new sheet. |
| **PDF** | Only the screenshots, in order, each on its own portrait or landscape sheet without cropping. No controls, structure maps, addresses, or notes. |

> [!IMPORTANT]
> Exporting deletes the review from PageAtlas, so pick HTML or PDF first. Choose **Done · delete review** to remove a review without exporting.

### Capture a page that requires sign-in

1. Enter the site's HTTPS address, choose a screen size, and select **Sign in, then capture**.
2. Open the temporary browser window. Check the address, then sign in on the site and complete any verification.
3. Go to the page you want and leave that tab active. Back in PageAtlas, select **Capture signed-in page**.

The temporary browser closes after the capture, when you cancel, or after 10 minutes. Exported reviews show only the site's origin, not the page path or URL parameters.

> [!CAUTION]
> Screenshots and exported files can show account information that's visible on the page.

### Privacy and storage

- Reviews live only in memory. Nothing is saved to a server archive.
- PageAtlas keeps only your current review. A new capture replaces it.
- Exporting, choosing **Done**, or 15 minutes without exporting deletes the review and its screenshots.
- Activity logs never include addresses or page content.
- One capture runs at a time, including across browser tabs.

<details>
<summary><strong>🔍 How capture works</strong> (technical details)</summary>

#### Exploring linked pages

- Finds navigation using HTML and accessibility semantics, so it works across frameworks.
- Follows links, button-styled links, route attributes, and simple URL queries.
- Clicks visible non-action buttons, tabs, and menus, including views that change without a new URL.
- Stays inside an open dialog while one is showing, and captures shared dialogs only once.
- Replays earlier navigation steps when needed, checking both the view and its URL before clicking.
- Captures up to **30 views** and tries up to **48 navigation controls**, within time and image-size limits.
- The review lists discovered controls, click counts, and the reason each control was skipped.

#### Safety while exploring

- Blocks requests that change data, and intercepts new windows.
- Skips forms and controls that look like they save, delete, pay, or submit.
- Screens that need one of these actions to appear show a skipped-control notice.

#### Mobile scroll views

- Scrolls the page, the main app panel, and independently scrolling cards.
- Takes up to **30 screenshots per page**, overlapping slightly for continuity.
- Shows sticky headers, floating buttons, and bottom navigation where they actually appear.

#### Waiting for content

- Before each screenshot, waits for loading indicators to clear, images and fonts to load, and the layout to settle.
- Content that keeps loading produces a retry notice or a skipped-page warning.

#### Desktop and tablet details

- Pinned bottom navigation is kept in **Original viewport**. The full-page screenshot hides it so the content underneath shows.
- Up to **six scrollable areas** per page are captured as separate panel images.
- Panels share a 25-second allowance, up to 96 tiles, and a 12-megapixel limit per image. Partial panels show their captured size, full size, and why capture stopped.

#### Structure map

- Uses visible headings and landmarks, and infers layout blocks on pages without them.

</details>

---

## 🌐 Host it online

The online version runs the capture server on [Render](https://render.com)'s free plan, behind a site on Vercel.

| Online | On your computer |
| --- | --- |
| Public websites only | Public websites, local dev servers, and private networks |
| No sign-in capture | Sign-in capture |
| Up to 8 linked views | Up to 30 linked views |
| 10 captures per visitor per hour, one at a time | Unlimited |

Visitors stay anonymous. A cookie keeps each visitor's captures private to their browser.

### Deploy

1. On Render, choose **New → Blueprint** and select this repository. Render reads [render.yaml](render.yaml) and builds the [Dockerfile](Dockerfile).
2. Set `PAGEATLAS_ALLOWED_ORIGINS` in [render.yaml](render.yaml) to the address of your PageAtlas site on Vercel (currently `https://page-atlas.vercel.app`). It lists the sites allowed to send captures to the server. Any public page can still be captured.
3. Check that the address in [vercel.json](vercel.json) matches your Render service (`https://pageatlas.onrender.com` by default), then redeploy on Vercel.

> [!NOTE]
> Render's free plan has about 512 MB of memory and sleeps after 15 minutes without traffic. The first visit after a quiet period takes about a minute.

<details>
<summary><strong>⚙️ Server settings</strong></summary>

Set these in `render.yaml` or in the Render dashboard.

| Setting | Default | What it controls |
| --- | --- | --- |
| `PAGEATLAS_ALLOWED_ORIGINS` | *(required)* | Sites allowed to use the server, separated by commas |
| `PAGEATLAS_MAX_CONCURRENT` | `1` | Captures that run at the same time |
| `PAGEATLAS_MAX_QUEUE` | `6` | Captures that can wait in line |
| `PAGEATLAS_HOURLY_LIMIT` | `10` | Captures per visitor per hour |
| `PAGEATLAS_CRAWL_LIMIT` | `8` | Linked views per capture (up to 30) |
| `PAGEATLAS_MAX_REVIEWS` | `6` | Reviews kept in memory across all visitors |
| `PAGEATLAS_REVIEW_MEMORY_MB` | `48` | Memory for review screenshots |
| `PAGEATLAS_PROXY_HOPS` | `0` (off) | Proxies that add to `X-Forwarded-For`. Set it to also limit captures per network address. Check the header first: with the wrong count, all visitors share one limit. |

</details>

---

## 🛠 Troubleshooting

| Problem | What to do |
| --- | --- |
| `node` isn't recognized, or the launcher says Node.js is missing | Install Node.js 22.18 or newer, then open a new terminal or run the launcher again. |
| "Install Microsoft Edge or Google Chrome" | Install one of them, or set `PAGEATLAS_BROWSER` to the full path of another Chromium-based browser. |
| "Port 4317 is already in use" | PageAtlas is probably already running, so open [http://127.0.0.1:4317](http://127.0.0.1:4317). To use another port, set the `PAGEATLAS_PORT` environment variable, such as `4400`, then start again. |
| "Build PageAtlas with npm run build, then refresh" | Run `npm run build`, then reload the page. |
| Online version says "Couldn't reach the capture service" | The server is waking up. Wait about a minute, then select **Reconnect**. |

## 🧑‍💻 Development

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the app with live updates and automatic server restarts |
| `npm run check` | Type-checks the project |
| `npm run build` | Type-checks and builds the web app |
| `node --test server/*.test.ts server/*.test.mjs` | Runs the tests |
