# Configuration reference

[README](../README.md) · [Setup recipes](setup.md) · [Video details](video.md)

## Settings files and precedence

Put settings inside a `"twitter"` object in **strict JSON** (no comments or
trailing commas):

- User: `~/.pi/agent/settings.json`, or `settings.json` inside
  `PI_CODING_AGENT_DIR` when overridden.
- Project: `<cwd>/.pi/settings.json`, using the current tool call's working
  directory.

Both files reload at the start of every call; edits apply without `/reload`.
In-flight calls retain their own snapshot. Non-sensitive project settings
override user settings. Malformed/unreadable files contribute no settings and
are disclosed in the result rather than removing the tool.

Project settings can still raise cost-affecting limits (for example `maxPages`,
`maxPagesCeiling`, `maxVideoSeconds`, `maxVideosPerSearch` and `maxVideoBytes`)
or select a different `synthesisModel`. Review `.pi/settings.json` in repositories
you do not trust.

**User-only keys** are never accepted from project settings; attempted overrides
are ignored and disclosed:

`twitterIoApiKeyEnv`, `enableVideoProcessing`, `videoEndpoint`,
`videoEndpointType`, `videoModel`, `videoApiKeyEnv`, `sttEndpoint`,
`sttModel`, `sttApiKeyEnv`, `ffmpegPath`, `whisperCppBinary`,
`whisperModelPath`, `whisperVadModelPath`, `whisperThreads`,
`whisperRealtimeFactor`, `imageInputBounds`, `evidenceCache`.

When switching [recipes](setup.md), replace the whole `twitter` block while
preserving unrelated Pi settings. Omitted keys from a partial edit remain active.

## Settings and defaults

All settings are optional. Numeric values outside supported ranges are clamped
with a note; invalid types use defaults with a note. Integer settings reject
fractional values rather than rounding. Media/processing flags require literal
`true`.

