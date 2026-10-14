# Video, speech and cache

[README](../README.md) · [Setup recipes](setup.md) · [Configuration](configuration.md)

Start with the [Gemini](setup.md#3-gemini-video),
[Groq hybrid](setup.md#4-ffmpeg-and-groq-speech-to-text-hybrid) or
[local whisper](setup.md#5-ffmpeg-and-whispercpp-local-transcription) recipe.
The [settings table](configuration.md#settings-and-defaults) is the defaults reference.

## Processing order

**Video processing is opt-in.** It needs
`enableVideoUnderstanding: true` **and** `enableVideoProcessing: true`, plus a
locally installed `ffmpeg` (for frames/audio) and optionally whisper.cpp, or a
configured native-video / STT provider. Native video can use a registered Pi
provider (depending on its native-video support), `gemini-files` (Google,
direct), or `openai-compatible` (OpenRouter and other
chat-completions endpoints, verified with `google/gemini-2.5-flash-lite`);
admitted frames are sent to your pi model. Reported provider refusals are
disclosed; eligible frame/STT fallback can still run within the remaining budget.
Some services can silently ignore video despite returning HTTP 200, so verify
your provider/model rather than relying on its name or HTTP status. Frames need
model image support and declared bounds; STT needs its own configuration.
Sending video/audio to a third-party endpoint is disclosed in the answer.
The direct native adapters ask for the same JSON contract, by different means:
direct `gemini-files` constrains it with a response schema
(`responseMimeType: application/json`), while `openai-compatible` requests it in
the prompt text. The Pi-provider route also requests JSON through its prompt;
the provider controls its transport. A
reply that ignores the contract is kept whole as visual evidence: the transcript
is never inferred from prose (an invented transcript would be published as
evidence), and configured STT can attempt speech recovery. A reply
cut off at the token limit is *not* used as evidence, because half-written JSON
would otherwise be published as a description.
Variant selection probes `HEAD` sizes when available, with bitrate estimates
as a fallback. Advertised bitrate can overstate actual size by roughly 3x
(a nominal 2176 kbps clip measured 6.16 MB where the estimate suggested 19.6 MB).
Executable paths, endpoints and credential names are read from **user
settings only** — project `.pi/settings.json` values for those keys are
ignored and disclosed. A custom `videoEndpoint` is only honoured when
`videoApiKeyEnv` is set explicitly (and must be `https://`), so the default
key is never sent to another host. `sttEndpoint` likewise requires a valid
HTTPS URL and an explicitly set `sttApiKeyEnv`; set it to `STT_API_KEY` if that
is the variable you use. Plain HTTP endpoints are refused, including localhost.

### Native, frames and speech precedence

1. A configured native-video route is tried first when the bounded clip is eligible.
2. If no native method produced usable text, frames may be extracted. This needs
   ffmpeg, known/bounded frame timing, an image-capable answering model, declared
   image bounds and reserved slots. Frames are not added on top of successful
   native analysis.
3. When speech was not already supplied or explicitly reported absent by a
   structured native reply, STT can run. A successful structured reply with an
   empty transcript means "no speech" and skips STT. Unstructured prose is never
   guessed into a transcript.
4. Local whisper.cpp wins when both local paths are configured; otherwise the
   configured hosted STT endpoint is used. There is no remote retry after a
   failed local STT attempt. GIFs have no audio transcription.
5. When processing yields no usable evidence, a poster may be used if image
   admission permits it. Omissions and native failures are disclosed; cancellation
   and expired video work do not start a new paid fallback.

With `output: "posts"`, frame extraction and photo/poster delivery are skipped.
Configured native-video and STT text processing remain eligible; the
[text-only evidence contract](tool-reference.md#evidence-output) explains costs.

## Retention and duration

When native video uses the Gemini Files API the
upload is deleted on a **best-effort** basis once the call finishes, with its
own short timeout so a cancelled request cannot skip it. If deletion fails — or
an upload happened but generation failed, returned nothing, or was cancelled —
the answer says the file may be retained. Google's Files API keeps undeleted
uploads for roughly **48 hours**, so treat such a file as readable by that
project for about that long.

The **whole upstream video must fit `maxVideoBytes` before local trimming**;
raising the clip duration alone cannot admit a larger download.
Only the first `maxVideoSeconds` (default 120 s)
are analysed: the video is trimmed locally when possible, and a clip that
**cannot** be trimmed is not uploaded whole — the native path is skipped and
disclosed, while frames and audio stay limited to that window. Worst case a
single video call can take several minutes. The defaults are a minimum request
spacing of 5 s, a 60 s media phase, up to `videoBudgetMs` of video work (180 s,
capped at 300 s), a 15 s window reserved for the poster-frame fallback, and then
synthesis with its own retries; a Gemini Files upload is deleted before that
fallback is used. These are budgets rather than a strict additive timeline — each
phase spends only what it needs, and the poster window is a shared deadline, not
a guaranteed extra wait. Provider video analysis is the slow part and its latency
varies: measured live on 2026-10-05, one call over a 65 s clip took 33 s once and
~71 s another time, so expect a long tool call on a media-heavy query. Local
transcription is bound by your hardware instead: the same day, `whisper.cpp` with
`large-v3-turbo` **on CPU** took about **3 minutes** to transcribe a 30 s clip.
CPU inference does work and needs nothing special, but it is **slow**, and a large
model can cost far more wall-clock time than the clip is long.

## Local tooling and budgets

**Accelerated builds are strongly recommended for local processing.** whisper.cpp
ships backends for Apple Silicon (Metal, Core ML and the Accelerate framework),
NVIDIA GPUs (CUDA), AMD GPUs (ROCm), Vulkan GPUs, OpenVINO, and NPUs including AMD
Ryzen AI and Ascend — with a per-backend list of verified devices in the
[whisper.cpp README](https://github.com/ggml-org/whisper.cpp). Pick a build for your
hardware and a model size that keeps up on your machine before enabling the local
tier. `whisperThreads` (default `min(8, availableParallelism())`) is passed to
whisper.cpp as `-t`, and it matters: on one CPU-only host the same 30 s clip took
**61 s on 4 threads and 42 s on 12**. A smaller model (`base`, `small`) is usually
the bigger win on a CPU-only machine.

**Local transcription is skipped when it cannot fit.** Before starting whisper.cpp
the extension compares the remaining video budget with
`clipSeconds × whisperRealtimeFactor` (default `2`, i.e. two seconds of wall clock
per second of audio) and skips with a note rather than burning the whole budget and
being killed late. On a CPU-only host, either use a smaller model, set
`whisperRealtimeFactor` to match your machine, or use the remote `sttEndpoint`
instead — a remote endpoint costs a request, local transcription costs your
hardware's time.

Neither tool is bundled: install `ffmpeg` from [ffmpeg.org](https://ffmpeg.org/)
(or your package manager) and `whisper.cpp` from
[ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp), then point
`ffmpegPath` and `whisperCppBinary` at the binaries you installed.

## Binary availability cache

Successful `ffmpeg -version` availability checks are reused in memory within
the Pi process (up to 128 resolved executable paths per executor). Each lookup
rechecks the resolved path, file identity, size, permissions and modification
timestamps; replacement, edits, symlink retargeting and `PATH`/override changes
invalidate the hit. No failures, timeouts or cancellations are cached. Concurrent
misses probe independently with their own signals/budgets; a cancelled caller
cannot poison another. Checks use the remaining phase budget, capped at five
seconds; late settlement cannot report or store a new success after the deadline.
Path traversal preserves filesystem semantics, including symlink/`..` paths.
Restarting Pi drops this cache; it stores no evidence
on disk. Custom detection overrides bypass it. whisper.cpp currently has no
separate availability probe, so its actual transcription still runs each time.

## Cost

Native video is billed by whichever endpoint you configure, and video is
tokenised by **duration** rather than file size. In one measurement on
2026-10-05, `google/gemini-2.5-flash-lite` counted 258 video tokens per second of
clip (about 31k tokens for the default 120 s window) and a single 120 s analysis
cost **$0.0031** at OpenRouter list prices; the same clip cost **$0.0045** on
`qwen/qwen3.7-flash`, whose completion spent most of its tokens on reasoning. Treat
those as one model's rates, not a rule for every provider, and re-check the
current prices — they change.

They are single-call examples, not per-search totals and not a cap. Retrieval,
the synthesis model's text/image/output tokens, optional STT, and any retries or
fallbacks all add up on top, and work that is thrown away may still be billed: a
native reply cut off at its token limit is refused, and a timed-out attempt is
abandoned, but only after the provider has processed the clip. Only the trimmed
`maxVideoSeconds` window is ever sent, and `maxVideosPerSearch` (default 1) bounds
how many videos one search will analyse. The other tiers bill separately: frames
ride your pi model as images at normal token cost, a configured STT endpoint
charges in **its own provider's units, rates and minimums** (per second of audio
for most hosted Whisper APIs, with the audio re-sent — up to three attempts — when
an endpoint rejects the requested response format), and local `ffmpeg` plus
whisper.cpp cost nothing beyond the model files you download.

## Pi-provider native video

To reuse a model registered in Pi, set a qualified `videoModel` in your **user**
settings. The default `gemini-files` endpoint type recognises `provider/model`
references; keep `videoEndpoint` unset so Pi manages routing:

```json
{
  "twitter": {
    "enableVideoUnderstanding": true,
    "enableVideoProcessing": true,
    "videoEndpointType": "gemini-files",
    "videoModel": "google/gemini-2.5-flash-lite"
  }
}
```

This selects the **video evidence** model, not the answer synthesis model.
Authentication (including OAuth), endpoint selection and transport stay with Pi
and the registered provider extension. No `GOOGLE_API_KEY` or `videoApiKeyEnv`
is required for this route, and this extension never extracts Pi credentials.

**Native-video support is the provider extension's responsibility.** A Gemini
model name alone is not a compatibility guarantee for `pi-antigravity`,
`@estebanforge/pi-antigravity-bridge`, `pi-provider-antigravity`, or any other
provider. Pi's ordinary message API carries text/images, so the provider must
honour its `onPayload` hook and forward native video. Supported payload layouts
are Google `contents`, Antigravity-style `request.contents`, and Pi's
`openai-completions` messages using `video_url`. Providers that do not forward
the hook or expose an unsupported layout fail with a disclosure; a hook-less
text-only reply is discarded, never used as video evidence. A downstream service
can still reject or silently ignore video despite the hook: verify your chosen
provider/model rather than assuming it supports the modality. Applicable
frames/STT fallbacks remain available. The example above selects a Pi catalogue
entry; it is not a claim of cloud verification for that route.

**Measured incompatibility:** a bounded cloud probe of `pi-antigravity@0.10.0`
with `antigravity/gemini-2.5-flash-lite` invoked no payload hook and sent no video
parts. Its HTTP 200 text-only reply was discarded as intended. That installed
provider is **not compatible with this adapter**; this does not establish the
capabilities of other Antigravity extensions or versions.

This Pi-provider path sends bounded clips **inline only, up to 12 MiB**; it does
not borrow credentials for Google's Files API. Persistent evidence caching is
bypassed with a note because provider authentication/routing can change outside
these settings. Expanded telemetry reports native-video SDK calls separately
from direct HTTP requests and answer synthesis; provider-internal HTTP retries
are not observable.

If your provider extension does not support native video, use the existing
**direct Gemini** alternative instead:

```bash
export GOOGLE_API_KEY="your-google-api-key"
```

```json
{
  "twitter": {
    "enableVideoUnderstanding": true,
    "enableVideoProcessing": true,
    "videoEndpointType": "gemini-files",
    "videoModel": "gemini-2.5-flash-lite"
  }
}
```

The bare model name selects direct Gemini, including its Files upload path for
larger clips. Switching routes is explicit: a failed Pi provider never causes its
credentials (or `GOOGLE_API_KEY`) to be sent automatically to another provider.
The `openai-compatible` direct endpoint route is unchanged: a model id such as
`google/gemini-2.5-flash-lite` remains an upstream id there, not a Pi reference.

## OpenRouter native video

Export `OPENROUTER_API_KEY` before starting Pi. For direct native video through
OpenRouter instead of Google:

```json
{
  "twitter": {
    "enableVideoUnderstanding": true,
    "enableVideoProcessing": true,
    "videoEndpointType": "openai-compatible",
    "videoEndpoint": "https://openrouter.ai/api/v1",
    "videoApiKeyEnv": "OPENROUTER_API_KEY",
    "videoModel": "google/gemini-2.5-flash-lite"
  }
}
```

## Video processing priority

When video processing is enabled, deduplicated own/quoted/reposted video assets
are ranked **after** whole text bundles are retained, before reserving or spending
processing slots:

1. Known positive duration within `maxVideoSeconds` (inclusive), then known longer
   duration, then missing/invalid duration.
2. Within each band, original-source views descending, then likes descending.
   Known zero beats missing counts; non-finite, negative, fractional or unsafe
   counts are treated as missing. Exact duration does not break ties within a band.
3. Equal tuples retain original result/media order.

Only actual media owners contribute counts—not enclosing quote/repost commentary
or mirrored wrappers. Repeated fetched originals use the highest reported value
for each count; their rendered metadata is unchanged. Deduplication and ownership
reconciliation happen before ranking, so a repeated asset consumes one slot and
its evidence keeps every original source binding.

This is **resource allocation, not a relevance claim**. Retrieved post order is
unchanged; shorter clips can win over popular long clips. A ranked asset whose
worst-case evidence does not fit the complete-input budget is skipped before
processing, letting the next ranked asset try the slot. Video-cap, input-budget
and shared-deadline skips are disclosed separately. Photos still download first,
existing caps/deadlines remain shared, and poster-only mode keeps source order.
Ranking adds no retrieval calls and does not change the opt-in evidence-cache
policy below. This applies to both
answer and text-only evidence output; evidence output still omits all images.

## Private video text evidence cache

Persistence is **off by default**. To opt in, add `"evidenceCache": "read-write"`
to the `twitter` block in **user** settings. Project settings cannot enable or
change this policy. Existing video opt-ins, source admission, ranked slots and
input budgets still apply; cached text is not a way around them.

- Only successful non-empty transcripts and/or visual descriptions are saved.
  Failed, empty and frames-only results are not successful hits; failed Gemini
  upload cleanup also prevents caching. Successful fallback STT can be saved.
- Storage: `<agent-dir>/twitter-evidence-cache-v1` (normally under `~/.pi/agent/`,
  honouring `PI_CODING_AGENT_DIR`), private `0700` directory / `0600` files on
  POSIX systems. Entries are bounded to **20 MiB / 1,000 files**, with a 128 kB
  single-entry cap. Frames, attribution fields, question/answer text, operational
  errors and credential fields are not stored; known runtime credential echoes
  are excluded from reuse/storage. Transcripts/descriptions themselves can
  contain sensitive content: **this is plaintext local storage, not encryption**.
- Persistence currently requires POSIX ownership/permission checks (`process.getuid`).
  On Windows these checks cannot pass, so caching is unavailable and processing
  continues without cache reuse/storage. Clearing an existing cache directory is
  refused; if no directory exists, clear succeeds with zero entries removed.
- A versioned digest identifies the complete playable variant ladder and order,
  media identity/duration, provider/endpoint/models, clip/processing/filter policy,
  language, credential availability (never values), and local binary/model file
  identity. Changes miss rather than silently replay different analysis. Signed
  media URLs and credential-bearing endpoint URLs bypass persistence.
- A valid hit skips video downloads, binary execution and native-video/STT calls.
  Text is rebound to the **current** source; notes report original analysis time,
  method and clip limit. **No frames/images are restored** and original operational
  notes are not replayed. Posts are always retrieved fresh; answer output still
  makes its usual synthesis call. Cached evidence remains untrusted third-party text.
- The **7-day TTL limits reuse**, not a background deletion guarantee. Expired or
  corrupt entries are pruned on writes; oldest analysis is evicted when capacity
  is reached. Atomic private writes and a writer/clear lock protect concurrent
  processes. A busy or abandoned writer lock safely skips storage; valid reads
  need not wait for it. Locks are never stolen.

`read` permits hits but no storage/eviction; `write` stores new analysis but never
reads a text hit. `off` stops cache reads/writes **without deleting existing files**.
Settings changes apply on the next call. To delete entries explicitly:

```text
/twitter-cache clear
```

Confirm the dialog, or use `/twitter-cache clear --yes` in headless mode. Clear
waits for this session's work to settle, serializes with writers, invalidates
already-processing cache generations, and removes only recognized cache entries
and temporary files. Unrelated files are untouched. The private directory and
an opaque generation marker remain. It **does not erase provider uploads,
existing Pi session transcripts, backups or copies outside this directory**.
Unsafe directories or busy locks cause a reported refusal rather than unsafe
recursive deletion. After a process crash, close other Pi processes before
manually removing an abandoned `.lock` directory and retrying clear; the extension
never removes it automatically.
