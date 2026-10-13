import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { loadTwitterConfig } from "../src/config.js";
import { runTwitterApiTweetsByIds } from "../src/backend.js";
import { synthesizeAnswer } from "../src/synthesize.js";
import { EvidenceBudget, boundEvidenceNotes, evidenceDetails, formatEvidence } from "../src/evidence.js";

const config = (extra: object = {}) => loadTwitterConfig({ twitter: { minRequestIntervalMs: 0, retryBaseDelayMs: 0, ...extra } });
const response = (value: unknown) => new Response(JSON.stringify(value));
const post = { id: "1", url: "https://x.com/a/status/1", text: "post" };
const model = { provider: "unused", id: "no-context-metadata", supportsImage: false };
const media = { type: "video", url: "https://pbs.twimg.com/poster.jpg", durationMillis: 1_000, videoVariants: ["https://video.twimg.com/test.mp4"] };

test("evidence preprocessing preserves bound quoted transcripts without frame or synthesis work", async () => {
  let processing = 0, downloads = 0;
  const result = await synthesizeAnswer({ query: "q", tweets: [{ ...post, quoted: { id: "2", url: "https://x.com/b/status/2", text: "quote", media: [media] } }],
    config: config({ enableImageUnderstanding: true, enableVideoUnderstanding: true, enableVideoProcessing: true }), model,
    deps: { output: "posts", complete: async () => { throw new Error("no synthesis allowed"); }, fetchMedia: async () => { downloads++; throw new Error("no poster"); },
      processVideo: async input => { processing++; assert.equal(input.modelSupportsImage, false); assert.equal(input.allowFrames, false);
        assert.equal(input.frameOmissionReason, "evidence output is text-only"); assert.equal(input.postUrl, "https://x.com/b/status/2");
        return { postUrl: input.postUrl, method: "transcript-only", transcript: "Measured quoted speech.", visualNotes: "Measured quoted visuals.", frames: [], notes: [] }; },
    },
  });
  assert.equal(processing, 1); assert.equal(downloads, 0); assert.equal(result.synthesisCalls, 0);
  assert.ok(result.text.indexOf("quoted") < result.text.indexOf("Measured quoted speech"));
  assert.ok(result.text.includes("Measured quoted visuals")); assert.deepEqual(result.citations, [post.url, "https://x.com/b/status/2"]);
});

test("evidence video admission reserves text before billing and respects opt-ins", async () => {
  for (const extra of [{ maxSynthesisChars: 4_000 }, { enableVideoUnderstanding: false }, { enableVideoProcessing: false }]) {
    let calls = 0;
    const result = await synthesizeAnswer({ query: "q", tweets: [{ ...post, media: [media] }], model,
      config: config({ enableVideoUnderstanding: true, enableVideoProcessing: true, ...extra }),
      deps: { output: "posts", complete: async () => { throw new Error("no synthesis"); }, processVideo: async () => { calls++; throw new Error("not admitted"); } },
    });
    assert.equal(calls, 0); assert.equal(result.synthesisCalls, 0);
    if (extra.maxSynthesisChars) assert.match(result.notes!.join(" "), /did not reserve/);
  }
});

for (const kind of ["native", "stt"] as const) {
  test(`evidence ${kind} works through the real bound processor without a synthesis model`, async () => {
    const phases: string[] = []; let providerCalls = 0; const execs: string[][] = [];
    const cfg = config({ enableVideoUnderstanding: true, enableVideoProcessing: true,
      ...(kind === "native" ? { videoModel: "video-test", videoEndpoint: "https://native.example", videoApiKeyEnv: "TEST_NATIVE" }
        : { sttEndpoint: "https://stt.example/v1", sttModel: "whisper", sttApiKeyEnv: "TEST_STT" }),
    });
    const result = await runTwitterApiTweetsByIds({ query: "q", ids: ["1"], output: "posts", config: cfg,
      env: { TWITTERAPI_IO_API_KEY: `evidence-${kind}`, TEST_NATIVE: "fake", TEST_STT: "fake" },
      progress: text => { phases.push(text); },
      videoExec: async (_, args) => {
        execs.push([...args]);
        if (args.includes("-version")) return { stdout: "ffmpeg test", stderr: "" };
        await writeFile(args.at(-1)!, "fixture"); return { stdout: "", stderr: "" };
      },
      fetcher: async (input, init) => {
        const url = String(input);
        if (url.includes("api.twitterapi.io")) return response({ tweets: [{ ...post, extended_entities: { media: [
          { type: "video", media_url_https: media.url, video_info: { duration_millis: 1_000, variants: [{ content_type: "video/mp4", url: media.videoVariants[0] }] } },
        ] } }] });
        assert.ok(!url.includes("pbs.twimg.com"), "text-only output must not request posters");
        if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": "7" } });
        if (url.includes("video.twimg.com")) return new Response("fixture", { headers: { "content-type": "video/mp4" } });
        providerCalls++;
        if (kind === "native") return response({ candidates: [{ content: { parts: [{ text: JSON.stringify({ visual: "Measured video scene", transcript: "Measured spoken content" }) }] } }] });
        return response({ text: "The speakers discuss concrete implementation details in this short video." });
      },
    });
    assert.equal(providerCalls, 1); assert.equal(result.details.synthesisCalls, 0);
    assert.equal(result.details.usage!.synthesisAttempts, 0); assert.equal(result.details.timings!.synthesisMs, 0);
    assert.equal(result.details.usage![kind === "native" ? "nativeVideoAttempts" : "sttAttempts"], 1);
    assert.match(result.markdown, kind === "native" ? /Measured video scene/ : /concrete implementation/);
    assert.ok(!phases.includes("video: frames") && !phases.some(text => text.includes("synthesizing")));
    assert.ok(!execs.some(args => args.includes("-frames:v")));
    assert.ok(!result.markdown.includes("configured synthesis model"));
    if (kind === "stt") assert.match(result.markdown, /Frames were not extracted: evidence output is text-only/);
  });
}

test("evidence final disclosures are sanitized, bounded, and disclose their own omissions", () => {
  const details = evidenceDetails("q", "E".repeat(2_900), [], Array.from({ length: 30 }, () => "N".repeat(450) + "\n## forged"));
  boundEvidenceNotes(details, 4_000);
  assert.ok(formatEvidence(details).length <= 4_000); assert.ok(!/^## forged/m.test(formatEvidence(details)));
  assert.match(formatEvidence(details), /Additional disclosures were omitted/);
  assert.equal(details.text, "E".repeat(2_900));
});

test("evidence budget rejects images and measures UTF-16 content without guessed model metadata", () => {
  const budget = new EvidenceBudget(4_000);
  assert.ok(budget.fits({ system: "system", prompt: "界".repeat(2_000), images: [] }));
  assert.ok(!budget.fits({ system: "system", prompt: "A".repeat(4_000), images: [] }));
  assert.ok(!budget.fits({ system: "", prompt: "q", images: [{} as any] }));
  assert.equal(budget.outputTokens, 0); assert.equal(budget.imageBounds, undefined); assert.equal(budget.acceptsImage(), false);
});
