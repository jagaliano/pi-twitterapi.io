# Setup recipes

[README](../README.md) · [Configuration](configuration.md) · [Video details](video.md)

Choose one recipe:

1. [Quick start](#1-quick-start) — just the retrieval key.
2. [Pinned model and optional images](#2-pinned-model-and-optional-images).
3. [Gemini video](#3-gemini-video).
4. [ffmpeg and Groq speech-to-text (hybrid)](#4-ffmpeg-and-groq-speech-to-text-hybrid).
5. [ffmpeg and whisper.cpp (local transcription)](#5-ffmpeg-and-whispercpp-local-transcription).

## Before you start

Install with `pi install npm:pi-twitterapi.io` and export your twitterapi.io key
before starting Pi. All recipes need it:

```bash
export TWITTERAPI_IO_API_KEY="your-twitterapi.io-key"
```

The JSON examples belong in **user** settings, normally
`~/.pi/agent/settings.json`. Preserve unrelated settings, but **replace the entire
existing `twitter` block** with the chosen recipe; do not merge recipes blindly.
Comments and trailing commas are not valid JSON. Changes apply to the next tool
call without `/reload`; new shell environment variables require starting Pi from
that environment.

Why replace the block? Leftover `videoModel`/credentials can activate native
analysis, and local whisper settings take priority over a hosted `sttEndpoint`.
Project `.pi/settings.json` can still override non-sensitive keys such as
`synthesisModel` and media-understanding flags. Sensitive keys (including
`enableVideoProcessing`) are [user-only](configuration.md#settings-files-and-precedence).

The examples using `anthropic/claude-haiku-5-5` assume you have that exact
model available and authenticated in Pi. Substitute your own exact `provider/model`
if needed; update its image-bounds key too. An unavailable configured synthesis
model fails **before retrieval**, not through runtime fallback.

**Image examples are illustrative, not provider recommendations.** The bounds
below declare an *assumed* upper token limit for those dimensions. Verify them
against your actual provider/model before enabling images. See
[image input bounds](configuration.md#image-input-bounds). You can omit
`enableImageUnderstanding` and `imageInputBounds` for text-only answers; native
video descriptions and STT transcripts still work without images.

## 1. Quick start

**Requires:** the retrieval key and an active Pi model. No settings needed.

```bash
pi
```

Ask:

> Use twitter to find recent posts about TypeScript and summarize them with sources.

The current session model writes the answer; it is not necessarily your startup
default. Media understanding and persistent caching are off. If switching from a
previous recipe, remove its `twitter` block (or replace it with `"twitter": {}`)
and check project overrides.

Want a different retrieval-key variable? Set the user-only
[`twitterIoApiKeyEnv`](configuration.md#credential-variable-names), which names an
environment variable, not the key itself.

## 2. Pinned model and optional images

**Requires:** the retrieval key and a model configured in Pi. For a fixed answer
model without media:

```json
{
  "twitter": {
    "synthesisModel": "anthropic/claude-haiku-5-5"
  }
}
```

To opt into images, use this complete replacement block **after verifying the
illustrative bounds**:

```json
{
  "twitter": {
    "synthesisModel": "anthropic/claude-haiku-5-5",
    "enableImageUnderstanding": true,
    "imageInputBounds": {
      "anthropic/claude-haiku-5-5": {
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

Images go to the answering model only when it accepts images, its exact bounds
entry exists, geometry/bytes are allowed and input space is available. Missing
images are disclosed. Video processing is not enabled by this recipe.

If the pinned model fails at runtime, the current session model is the fallback,
with a note. A fallback without its own image bounds receives text only. Both
models need valid catalogue context/output limits. See
[synthesis selection and fallback](configuration.md#synthesis-selection-and-fallback).

## 3. Gemini video

**Requires:** the retrieval key and a Google API key. ffmpeg is recommended for
trimming and is needed for frame/audio fallback; install it yourself from
[ffmpeg.org](https://ffmpeg.org/) or your package manager.

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

The **bare** model name selects direct Google access. The `videoModel` produces
video evidence; the current Pi session model writes the answer. You may also pin
`synthesisModel`; they are separate roles.

**Both video flags are required.** With only `enableVideoUnderstanding`, videos
are represented by poster images, and only when the answer model has image
support, declared bounds and available input space.

This recipe needs no image bounds for native video descriptions/transcripts.
Clips go to Google; larger inline-ineligible clips can use the Files API, with
[best-effort deletion](video.md#retention-and-duration). Only a bounded initial
window is analysed; a clip that cannot be trimmed when needed is not uploaded
whole. Without ffmpeg, unknown-duration clips and clips longer than
`maxVideoSeconds` skip native analysis. The entire upstream download must still
fit the download cap.

Native failure can fall back to frames if ffmpeg, model image support and bounds
are available. Speech fallback needs separate STT configuration. This recipe
alone does not configure either. See [processing order](video.md#processing-order).

Other routes are documented separately:
[Pi-managed authentication](video.md#pi-provider-native-video) and
[OpenRouter](video.md#openrouter-native-video). A provider name is not a video
compatibility guarantee; `pi-antigravity@0.10.0` was measured as incompatible.

## 4. ffmpeg and Groq speech-to-text (hybrid)

**Requires:** the retrieval key, user-installed ffmpeg, a Groq API key, and the
answer model shown below (or your replacement). This is **Groq hosted STT**, not
xAI/Grok and not fully local processing.

```bash
export GROQ_API_KEY="your-groq-api-key"
```

The frame bounds are illustrative; verify them as described above. Without an
image-capable model and valid bounds, this route can still return speech text.

```json
{
  "twitter": {
    "synthesisModel": "anthropic/claude-haiku-5-5",
    "enableVideoUnderstanding": true,
    "enableVideoProcessing": true,
    "sttEndpoint": "https://api.groq.com/openai/v1",
    "sttModel": "whisper-large-v3-turbo",
    "sttApiKeyEnv": "GROQ_API_KEY",
    "imageInputBounds": {
      "anthropic/claude-haiku-5-5": {
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

ffmpeg runs locally and extracts bounded frames/audio. Audio goes to Groq;
admitted frames and the transcript go to your answer model. Groq bills
transcription separately. `enableVideoUnderstanding` enables the video frames;
`enableImageUnderstanding` is only needed if you also want ordinary post photos.

The extension appends `/audio/transcriptions` to `sttEndpoint`. HTTPS **and an
explicit `sttApiKeyEnv`** are required. The latter contains `GROQ_API_KEY`, not its
secret value. `sttModel` and the exported key must also be present.

Do not leave `videoModel`, `whisperCppBinary` or `whisperModelPath` from another
recipe: they can select native analysis or local transcription instead. Set
`ffmpegPath` only if your ffmpeg is not on `PATH`.

## 5. ffmpeg and whisper.cpp (local transcription)

**Requires:** the retrieval key, user-installed ffmpeg, a
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) executable, a GGML model and
the answer model shown below (or your replacement). No hosted STT key is needed.
Replace the executable/model placeholders with your actual paths.

The frame bounds are illustrative; verify them before use, or omit the bounds
for transcript-only evidence.

```json
{
  "twitter": {
    "synthesisModel": "anthropic/claude-haiku-5-5",
    "enableVideoUnderstanding": true,
    "enableVideoProcessing": true,
    "whisperCppBinary": "/absolute/path/to/whisper-cli",
    "whisperModelPath": "/absolute/path/to/ggml-small.bin",
    "imageInputBounds": {
      "anthropic/claude-haiku-5-5": {
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

Transcription runs locally; retrieval still uses twitterapi.io, and text/frames
are delivered to your answer model, which may be remote. No binaries or model
files are bundled. Ordinary post photos remain disabled in this example.

Start with a small model and test your hardware. A measured CPU run with a
large-v3-turbo model took about **three minutes for a 30-second clip**; accelerated
builds or smaller models can be much faster. Local transcription is skipped with
a note when its estimated time cannot fit the video budget. Tune `whisperThreads`
and `whisperRealtimeFactor` for your hardware; `whisperVadModelPath` can help avoid
transcribing silence. See [local tooling](video.md#local-tooling-and-budgets).

When both local whisper paths are configured, local STT takes priority over a
hosted `sttEndpoint`; remote STT is not an automatic retry for failed local STT.
Leave `videoModel` unset to keep native video out of this recipe.

## Evidence output with any recipe

Ask your agent to use `output: "posts"` on a tool call, for example:

```json
{
  "query": "Find recent TypeScript discussion",
  "mode": "posts",
  "count": 5,
  "output": "posts"
}
```

This is a **tool argument**, not a `twitter` setting. It skips answer synthesis and
returns bounded untrusted text evidence. Photos, posters and extracted frames
are omitted even if your main agent accepts images. With video processing opted
in, native video/STT can still run and cost money; retrieval is still paid too.
See the [full evidence contract](tool-reference.md#evidence-output).

## If a recipe does not behave as expected

- Check user and project `twitter` blocks for leftover or overriding keys.
- Read the tool's Notes for ignored settings, partial retrieval and missing media.
  Successful processing reports notes such as "Video content was analysed by the
  configured Gemini endpoint", "Transcript produced by local whisper.cpp" or
  "Transcript produced by the configured STT endpoint".
- Check that exported keys existed in the environment that started Pi. Pi's own
  stored provider authentication is separate from direct video/STT environment keys.
- Run `pi --list-models` to find your exact model ID; update the bounds key when
  changing it. Headless answer calls need a resolvable session model or an explicit
  `synthesisModel`.
- Expand the result to see [usage/timings](tool-reference.md#usage-and-timings),
  including native-video and STT attempt/failure counts. Attempts alone do not
  establish successful analysis; check the Notes too.