| Key | Default | Meaning / limits |
|---|---|---|
| `twitterIoApiKeyEnv` | `TWITTERAPI_IO_API_KEY` | User-only retrieval credential variable name; no fallback to another variable when overridden. |
| `synthesisModel` | Current session model | Exact Pi `provider/model` for answer synthesis. See selection/fallback below. |
| `enableImageUnderstanding` | `false` | Opt into post photos; requires model image support, declared bounds and reserved space. |
| `enableVideoUnderstanding` | `false` | Opt into video poster images; also required for real video processing. Images need bounds. |
| `enableVideoProcessing` | `false` | User-only native video and/or frames + STT; requires `enableVideoUnderstanding`. |
| `maxMediaPerSearch` | `4` | Photo/poster attachment ceiling, range 0–20; excludes extracted video frames. Complete-input limits can reduce delivery. |
| `maxSynthesisChars` | `60000` | Rendered-text backstop, range 1,000–120,000; evidence output uses it as its final text ceiling including disclosures. |
| `imageInputBounds` | No declarations | User-only exact-model image limits; missing entries omit images with disclosure. |
| `maxPages` | `5` | Base page budget, range 1–100, additionally clamped to `maxPagesCeiling`. |
| `maxPagesCeiling` | `20` | Hard page ceiling, range 1–100. |
| `minRequestIntervalMs` | `5000` | Shared per-credential twitterapi.io dispatch spacing, range 0–600,000 ms. Raise when throttled; lower for a higher-QPS tier. |
| `retryBaseDelayMs` | `5000` | Retry backoff base, range 0–600,000 ms. Backoff/`Retry-After` and pacing both apply. |
| `evidenceCache` | `off` | User-only `off`, `read`, `write`, `read-write`; [plaintext cache policy](video.md#private-video-text-evidence-cache). |
| `videoEndpointType` | `gemini-files` | User-only native format: direct/Pi Google-style or `openai-compatible`. `anthropic` is recognized but unimplemented; unknown strings disable native analysis with a note. |
| `videoEndpoint` | Google for direct `gemini-files`; none otherwise | User-only custom HTTPS base URL; requires explicit `videoApiKeyEnv`. Do not combine with a Pi-qualified model. |
| `videoModel` | Unset | User-only bare direct Google model or Pi `provider/model` under `gemini-files`; direct upstream ID under `openai-compatible`. |
| `videoApiKeyEnv` | `GOOGLE_API_KEY` | User-only direct native-video credential variable. Unused by the Pi-managed route. |
| `sttEndpoint` | Unset | User-only HTTPS OpenAI-compatible base URL; explicit `sttApiKeyEnv` required. No default STT provider. |
| `sttModel` | Unset | User-only STT model ID; required for hosted transcription. |
| `sttApiKeyEnv` | `STT_API_KEY` | User-only variable name; must be explicitly set together with `sttEndpoint`, even when using this default name. |
| `sttLanguage` | `auto` | STT language, e.g. an ISO-639-1 code. Read from user settings only; a project value currently has no effect and produces no override note. |
| `ffmpegPath` | `ffmpeg` on `PATH` | User-only executable override; ffmpeg is not bundled. |
| `whisperCppBinary` | Unset | User-only whisper.cpp executable; requires `whisperModelPath` for local STT. |
| `whisperModelPath` | Unset | User-only GGML model path; model files are not bundled. |
| `whisperVadModelPath` | Unset | User-only optional VAD model; enables whisper.cpp `--vad` to trim silence before decoding. |
| `whisperThreads` | `min(8, availableParallelism())` | User-only whisper.cpp `-t`, range 1–64. |
| `whisperRealtimeFactor` | `2` | User-only estimated wall seconds per audio second for local budget admission, range 0.1–60. |
| `maxVideoSeconds` | `120` | Initial video window in seconds, range 1–600. |
| `maxVideoBytes` | `33554432` (32 MiB) | Full upstream download cap, range 1,024–67,108,864 bytes (64 MiB); trimming happens after download. |
| `maxFrames` | `8` | Frames per processed video, range 1–16; attachment budgets still apply. |
| `maxVideosPerSearch` | `1` | Processed video assets, range 1–3. |
| `videoBudgetMs` | `180000` | Video phase budget in ms, range 1–300,000. |

## Credential variable names

These fields name environment variables, **not secret values**. Export the
variables before launching Pi. To select a different retrieval-key variable:

```bash
export MY_TWITTER_KEY="your-twitterapi.io-key"
```

```json
{
  "twitter": {
    "twitterIoApiKeyEnv": "MY_TWITTER_KEY"
  }
}
```

Only the selected variable is read; it does not fall back to
`TWITTERAPI_IO_API_KEY`. The name must match
`[A-Za-z_][A-Za-z0-9_]*`; invalid names revert to the default with a note.

Custom `videoEndpoint` and `sttEndpoint` values require HTTPS and an explicitly
paired credential variable name in user settings. Plain HTTP is refused,
including localhost. Set `sttApiKeyEnv` explicitly even when you use `STT_API_KEY`.
The extension appends `/audio/transcriptions` to the STT base URL. Pi's stored
provider credentials are not copied into direct video/STT calls. Qualified
[Pi-provider video](video.md#pi-provider-native-video) delegates authentication
instead of extracting keys.

## Synthesis selection and fallback

Answer output uses the current session model when `synthesisModel` is absent.
Headless callers also need a resolvable session model or an explicit
`synthesisModel`; evidence output does not require an answer model.
If configured, the exact model must resolve in Pi's catalogue **before retrieval**;
a missing catalogue entry throws, without runtime fallback. Primary and fallback
models need valid context/output limits. When a configured model resolves but
fails during completion, the current session model is the fallback (deduplicated
if it is the same model). The result names the model that answered.

Evidence output (`output: "posts"`) skips synthesis lookup and completion;
see the [evidence contract](tool-reference.md#evidence-output).

| Failure | Examples | Reaction |
|---|---|---|
| Quota / billing | `402`, `insufficient_quota`, quota exceeded, subscription limit | next model |
| Authentication | `401`, `403`, invalid API key | next model |
| Unknown model | `404`, "does not exist" | next model |
| Invalid request | `400`, `422`, malformed | next model |
| Rate limit | `429`, "too many requests", overloaded | next model, retried once when it is the last one |
| Server | `5xx`, bad gateway, unavailable | next model, retried once when it is the last one |
| Transport | timeouts, connection drops, premature stream endings | next model, retried once when it is the last one |
| Empty response | model returned no usable text | next model, retried once when it is the last one |
| Unclassified | anything else | next model, never retried |
| Cancelled | aborted signal / `AbortError`, or pi's "was cancelled" wording | stop, no fallback |

Deterministic failures never retry the same model. The bounded retry (500 ms,
doubling to a 4 s cap) is spent only on the last available model, since an
untried model is the better bet while one remains.

## Complete-input budget (answer output)

Before retrieval, the primary and fallback catalogue entries must expose valid
`contextWindow` and `maxTokens`. A question that cannot fit the system/scaffold is
rejected before an API read. All four synthesis paths budget their **rendered**
input; text uses UTF-8 bytes as a conservative token estimate plus 1,024 tokens of
message overhead. This is not an exact provider tokenizer or serialized-envelope
guarantee. Output is explicitly reserved and passed to every physical completion,
including retries/repair: at most 4,096 tokens, reduced by model output caps and
one quarter of the smallest context window.

Whole post/account/trend bundles or document fields are selected locally. Before
media work, bounded transcript/visual evidence, image slots, references and the
manifest are reserved. JSON escape worst cases for controls/lone surrogates are
reserved separately when catalogue request-byte limits exist; already image-free
questions are measured verbatim, not pattern-stripped. Omitted post bundles and
unreserved video assets incur no
media/video/STT call. Final input is checked again. Local omissions are disclosed
separately from upstream paging limits. Own, quoted and reposted post text is
retained in full when its whole source bundle fits; there is no per-post
700-character cut. Bundles that cannot fit are omitted before media work, or a
clear error is returned if none fit. Bio/metadata limits remain unchanged.
Inline Sources come only from delivered evidence. The deduplicated
no-inline fallback lists at most 20 Sources and discloses that cap.

## Image input bounds

To attach images, enable `enableImageUnderstanding` for photos or
`enableVideoUnderstanding` for posters/frames. The answering model must accept
images, and the input budget must reserve space. Explicit bounds are required.

Put `imageInputBounds` in **user** settings, never project settings, keyed by the
exact answering `provider/model`.
For example, this declares an *assumed* 8,192-token upper bound for images within
these dimensions; verify that assumption for your actual model/provider before
using it (it is not a measured universal default):

```json
{
  "twitter": {
    "imageInputBounds": {
      "your-provider/your-model": {
        "tokensPerImage": 8192,
        "maxWidth": 1568,
        "maxHeight": 1568,
        "maxImages": 4,
        "maxBytes": 5242880
      }
    }
  }
}
```

`tokensPerImage`, `maxWidth`, `maxHeight` and `maxImages` are required positive
integers. `maxBytes` is optional and defaults to 10 MiB. An invalid entry disables
images for that model, with a note.

`maxImages` caps all images in one answer, including extracted video frames;
`maxMediaPerSearch` limits photos and posters only. In the video recipes,
`maxImages: 4` admits at most four frames despite the default `maxFrames: 8`, and
fewer if photos or posters also consume image slots. Other input limits can
reduce delivery further.

Dimensions are clamped to 8,192, count to 100 and raw bytes to 10 MiB; token upper
bounds are never clamped downward. Catalogue image-count/resize limits also apply.
Only static PNG/JPEG byte headers with known dimensions are admitted; animated or
unknown encodings, oversized dimensions/bytes and unreserved slots are omitted.
This validates bounded geometry, not full image decoding. No automatic resizing
or model-family formula is invented. Incorrect declarations can still cause
provider rejection. Native-video/STT text evidence remains eligible without image
bounds. Text-only or undeclared-image fallbacks retain the same selected sources
and trusted question, but omit images, their manifest and attachment references.

## Shared request pacing

Dispatches use a per-credential FIFO, not sequential tool execution. The largest
interval among active HTTP calls (including response reads and retry backoff)
and the previous dispatch's interval set the next minimum gap. Time is rechecked
on wake, so late timers cannot release a burst. Response reads and synthesis can
still overlap; cancellation abandons queued/sleeping calls without dispatching.
Idle credential digests expire after their cooldown. This process-local limiter
never paces media/STT/model hosts; other Pi processes using the same key still
need their own coordination.
