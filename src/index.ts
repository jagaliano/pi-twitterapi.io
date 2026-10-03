import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTwitterTool } from "./tool.js";

/**
 * pi-twitterapi.io — a twitterapi.io-backed X/Twitter search extension for the
 * pi coding agent.
 *
 * Registers the `twitter` tool, which retrieves posts, accounts or a thread from
 * twitterapi.io and synthesizes an answer with citation URLs using a configured
 * pi model. Requires `TWITTERAPI_IO_API_KEY` and `twitter.synthesisModel`.
 *
 * Unlike `@pi-lab/xsearch` this extension has no xAI backend: twitterapi.io is
 * the retrieval source and pi's own model registry performs the synthesis.
 */
export default function (pi: ExtensionAPI) {
  registerTwitterTool(pi);
}

export { registerTwitterTool, type TwitterToolOptions } from "./tool.js";
export {
  runTwitterApiQuotes,
  runTwitterApiReplies,
  runTwitterApiSearch,
  runTwitterApiThread,
  runTwitterApiTrends,
  runTwitterApiUserSearch,
  runTwitterApiUserTimeline,
  resolveModel,
  assistantText,
  completionText,
  createFetchMedia,
  isAllowedMediaUrl,
  toSynthesisModel,
} from "./backend.js";
export type {
  BackendOptions,
  ModelLike,
  RegistryLike,
  TwitterApiQuotesOptions,
  TwitterApiRepliesOptions,
  TwitterApiRunOptions,
  TwitterApiSynthesisOptions,
  TwitterApiThreadOptions,
  TwitterApiTrendsOptions,
  TwitterApiUserSearchOptions,
  TwitterApiUserTimelineOptions,
} from "./backend.js";
export { DEFAULT_MAX_MEDIA_PER_SEARCH, loadTwitterConfig } from "./config.js";
export type { TwitterConfig } from "./config.js";
export {
  buildCandidatePrompt,
  buildTrendCandidatePrompt,
  collectMedia,
  deriveCitations,
  extractUrls,
  statusId,
  SYNTHESIS_SYSTEM_PROMPT,
  synthesizeAnswer,
  synthesizeTrends,
  synthesizeUserAnswer,
  toBase64,
  TREND_SYNTHESIS_SYSTEM_PROMPT,
  USER_SYNTHESIS_SYSTEM_PROMPT,
} from "./synthesize.js";
export type { ImageAttachment, SynthesisModel } from "./synthesize.js";
export {
  buildExpression,
  fetchThread,
  fetchTrends,
  fetchTweetQuotes,
  fetchTweetReplies,
  fetchUserTweets,
  normalizeParams,
  searchTweets,
  searchUsers,
  statusIdFromUrl,
  tweetIdFromInput,
} from "./twitterapi.js";
export type {
  ReplySort,
  SearchDetails,
  Trend,
  TrendsDetails,
  Tweet,
  TweetCollection,
  TweetQuotesDetails,
  TweetRepliesDetails,
  TwitterApiSearchParams,
  UserTweetsDetails,
} from "./twitterapi.js";
export type { TwitterSearchDetails } from "./types.js";
export { readMergedPiSettings, readPiProjectSettings, readPiUserSettings } from "./settings.js";
export type { PiSettings } from "./settings.js";
