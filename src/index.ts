import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTwitterTool } from "./tool.js";

/**
 * pi-twitterapi.io — a twitterapi.io-backed X/Twitter search extension for the
 * pi coding agent.
 *
 * Registers the `twitter` tool, which reads X/Twitter through twitterapi.io and
 * synthesizes an answer with citation URLs using a pi model. Requires
 * `TWITTERAPI_IO_API_KEY`; synthesis uses `twitter.synthesisModel`, falling back
 * to the model running the session.
 */
export default function (pi: ExtensionAPI) {
  registerTwitterTool(pi);
}

export { registerTwitterTool, type TwitterToolOptions } from "./tool.js";
export {
  runTwitterApiCommunity,
  runTwitterApiFollowers,
  runTwitterApiFollowings,
  runTwitterApiList,
  runTwitterApiMentions,
  runTwitterApiProfile,
  runTwitterApiQuotes,
  runTwitterApiReplies,
  runTwitterApiSearch,
  runTwitterApiSpace,
  runTwitterApiThread,
  runTwitterApiTrends,
  runTwitterApiTweetsByIds,
  runTwitterApiUserSearch,
  runTwitterApiUserTimeline,
  resolveModel,
  assistantText,
  classifySynthesisError,
  completionText,
  createFetchMedia,
  isAllowedMediaUrl,
  synthesisRetryDelayMs,
  toSynthesisModel,
} from "./backend.js";
export type {
  BackendOptions,
  ModelLike,
  RegistryLike,
  SynthesisFailureKind,
  TwitterApiCommunityOptions,
  TwitterApiFollowOptions,
  TwitterApiListOptions,
  TwitterApiMentionsOptions,
  TwitterApiProfileOptions,
  TwitterApiQuotesOptions,
  TwitterApiRepliesOptions,
  TwitterApiRunOptions,
  TwitterApiSpaceOptions,
  TwitterApiSynthesisOptions,
  TwitterApiThreadOptions,
  TwitterApiTrendsOptions,
  TwitterApiTweetsByIdsOptions,
  TwitterApiUserSearchOptions,
  TwitterApiUserTimelineOptions,
} from "./backend.js";
export { DEFAULT_MAX_MEDIA_PER_SEARCH, loadTwitterConfig } from "./config.js";
export type { TwitterConfig } from "./config.js";
export {
  buildCandidatePrompt,
  buildTrendCandidatePrompt,
  DOCUMENT_SYNTHESIS_SYSTEM_PROMPT,
  collectMedia,
  deriveCitations,
  extractUrls,
  statusId,
  SYNTHESIS_SYSTEM_PROMPT,
  synthesizeAnswer,
  synthesizeDocument,
  synthesizeTrends,
  synthesizeUserAnswer,
  toBase64,
  TREND_SYNTHESIS_SYSTEM_PROMPT,
  USER_SYNTHESIS_SYSTEM_PROMPT,
} from "./synthesize.js";
export type { ImageAttachment, SynthesisModel } from "./synthesize.js";
export {
  buildExpression,
  fetchCommunityTweets,
  fetchFollowers,
  fetchFollowings,
  fetchListTweets,
  fetchSpaceDetail,
  fetchThread,
  fetchTrends,
  fetchTweetQuotes,
  fetchTweetReplies,
  fetchTweetsByIds,
  fetchUserMentions,
  fetchUserProfile,
  fetchUserTweets,
  normalizeParams,
  searchTweets,
  searchUsers,
  statusIdFromUrl,
  tweetIdFromInput,
} from "./twitterapi.js";
export type {
  FollowersDetails,
  ReplySort,
  SearchDetails,
  SpaceDetails,
  Trend,
  TrendsDetails,
  Tweet,
  TweetCollection,
  TweetQuotesDetails,
  TweetRepliesDetails,
  TwitterApiSearchParams,
  UserCollection,
  UserMentionsDetails,
  UserTweetsDetails,
} from "./twitterapi.js";
export type { TwitterSearchDetails } from "./types.js";
export { readMergedPiSettings, readPiProjectSettings, readPiUserSettings } from "./settings.js";
export type { PiSettings } from "./settings.js";
