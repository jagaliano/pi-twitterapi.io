# Video spike (M0) — observed API shapes

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

## 2. Gemini inline limit + Files latency — ⏳ NEEDS `GOOGLE_API_KEY`

Pending (no key available in this environment):
- Confirm the inline request-size limit (~20 MB/request) and the raw-safe threshold (plan uses ≤ ~12 MB raw).
- Measure Files `PROCESSING → ACTIVE` latency for a 30–60 s clip (feeds the 90–120 s video budget).
- Confirm `DELETE /v1beta/files/{name}` succeeds.

## 3. OpenRouter `video_url` — ⏳ NEEDS `OPENROUTER_API_KEY`

Pending: which models accept a `video_url` part, and whether base64 data URLs work. Until confirmed, `openai-compatible` is NOT used for video (frames go through the pi model instead).

## 4. xAI video understanding — ✅ CONFIRMED ABSENT (docs)

`docs.x.ai` has no video-understanding capability; all video pages are Imagine (generation). Chat "files" are document-search oriented (`input_file`), with no video part type. → Grok is frames-only.

## 5. Pi model layer video input — ✅ CONFIRMED ABSENT (bundle, ^1.0.2)

The shipped `@earendil-works/pi-coding-agent` bundle has no video input type; `complete()` carries images only. Native video must be a direct endpoint call.
