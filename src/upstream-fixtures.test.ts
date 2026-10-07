import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { asTweet, asUser, statusIdFromUrl } from "./twitterapi.js";

// Deliberately a consumed-field projection, not a complete provider DTO.
interface RawPost {
  id: string;
  url: string;
  text: string;
  author: { id: string; userName: string };
  isReply: boolean;
  inReplyToUsername: string | null;
  quoted_tweet: RawPost | null;
  retweeted_tweet: RawPost | null;
  extendedEntities: { media: { type: string; ext_alt_text?: string; media_url_https: string }[] };
  entities: { urls: { url: string; expanded_url: string }[] };
  card: { name: string; url: string; binding_values: { key: string; value: { string_value: string } }[] } | null;
  article: { title: string; preview_text: string; cover_media_img_url: string } | null;
}
interface RawProfile {
  id: string;
  userName: string;
  statusesCount: number;
  mediaCount: number;
  entities: { url: { urls: { url: string; expanded_url: string }[] } };
  pinnedTweetIds: string[];
}
interface Fixtures {
  live: {
    quoteVideo: { tweet: RawPost };
    retweet: { tweet: RawPost };
    reply: { tweet: RawPost };
    linkCard: { tweet: RawPost };
    linkCardByIds: { tweet: Omit<RawPost, "card" | "article"> & { card: { legacy: NonNullable<RawPost["card"]> } } };
    longPost: { tweet: RawPost };
    article: { tweet: RawPost };
    photoAlt: { tweet: RawPost };
    profile: { payload: { data: RawProfile } };
    timeline: { payload: { data: { tweets: RawPost[]; pin_tweet: null }; has_next_page: boolean; next_cursor: string } };
  };
  synthetic: Record<string, { reason: string }>;
}
const fixture: Fixtures = JSON.parse(readFileSync(new URL("./fixtures/upstream-context.json", import.meta.url), "utf8"));

function checkPost(post: Pick<RawPost, "id" | "url" | "text" | "author" | "quoted_tweet" | "retweeted_tweet">): void {
  assert.equal(statusIdFromUrl(post.url), post.id);
  assert.equal(new URL(post.url).pathname.split("/")[1], post.author.userName);
  assert.ok(asTweet(post), "existing parser must still accept projected posts");
  for (const nested of [post.quoted_tweet, post.retweeted_tweet]) if (nested) checkPost(nested);
}

test("consumed post projections preserve source/author identity and parser compatibility", () => {
  const { live } = fixture;
  for (const sample of [live.quoteVideo, live.retweet, live.reply, live.linkCard, live.longPost, live.article, live.photoAlt]) checkPost(sample.tweet);
});

test("quote/repost/reply projections carry the context needed by Phase 2", () => {
  const quote = fixture.live.quoteVideo.tweet.quoted_tweet;
  assert.ok(quote?.extendedEntities.media.some((media) => media.type === "video"));
  const repost = fixture.live.retweet.tweet;
  assert.ok(repost.retweeted_tweet);
  assert.ok(repost.text.startsWith(`RT @${repost.retweeted_tweet.author.userName}: `));
  assert.ok(repost.retweeted_tweet.text.length > repost.text.length, "original must exercise the truncated RT copy guard");
  assert.equal(fixture.live.reply.tweet.isReply, true);
  assert.match(fixture.live.reply.tweet.inReplyToUsername!, /^example\d+$/);
});

test("link/card projections keep measured binding arrays and link correspondence", () => {
  const post = fixture.live.linkCard.tweet;
  assert.ok(post.card);
  assert.equal(post.card.name, "summary_large_image");
  assert.ok(Array.isArray(post.card.binding_values));
  for (const key of ["title", "description", "domain", "card_url"]) {
    assert.equal(typeof post.card.binding_values.find((item) => item.key === key)?.value.string_value, "string", key);
  }
  const entity = post.entities.urls.find((item) => item.url === post.card?.url);
  assert.ok(entity, "card and shortened entity URL must refer to the same link");
  assert.ok(post.text.includes(entity.url));
  assert.equal(new URL(entity.expanded_url).hostname, "example.org");
  assert.equal(post.card.binding_values.find((item) => item.key === "card_url")?.value.string_value, entity.url);
});

test("by-id card projection preserves the measured legacy wrapper for the same source", () => {
  const post = fixture.live.linkCardByIds.tweet;
  checkPost(post);
  assert.equal(post.id, fixture.live.linkCard.tweet.id);
  assert.equal(post.url, fixture.live.linkCard.tweet.url);
  assert.equal("binding_values" in post.card, false);
  assert.ok(Array.isArray(post.card.legacy.binding_values));
  const card = post.card.legacy;
  const entity = post.entities.urls.find((item) => item.url === card.url);
  assert.ok(entity);
  assert.equal(card.binding_values.find((item) => item.key === "card_url")?.value.string_value, entity.url);
  assert.equal("article" in post, false, "by-id capture omitted the article key, rather than reporting a preview");
});

test("long text, article preview and alt-text projections cover real consumer fields", () => {
  assert.ok(fixture.live.longPost.tweet.text.length > 700, "exercise the current cap, not merely 280 characters");
  const article = fixture.live.article.tweet.article;
  assert.ok(article);
  assert.deepEqual(Object.keys(article).sort(), ["cover_media_img_url", "preview_text", "title"]);
  assert.equal(typeof article.preview_text, "string");
  assert.ok(fixture.live.photoAlt.tweet.extendedEntities.media.some((media) => typeof media.ext_alt_text === "string"));
});

test("profile/timeline envelopes preserve measured empty pins without inventing a non-null schema", () => {
  const profile = fixture.live.profile.payload.data;
  const parsed = asUser(profile);
  assert.equal(parsed?.handle, profile.userName);
  assert.deepEqual(profile.pinnedTweetIds, []);
  assert.equal(typeof profile.statusesCount, "number");
  assert.equal(typeof profile.mediaCount, "number");
  assert.ok(Array.isArray(profile.entities.url.urls));
  const timeline = fixture.live.timeline.payload;
  assert.equal(timeline.data.pin_tweet, null);
  assert.equal(timeline.data.tweets.length, 1, "bounded example, not a complete page");
  checkPost(timeline.data.tweets[0]);
  assert.equal(timeline.data.tweets[0].author.id, profile.id);
  assert.equal(timeline.data.tweets[0].author.userName, profile.userName);
  assert.equal(typeof timeline.has_next_page, "boolean");
  assert.equal(typeof timeline.next_cursor, "string");
  for (const [name, sample] of Object.entries(fixture.synthetic)) assert.ok(sample.reason.length > 20, `${name} must be explicitly labelled synthetic`);
});

test("fixture prose and handles are synthetic in the consumed fields", () => {
  function check(value: unknown, key = ""): void {
    if (typeof value === "string" && value) {
      if (["text", "description", "location", "title", "preview_text", "ext_alt_text"].includes(key)) {
        assert.match(value, /^(?:RT @example\d+: )?Synthetic /, key);
      }
      if (["userName", "inReplyToUsername"].includes(key)) assert.match(value, /^example\d+$/, key);
      if (key === "name") assert.ok(value.startsWith("Synthetic ") || ["summary", "summary_large_image"].includes(value));
    } else if (Array.isArray(value)) {
      value.forEach((item) => check(item, key));
    } else if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) check(child, childKey);
    }
  }
  check(fixture);
});

test("internal spike fixtures and inventory are excluded from the package", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("!src/fixtures"));
  assert.ok(pkg.files.includes("!docs/upstream-shapes.md"));
});
