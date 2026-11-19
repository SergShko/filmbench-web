# Vendored libraries

## Mediabunny 1.66.1

- File: `mediabunny-1.66.1.min.mjs` (the package's minified ESM bundle, unmodified)
- Source URL: https://cdn.jsdelivr.net/npm/mediabunny@1.66.1/dist/bundles/mediabunny.min.mjs
- sha256: `19062c195ea4d32bc4eefd3a7254ae0e8a901bc0607ac3a0174013e165980498`
- Licence: Mozilla Public License 2.0, text in `LICENSE-mediabunny.txt`
  (from https://cdn.jsdelivr.net/npm/mediabunny@1.66.1/LICENSE,
  sha256 `3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04`)
- Project: https://mediabunny.dev, https://github.com/Vanilagy/mediabunny
- Used for: reading video files (demux, decode through WebCodecs) and writing MP4
  (H.264 encode, audio copy or AAC/Opus encode, mux). Imported by `web/video/clip.js`.

The page loads this file from its own folder; nothing is fetched from a CDN at run time.
To update, download the new bundle, check its sha256, rename the file and the import
in `web/video/clip.js`, and update this note.
