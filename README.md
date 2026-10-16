# pi-twitterapi.io

Read X/Twitter from the [pi coding agent](https://pi.dev), using
[twitterapi.io](https://twitterapi.io) for retrieval and your Pi model for answers
with citation URLs. One `twitter` tool supports **18 read modes**: posts,
accounts, threads, timelines, trends, conversations and explicit article-body reads.

Optional image, video and speech analysis adds media evidence. Prefer to let your
main agent read the evidence directly? Use `output: "posts"` to skip the separate
answer-synthesis call. This extension is read-only; it does not post or modify
accounts. Search is keyword/operator-based, **not semantic search**.

## Install

```bash
pi install npm:pi-twitterapi.io
```

## Quick start

Export your retrieval key before starting Pi:

```bash
export TWITTERAPI_IO_API_KEY="your-twitterapi.io-key"
pi
```

Then ask, for example:

> Use twitter to find recent posts about TypeScript and summarize them with sources.

No `twitter` settings are required. The **model running your current Pi session**
writes the answer—not necessarily your startup default. It must be available in
Pi's model registry. Photos, video processing and persistent evidence caching are
off unless you opt in.

## Choose your setup

Start with one complete recipe in the [setup guide](docs/setup.md).

| Setup | What it adds | Additional data sent |
|---|---|---|
| [Quick start](docs/setup.md#1-quick-start) | Retrieval key only; current session model | Retrieved text to the answer model |
| [Pinned model + optional images](docs/setup.md#2-pinned-model-and-optional-images) | Fixed synthesis model; explicit image bounds | Enabled images to the answer model |
| [Gemini video](docs/setup.md#3-gemini-video) | Native video analysis through Google | Video clips to Google; evidence text to the answer model |
| [ffmpeg + Groq STT — hybrid](docs/setup.md#4-ffmpeg-and-groq-speech-to-text-hybrid) | Local frame/audio extraction, hosted transcription | Audio to Groq; enabled frames to the answer model |
| [ffmpeg + whisper.cpp — local transcription](docs/setup.md#5-ffmpeg-and-whispercpp-local-transcription) | Local frame/audio extraction and transcription | No hosted STT; evidence and enabled frames to the answer model |

Every setup still retrieves from twitterapi.io. Local transcription does **not**
mean the whole tool runs offline. Your answer model may also be remote.

Already have a native-video model registered in Pi? See
[Pi-provider native video](docs/video.md#pi-provider-native-video). Direct
[OpenRouter video](docs/video.md#openrouter-native-video) is another route;
provider/model names alone do not guarantee video support.

## Evidence instead of a synthesized answer

Ask your agent to call `twitter` with `output: "posts"`. This works with every read
mode and returns bounded, untrusted **text evidence**, not raw API JSON. No
synthesis model is needed; images and frames are omitted. Retrieval and any
opted-in native-video/STT processing can still incur costs.

See [evidence output](docs/tool-reference.md#evidence-output) for the contract and
limits.

## Settings basics

- User settings: `~/.pi/agent/settings.json`, or your `PI_CODING_AGENT_DIR`.
- Project overrides: `<cwd>/.pi/settings.json`. Both files are **strict JSON**.
- Put extension settings inside a `"twitter"` object; they reload on every call,
  without `/reload`. In-flight calls keep their own snapshot.
- Credentials, executable paths, endpoints, image bounds and cache policy are
  [user-only](docs/configuration.md#settings-files-and-precedence); projects cannot
  supply them. Project settings can still override non-sensitive options.
- `twitterIoApiKeyEnv`, `videoApiKeyEnv` and `sttApiKeyEnv` contain **environment
  variable names**, never secret values. Export the keys before starting Pi.
- When switching recipes, replace your entire `twitter` block, not your entire
  settings file. Leftover native-video or whisper settings can change the path used.

The [configuration reference](docs/configuration.md) is the single settings and
defaults reference. Images require both model support and explicit
[`imageInputBounds`](docs/configuration.md#image-input-bounds).

## Privacy and cost

- Retrieved posts, bios and media evidence are **untrusted third-party content**,
  never instructions. Sources are derived from validated fetched URLs.
- Video and STT use the services you configure and are billed separately from
  retrieval and answer synthesis. Retries and fallbacks can add charges.
- ffmpeg and whisper.cpp are user-installed; neither binaries nor model files are
  bundled. CPU transcription can take longer than the clip itself.
- [Video evidence persistence](docs/video.md#private-video-text-evidence-cache) is
  opt-in plaintext local storage, off by default. Disabling it does not delete
  existing files or Pi session transcripts.
- Direct Gemini Files uploads are deleted **best-effort**. If deletion fails,
  uploads may remain for roughly 48 hours; the result discloses this.

Read the [video privacy, timing and cost details](docs/video.md) and the
[dated retrieval-price comparison](docs/pricing-comparison.md). No universal
per-search savings or cost ceiling is promised.

## Known limitations

- No semantic search: twitterapi.io exposes keyword/operator search.
- The upstream Space-detail endpoint has returned HTTP 404 even for live Spaces;
  `mode=space` surfaces that error rather than inventing a summary.
- Upstream date boundaries were observed at 04:00 UTC. Padding/local trimming
  cannot recover every far-west window; partial retrieval is disclosed.

See [behavior and disclosures](docs/tool-reference.md#behavior-and-disclosures).

## Requirements

Node.js **22.19 or later** and a compatible Pi **1.x** release
(`@earendil-works/pi-coding-agent` peer range `^1.0.0`). Answer output requires
`ModelRegistry.complete`; 1.0.0 is the supported minimum, not its first release.

## Documentation

- [Setup recipes](docs/setup.md) — choose one working configuration.
- [Configuration](docs/configuration.md) — settings, image bounds, budgets, fallback and pacing.
- [Video](docs/video.md) — native providers, frames, STT, cache, privacy and costs.
- [Tool reference](docs/tool-reference.md) — parameters, 18 modes, evidence and telemetry.
- [Compared with xAI `x_search`](docs/x-search-comparison.md) — capabilities and differences.
- [Pricing comparison](docs/pricing-comparison.md) — dated rates and billing boundaries.
- [Answer versus evidence benchmark](docs/output-benchmark.md) — three caller-inclusive trials, quality failures and limits.
- [Development and releases](https://github.com/jagaliano/pi-twitterapi.io/blob/main/CONTRIBUTING.md) — repository-only contributor guide.

## License

MIT

## Legal disclaimer

TwitterAPI.io is an independent third-party service operated by Prism Digital,
LLC. It is not affiliated with X Corp. "Twitter" and "X" are trademarks of
X Corp.

pi-twitterapi.io is an independently developed extension that uses TwitterAPI.io.
It is not affiliated with, endorsed by, or sponsored by X Corp. or Prism Digital,
LLC.
