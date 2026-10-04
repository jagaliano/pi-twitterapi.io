import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTwitterConfig } from "./config.js";
import {
  createProcessVideo,
  estimateVariantBytes,
  parseGeminiSections,
  processVideo,
  selectVariant,
  type ExecFn,
  type VideoDeps,
} from "./backend/video.js";
import type { TweetMedia } from "./twitterapi.js";

// --------------------------------------------------------------------- config

test("project settings cannot set executable paths, endpoints or credential names (B1)", () => {
  const config = loadTwitterConfig(
    { twitter: { enableVideoUnderstanding: true, enableVideoProcessing: true, videoModel: "gemini-2.5-flash" } },
    {
      projectSettings: {
        twitter: {
          enableVideoProcessing: false,
          ffmpegPath: "/tmp/evil.sh",
          videoEndpoint: "https://evil.example",
          videoApiKeyEnv: "AWS_SECRET_ACCESS_KEY",
          whisperCppBinary: "/tmp/evil",
        },
      },
    },
  );
  assert.equal(config.enableVideoProcessing, true, "project cannot disable a user-enabled switch");
  assert.equal(config.ffmpegPath, undefined, "project ffmpegPath ignored");
  assert.equal(config.whisperCppBinary, undefined, "project whisper binary ignored");
  assert.equal(config.videoEndpoint, undefined, "project endpoint ignored");
  assert.equal(config.videoApiKeyEnv, "GOOGLE_API_KEY", "project key env ignored");
  assert.ok(config.configNotes.some((note) => /project settings was ignored/.test(note)));
});

test("video processing requires enableVideoUnderstanding (M1)", () => {
  const config = loadTwitterConfig({ twitter: { enableVideoProcessing: true } });
  assert.equal(config.enableVideoProcessing, false);
  assert.ok(config.configNotes.some((note) => /enableVideoUnderstanding/.test(note)));
});

test("video config defaults and clamps", () => {
  const defaults = loadTwitterConfig({});
  assert.equal(defaults.videoEndpointType, "gemini-files");
  assert.equal(defaults.videoApiKeyEnv, "GOOGLE_API_KEY");
  assert.equal(defaults.sttLanguage, "auto");
  assert.equal(defaults.maxFrames, 8);
  assert.equal(defaults.maxVideosPerSearch, 1);
  assert.equal(defaults.videoBudgetMs, 90_000);

  const clamped = loadTwitterConfig({
    twitter: { maxVideoSeconds: 9_999, maxFrames: 99, maxVideosPerSearch: 99, videoBudgetMs: 10_000_000 },
  });
  assert.equal(clamped.maxVideoSeconds, 120, "out-of-range duration falls back to the default");
  assert.equal(clamped.maxFrames, 8, "out-of-range frame cap falls back to the default");
  assert.equal(clamped.maxVideosPerSearch, 1);
  assert.equal(clamped.videoBudgetMs, 120_000, "budget is clamped to the effective max");
});

// -------------------------------------------------------------- variant logic

test("estimateVariantBytes uses bits-per-second and a container margin", () => {
  // 1_000_000 bps for 10 s = 1.25 MB × 1.1 ≈ 1_375_000
  assert.equal(estimateVariantBytes(1_000_000, 10_000), 1_375_000);
  assert.equal(estimateVariantBytes(undefined, 10_000), undefined);
});

test("selectVariant picks the highest bitrate that fits, never blindly the largest", () => {
  const media: TweetMedia = {
    type: "video",
    durationMillis: 10_000,
    videoVariantsDetailed: [
      { url: "low", bitrate: 200_000 },
      { url: "mid", bitrate: 1_000_000 },
      { url: "high", bitrate: 8_000_000 },
    ],
  };
  // high ≈ 11 MB, mid ≈ 1.4 MB, low ≈ 0.28 MB
  assert.equal(selectVariant(media, { maxBytes: 32 * 1024 * 1024 })?.url, "high");
  assert.equal(selectVariant(media, { maxBytes: 2_000_000 })?.url, "mid");
  assert.equal(selectVariant(media, { maxBytes: 500_000 })?.url, "low");
  // Inline preference: pick the highest that fits the inline cap even when a bigger one fits maxBytes.
  assert.equal(selectVariant(media, { maxBytes: 32 * 1024 * 1024, inlineBytes: 2_000_000 })?.url, "mid");
});

