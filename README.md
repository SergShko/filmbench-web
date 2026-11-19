# FilmBench (web)

Film looks for photos and videos in the browser: grain, halation, glow and colour
modelled on film stocks. A static page with no build step. Nothing is uploaded; all
processing runs on the viewer's device (WebGPU, WebCodecs).

- Live: https://sergshko.github.io/filmbench-web/ (app at `app/`)
- Browsers: tested in Chrome on macOS. Edge 113+ should work; Safari 26+ and Firefox 141+
  have WebGPU but are untested.
- Video: MP4/MOV in, H.264 MP4 out, audio copied or encoded to AAC. HDR (HLG/PQ) video
  is not exported.
- Run locally: `cd app && python3 -m http.server 8000 --bind 127.0.0.1`, then open
  http://127.0.0.1:8000/.

Uses [Mediabunny](https://mediabunny.dev) 1.66.1 (MPL-2.0), vendored in `app/vendor/`.
Code under the MIT licence (`LICENSE`).
