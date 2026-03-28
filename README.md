# Vidroop Downloader (Chrome Extension)

Browser extension for Vidroop pages that detects HLS playlists, lets you choose quality/output format, downloads the stream, and saves it locally.

## Purpose

This project exists to give users a practical way to export video sessions they are authorized to access from Vidroop-hosted pages.

## What it does

- Injects a **Download video** button into supported Vidroop iframe wrappers.
- Detects and resolves playlist candidates across rotating CDN hosts.
- Lets you choose:
  - Video quality (when multiple variants are available)
  - Output format:
    - `TS` (original stream chunks merged)
    - `MP4` (browser-side remux)
    - `AAC` (audio-only)
- Handles encrypted HLS segments (AES-CBC) when keys are provided by the playlist.
- Includes cancellation flow and stale-session recovery for SPA/iframe changes.
- Provides localized UI strings (`en`, `es-419`) and popup language selection.

## How to use (local)

### 1) Install dependencies

```bash
yarn install
```

### 2) Build extension

```bash
yarn build
```

This generates the unpacked extension in `dist/`.

### 3) Load in Chrome/Chromium

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `dist/` folder

### 4) Download a video

1. Open a supported Vidroop page.
2. Click **Download video** in the iframe area.
3. Choose quality and output format.
4. Wait until the file is generated and saved.

## Development scripts

- `yarn check` → syntax-check source scripts
- `yarn build` → build extension into `dist/`
- `yarn build:check` → build + syntax-check bundled output
- `yarn deps:update` → update conversion dependencies

## Legal disclaimer

This tool is provided for **educational and interoperability purposes**.

- This repository is **not affiliated with, endorsed by, or sponsored by Vidroop**.
- Use this project only for content you are legally allowed to access and download.
- You are responsible for complying with local laws, copyright rules, platform terms, and client agreements.
- The maintainers provide no warranty and accept no liability for misuse.

If you are unsure whether you have permission to download specific content, do not use this tool for that content.