test("selectVariant falls back to the smallest variant when size is unknown", () => {
  const media: TweetMedia = { type: "video", videoVariantsDetailed: [{ url: "a" }, { url: "b" }] };
  assert.equal(selectVariant(media, { maxBytes: 1_000 })?.url, "a");
});

// ---------------------------------------------------------------- processVideo

function videoMedia(overrides: Partial<TweetMedia> = {}): TweetMedia {
  return {
    type: "video",
    url: "https://pbs.twimg.com/poster.jpg",
    durationMillis: 5_000,
    videoVariantsDetailed: [{ url: "https://video.twimg.com/x.mp4", bitrate: 1_000_000 }],
    ...overrides,
  };
}

/** A fetcher that serves the MP4 body and (optionally) an STT JSON response. */
function videoFetcher(options: { mp4Bytes?: number; sttText?: string } = {}) {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/audio/transcriptions")) {
      return new Response(JSON.stringify({ text: options.sttText ?? "spoken words" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(new Uint8Array(options.mp4Bytes ?? 1_024).fill(1), {
      status: 200,
      headers: { "content-type": "video/mp4" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

/** Records ffmpeg invocations; writes frame/audio outputs where the real binary would. */
function fakeExec(durationSec = 5) {
  const invocations: string[][] = [];
  const exec: ExecFn = async (_file, args) => {
    invocations.push(args);
    const output = args[args.length - 1];
    if (args.includes("-i") && !args.includes("-y")) {
      // Probe: ffmpeg prints the banner to stderr then fails.
      const error = new Error("ffmpeg probe") as Error & { stderr?: string };
      error.stderr = `Duration: 00:00:${String(durationSec).padStart(2, "0")}.00`;
      throw error;
    }
    if (output.includes("frame-")) {
      const framesIndex = args.indexOf("-frames:v");
      const count = framesIndex >= 0 ? Number(args[framesIndex + 1]) : 1;
      for (let i = 1; i <= count; i += 1) {
        await writeFile(join(output.replace("%03d", String(i).padStart(3, "0"))), new Uint8Array([1, 2, 3]));
      }
    } else if (output.endsWith(".mp3") || output.endsWith(".wav")) {
      await writeFile(output, new Uint8Array([9, 9]));
    }
    return { stdout: "", stderr: "" };
  };
  return { exec, invocations };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-video-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("processVideo extracts frames and never hands ffmpeg a URL (B2/F4)", async () => {
  await withTempDir(async (dir) => {
    const { fetcher } = videoFetcher();
    const { exec, invocations } = fakeExec();
    const removed: string[] = [];
    const deps: VideoDeps = {
      fetcher,
      env: {},
      exec,
      checkBinary: async () => true,
      mktemp: async () => dir,
      rmTemp: async (d) => {
        removed.push(d);
      },
      now: () => 0,
    };
    const config = loadTwitterConfig({ twitter: { maxFrames: 3, maxVideoSeconds: 120 } });
    const result = await processVideo({
      postUrl: "https://x.com/a/status/1",
      media: videoMedia(),
      config,
      deps,
      deadline: 60_000,
      modelSupportsImage: true,
    });

    // B2: no ffmpeg invocation may contain a network URL.
    for (const args of invocations) {
      assert.ok(!args.some((a) => /^https?:\/\//.test(a)), `ffmpeg got a URL: ${args.join(" ")}`);
      assert.ok(args.includes("-protocol_whitelist") && args.includes("file"));
    }
    // F4: the frame filter does uniform sampling via `fps=`.
    const frameArgs = invocations.find((args) => args.some((a) => a.includes("frame-")));
    assert.ok(frameArgs, "frame extraction ran");
    const filter = frameArgs![frameArgs!.indexOf("-vf") + 1];
    assert.match(filter, /fps=/);
    assert.equal(result.frames.length, 3);
    assert.match(result.frames[0].label, /frame 1\/3 @ \d\d:\d\d/);
    assert.equal(result.method, "frames-only");
    assert.deepEqual(removed, [dir], "temp dir cleaned up");
  });
});

test("processVideo skips STT for gifs and discloses it (M11)", async () => {
  await withTempDir(async (dir) => {
    const { fetcher } = videoFetcher();
    const { exec } = fakeExec();
    const deps: VideoDeps = {
      fetcher,
      env: { STT_API_KEY: "k" },
      exec,
      checkBinary: async () => true,
      mktemp: async () => dir,
      rmTemp: async () => {},
      now: () => 0,
    };
    const config = loadTwitterConfig({
      twitter: { sttEndpoint: "https://stt.example/v1", sttModel: "whisper-large-v3-turbo" },
    });
    const result = await processVideo({
      postUrl: "https://x.com/a/status/2",
      media: videoMedia({ type: "animated_gif", durationMillis: undefined }),
      config,
      deps,
      deadline: 60_000,
      modelSupportsImage: true,
    });
    assert.equal(result.transcript, undefined);
    assert.ok(result.notes.some((note) => /no audio track/.test(note)));
  });
});

test("processVideo produces a transcript via an explicit STT endpoint", async () => {
  await withTempDir(async (dir) => {
    const { fetcher, calls } = videoFetcher({ sttText: "the spoken line" });
    const { exec } = fakeExec();
    const deps: VideoDeps = {
      fetcher,
      env: { STT_API_KEY: "k" },
      exec,
      checkBinary: async () => true,
      mktemp: async () => dir,
      rmTemp: async () => {},
      now: () => 0,
    };
    const config = loadTwitterConfig({
      twitter: { sttEndpoint: "https://stt.example/v1", sttModel: "whisper-large-v3-turbo" },
    });
    const result = await processVideo({
      postUrl: "https://x.com/a/status/3",
      media: videoMedia(),
      config,
      deps,
      deadline: 60_000,
      modelSupportsImage: false,
    });
    assert.equal(result.transcript, "the spoken line");
    assert.equal(result.method, "transcript-only", "text-only model keeps the transcript, not frames");
    assert.ok(calls.some((url) => url.includes("/audio/transcriptions")));
  });
});

test("processVideo skips a video that exceeds the byte cap", async () => {
  await withTempDir(async (dir) => {
    const { fetcher } = videoFetcher({ mp4Bytes: 4_096 });
    const { exec } = fakeExec();
    const deps: VideoDeps = {
      fetcher,
      env: {},
      exec,
      checkBinary: async () => true,
      mktemp: async () => dir,
      rmTemp: async () => {},
      now: () => 0,
    };
    const config = loadTwitterConfig({ twitter: { maxVideoBytes: 1_024, maxVideoSeconds: 600 } });
    const result = await processVideo({
      postUrl: "https://x.com/a/status/4",
      media: videoMedia({ durationMillis: 600_000 }),
      config,
      deps,
      deadline: 60_000,
      modelSupportsImage: true,
    });
    assert.equal(result.frames.length, 0, "no frames from an over-cap download");
    assert.ok(result.notes.some((note) => /could not be downloaded/.test(note)));
  });
});

test("createProcessVideo binds deps and returns evidence", async () => {
  await withTempDir(async (dir) => {
    const { fetcher } = videoFetcher();
    const { exec } = fakeExec();
    const bound = createProcessVideo({
      fetcher,
      env: {},
      exec,
      checkBinary: async () => true,
      mktemp: async () => dir,
      rmTemp: async () => {},
      now: () => 0,
    });
    const config = loadTwitterConfig({ twitter: { maxFrames: 2 } });
    const evidence = await bound({
      postUrl: "https://x.com/a/status/5",
      media: videoMedia(),
      config,
      deadline: 60_000,
      modelSupportsImage: true,
    });
    assert.equal(evidence.postUrl, "https://x.com/a/status/5");
    assert.equal(evidence.frames.length, 2);
  });
});

// ---------------------------------------------------- native video / native STT

test("parseGeminiSections splits VISUAL and TRANSCRIPT", () => {
  assert.deepEqual(parseGeminiSections("VISUAL: a dog\nTRANSCRIPT: woof"), { visual: "a dog", transcript: "woof" });
  assert.deepEqual(parseGeminiSections("just a description"), { visual: "just a description" });
  assert.deepEqual(parseGeminiSections("   "), {});
});

/** Serves the MP4, then the Gemini inline or Files lifecycle. */
function geminiFetcher(options: { uploadUrl?: boolean; deleteOk?: boolean } = {}) {
  const calls: { url: string; method: string }[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    if (url.includes("/upload/v1beta/files")) {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: options.uploadUrl === false ? {} : { "x-goog-upload-url": "https://upload.example/session" },
      });
    }
    if (url.includes("upload.example/session")) {
      return new Response(JSON.stringify({ file: { name: "files/abc", uri: "files/abc" } }), { status: 200 });
    }
    if (url.includes("/v1beta/files/abc") && method === "DELETE") {
      return new Response(null, { status: options.deleteOk === false ? 500 : 200 });
    }
    if (url.includes("/v1beta/files/abc")) {
      return new Response(JSON.stringify({ state: "ACTIVE" }), { status: 200 });
    }
    if (url.includes(":generateContent")) {
      const text = "VISUAL: a person speaks\nTRANSCRIPT: hello world";
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
    }
    return new Response(new Uint8Array(1_024).fill(1), { status: 200, headers: { "content-type": "video/mp4" } });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function nativeDeps(fetcher: typeof fetch, dir: string, inlineRawBytes?: number): VideoDeps {
  return {
    fetcher,
    env: { GOOGLE_API_KEY: "k" },
    exec: fakeExec().exec,
    checkBinary: async () => true,
    mktemp: async () => dir,
    rmTemp: async () => {},
    now: () => 0,
    inlineRawBytes,
  };
}

const GEMINI_CONFIG = loadTwitterConfig({
  twitter: { videoEndpointType: "gemini-files", videoModel: "gemini-2.5-flash", videoApiKeyEnv: "GOOGLE_API_KEY" },
});

test("processVideo uses Gemini inline data and maps sections to evidence", async () => {
  await withTempDir(async (dir) => {
    const { fetcher, calls } = geminiFetcher();
    const result = await processVideo({
      postUrl: "https://x.com/a/status/6",
      media: videoMedia(),
      config: GEMINI_CONFIG,
      deps: nativeDeps(fetcher, dir),
      deadline: 60_000,
      modelSupportsImage: true,
    });
    assert.equal(result.method, "gemini-native");
    assert.equal(result.visualNotes, "a person speaks");
    assert.equal(result.transcript, "hello world");
    assert.ok(calls.some((c) => c.url.includes(":generateContent")));
    assert.ok(!calls.some((c) => c.url.includes("/upload/")), "inline path did not upload");
  });
});

test("processVideo uses the Files lifecycle and deletes the upload", async () => {
  await withTempDir(async (dir) => {
    const { fetcher, calls } = geminiFetcher();
    const result = await processVideo({
      postUrl: "https://x.com/a/status/7",
      media: videoMedia(),
      config: GEMINI_CONFIG,
      // Force the Files path with a 1-byte inline threshold.
      deps: nativeDeps(fetcher, dir, 1),
      deadline: 60_000,
      modelSupportsImage: true,
    });
    assert.equal(result.method, "gemini-native");
    assert.ok(calls.some((c) => c.url.includes("/upload/v1beta/files")));
    assert.ok(calls.some((c) => c.method === "DELETE" && c.url.includes("/v1beta/files/abc")), "upload deleted");
  });
});

test("processVideo discloses a failed Gemini delete", async () => {
  await withTempDir(async (dir) => {
    const { fetcher } = geminiFetcher({ deleteOk: false });
    const result = await processVideo({
      postUrl: "https://x.com/a/status/8",
      media: videoMedia(),
      config: GEMINI_CONFIG,
      deps: nativeDeps(fetcher, dir, 1),
      deadline: 60_000,
      modelSupportsImage: true,
    });
    assert.ok(result.notes.some((note) => /could not be deleted/.test(note)));
  });
});

test("processVideo runs local whisper.cpp and reads the JSON output file", async () => {
  await withTempDir(async (dir) => {
    const modelPath = join(dir, "ggml.bin");
    await writeFile(modelPath, "model");
    const whisperExec: ExecFn = async (_file, args) => {
      const output = args[args.length - 1];
      if (args.includes("-oj")) {
        const ofIndex = args.indexOf("-of");
        await writeFile(`${args[ofIndex + 1]}.json`, JSON.stringify({ text: "whispered words" }));
        return { stdout: "", stderr: "" };
      }
      if (args.includes("-i") && !args.includes("-y")) {
        const error = new Error("probe") as Error & { stderr?: string };
        error.stderr = "Duration: 00:00:05.00";
        throw error;
      }
      if (!output.includes("frame-")) await writeFile(output, new Uint8Array([1]));
      return { stdout: "", stderr: "" };
    };
    const { fetcher } = videoFetcher();
    const config = loadTwitterConfig({
      twitter: { whisperCppBinary: "/usr/bin/whisper-cli", whisperModelPath: modelPath },
    });
    const result = await processVideo({
      postUrl: "https://x.com/a/status/9",
      media: videoMedia(),
      config,
      deps: { fetcher, env: {}, exec: whisperExec, checkBinary: async () => true, mktemp: async () => dir, rmTemp: async () => {}, now: () => 0 },
      deadline: 60_000,
      modelSupportsImage: false,
    });
    assert.equal(result.transcript, "whispered words");
    assert.equal(result.method, "transcript-only");
    assert.ok(result.notes.some((note) => /local whisper.cpp/.test(note)));
  });
});

test("processVideo returns early when the caller signal is already aborted", async () => {
  await withTempDir(async (dir) => {
    const { fetcher } = videoFetcher();
    const controller = new AbortController();
    controller.abort();
    const result = await processVideo({
      postUrl: "https://x.com/a/status/10",
      media: videoMedia(),
      config: loadTwitterConfig({ twitter: {} }),
      deps: { fetcher, env: {}, signal: controller.signal, mktemp: async () => dir, rmTemp: async () => {}, now: () => 0 },
      deadline: 60_000,
      modelSupportsImage: true,
    });
    assert.equal(result.frames.length, 0);
    assert.ok(result.notes.some((note) => /cancelled/.test(note)));
  });
});

test("processVideo trims an over-limit video on the local file and says so", async () => {
  await withTempDir(async (dir) => {
    const invocations: string[][] = [];
    const exec: ExecFn = async (_file, args) => {
      invocations.push(args);
      const output = args[args.length - 1];
      if (args.includes("-i") && !args.includes("-y")) {
        const error = new Error("probe") as Error & { stderr?: string };
        error.stderr = "Duration: 00:10:00.00";
        throw error;
      }
      if (output.includes("frame-")) {
        await writeFile(join(output.replace("%03d", "001")), new Uint8Array([1]));
      } else if (output.endsWith(".mp4") || output.endsWith(".mp3") || output.endsWith(".wav")) {
        await writeFile(output, new Uint8Array([1]));
      }
      return { stdout: "", stderr: "" };
    };
    const { fetcher } = videoFetcher();
    const config = loadTwitterConfig({ twitter: { maxVideoSeconds: 120, maxFrames: 2 } });
    const result = await processVideo({
      postUrl: "https://x.com/a/status/11",
      media: videoMedia({ durationMillis: 600_000 }),
      config,
      deps: { fetcher, env: {}, exec, checkBinary: async () => true, mktemp: async () => dir, rmTemp: async () => {}, now: () => 0 },
      deadline: 120_000,
      modelSupportsImage: true,
    });
    const clip = invocations.find((args) => args.includes("-c") && args.includes("copy"));
    assert.ok(clip, "clip invoked");
    assert.ok(clip!.includes("-t") && clip![clip!.indexOf("-t") + 1] === "120");
    assert.ok(result.notes.some((note) => /only the first 120s/.test(note)));
  });
});

test("video processing requires both switches for all four combinations", () => {
  const combos: [boolean, boolean, boolean][] = [
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [true, true, true],
  ];
  for (const [video, understanding, expected] of combos) {
    const config = loadTwitterConfig({ twitter: { enableVideoProcessing: video, enableVideoUnderstanding: understanding } });
    assert.equal(config.enableVideoProcessing, expected, `video=${video} understanding=${understanding}`);
  }
});

