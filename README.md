# PPU-in-JPEG Snake — Telegram Mini App (No Server-Side Code)

This project is a **self-contained Telegram Mini App** that:
- Generates a **JPEG cartridge** entirely in-browser using JS.
- Injects executable payload **only into APP15 segments before SOS** (Magic `PPUJ`).
- Verifies blocks with **CRC32** and fails closed (view-only if verification fails).
- Maps touch to commands via a **truth table** (buttons are drawn into the JPEG raster; interactivity comes from region mapping).
- Runs a deterministic VM (bounded cycles) that dispatches syscalls to a Snake game core.

## Run locally (for dev)
Because browsers restrict module loading from `file://`, use a static file server:
```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy (no backend)
Host the folder on any static host (GitHub Pages, Netlify, Cloudflare Pages). The app is pure static.

## Use in Telegram
1. Create a bot with @BotFather.
2. Configure a Mini App / Web App URL (BotFather `/setmenubutton`).
3. Point it to your HTTPS URL where this folder is hosted.
4. Open the bot, tap the menu button to launch the Mini App.

## Using downloads safely
If you share the produced `ppu-snake-cartridge.jpg` inside Telegram and you need the APP15 blocks preserved, **send it as a file/document**, not as a photo.

## Files
- `app.js` — Mini App + canvas renderer + input mapping + cartridge builder
- `ppujpeg.js` — APP15 builder/loader + CRC32 + pre-SOS parsing
- `vm.js` — deterministic VM + Snake syscalls
- `sw.js` — best-effort offline caching
