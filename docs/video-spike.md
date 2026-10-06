# Video spike (M0) — observed API shapes

Internal spike log. Deliberately **not** published to npm (`package.json` excludes
it via `!docs/video-spike.md`): it records what was observed while building v1, so
it is not an end-user document and nothing in the package links to it. Keep the
findings accurate anyway — the implementation relies on them.

Recorded 2026-10-04 while implementing v1. Update as items are confirmed.

## 1. twitterapi.io media shape — ✅ CONFIRMED (live)

`extendedEntities.media[]` for a **video** post:

```
type: "video"
media_url_https: https://pbs.twimg.com/amplify_video_thumb/<id>/img/<x>.jpg   ← poster frame
video_info.duration_millis: 5760
video_info.variants: [
  { content_type: "application/x-mpegURL" },          ← HLS, no bitrate → skipped
  { content_type: "video/mp4", bitrate: 432000  },
  { content_type: "video/mp4", bitrate: 832000  },
  { content_type: "video/mp4", bitrate: 1280000 },
]
```

Implications:
- `videoVariantsDetailed` is populated from `video/mp4` variants only, with `bitrate` (bits/sec).
- Highest-bitrate selection is real: 1_280_000 bps ≈ 160 KB/s → 5.76 s ≈ 0.9 MB.
- `duration_millis` present for video, so size = `bitrate/8 × sec × 1.1` works pre-download.
- `media_url_https` is a `.jpg` poster (pbs.twimg.com) — the existing image path already handles it.

**animated_gif**: not observed in the sampled queries — the parser treats `animated_gif` like `video` (no audio track → STT skipped) and the same `video_info` path applies. Re-check when a gif post is sampled.

## 2. Gemini inline limit + Files latency — ✅ CONFIRMED (live)

Measured 2026-10-04 against `generativelanguage.googleapis.com` with
`gemini-2.5-flash-lite` on a real X video:

- **Inline:** clips up to **12 MiB raw** were accepted inline. Be precise about what
  that number is: it is `GEMINI_INLINE_RAW_BYTES`, **our own conservative cutoff**, not a
  measured provider rejection. A 12.83 MB clip went to Files and succeeded, which
  demonstrates the adapter switching paths — not that Google refuses an inline upload
  above 12 MiB. No inline rejection was observed at any size in this session.
- **Files, end to end:** verified on a 44-minute post (832 kbps `.mp4`, 63.37 MB)
  trimmed to 550 s → **12.83 MB**, just over the inline ceiling. Ran
  upload → poll `PROCESSING` → `ACTIVE` → `generateContent(file_data)` → `DELETE`,
  all succeeded, and the answer carried no retention warning.
- **Delete:** `DELETE /v1beta/files/{name}` succeeds. A failed delete is disclosed
  rather than hidden, and cleanup runs on a fresh signal so a cancelled caller
  cannot skip it.
- **Latency:** a 65 s clip took 33 s on one run and ~71 s on another (provider-dependent).
  The poll loop is bounded by the video-phase budget, so a file that never reports
  `ACTIVE` ends the phase instead of hanging.
- **Reachability:** with the default `maxVideoSeconds` (120) the Files path is
  effectively never taken — the local trim keeps clips around 1–2 MB, and every
  sampled variant ladder (≈268 videos) had a floor of 256–632 kbps. Raising
  `maxVideoSeconds` / `maxVideoBytes` puts it in play immediately. See `VideoPlan.md` §5.

## 3. OpenRouter `video_url` — ✅ CONFIRMED (live)

Measured 2026-10-04 against `https://openrouter.ai/api/v1/chat/completions`.

**Model support.** Of 464 listed models, 83 declare `video` input
(`architecture.input_modalities`):

- ✅ `google/gemini-2.5-flash-lite` — `["text","image","file","audio","video"]`, $0.10/$0.40 per Mtok.
- ❌ A model that declares no `video` input returns **HTTP 404 "No endpoints found
  that support input video"** for a `video_url` request. Nothing model-specific about
  it: read `architecture.input_modalities` and pick a model that lists `video`.
- Cheaper video-capable options exist if cost matters: `inclusionai/ling-3.0-flash-vl`
  ($0.021), `qwen/qwen3.7-flash` ($0.03), free `google/gemma-4-*-it:free` variants.

**Working part shape** — a base64 data URL, with no upload step:

```json
{"type":"video_url","video_url":{"url":"data:video/mp4;base64,<...>"}}
```

Verified with a synthetic clip (cyan 2 s → orange 1 s → magenta 3 s → black 1 s):
`google/gemini-2.5-flash-lite` reproduced the colours **and** durations exactly, so the
video really is being watched rather than guessed.

**Traps — both plausible alternatives fail silently.** Each returned HTTP 200 while
attaching nothing, and the model answered from the prompt text alone ("Please provide
the video…"). An adapter using either shape would publish a hallucinated "analysis" as
real evidence, which is why the spelling in `openAiCompatibleVideo` is load-bearing:

- `{"type":"input_video","input_video":{"data":…,"format":"mp4"}}`
- `{"type":"video_url","video_url":"data:…"}` — a string instead of an object

**Size:** OpenRouter accepted request bodies of 6.22, 12.09, 12.25, 47.72 and **94.51 MB**
in this measurement (the largest carrying a 70.88 MB `.mp4`), i.e. past the 64 MB
`maxVideoBytes` ceiling. That is one endpoint's observed behaviour, not a statement of its
limit or of any other host's. Unlike Gemini direct there is no upload lifecycle to manage,
so the clip is always sent inline.

## 4. Pi model layer video input — ✅ CONFIRMED ABSENT (bundle, ^1.0.2)

The shipped `@earendil-works/pi-coding-agent` bundle has no video input type; `complete()` carries images only. Native video must be a direct endpoint call.
