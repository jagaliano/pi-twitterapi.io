import { Type, type TSchema } from "typebox";
import { type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  readPiProjectSettingsResult,
  readPiUserSettingsResult,
  type PiSettings,
  type PiSettingsRead,
} from "./settings.js";
import {
  runTwitterApiAbout,
  runTwitterApiCommunity,
  runTwitterApiFollowers,
  runTwitterApiFollowings,
  runTwitterApiList,
  runTwitterApiMentions,
  runTwitterApiProfile,
  runTwitterApiQuotes,
  runTwitterApiReplies,
  runTwitterApiRetweeters,
  runTwitterApiSearch,
  runTwitterApiSpace,
  runTwitterApiThread,
  runTwitterApiTrends,
  runTwitterApiTweetsByIds,
  runTwitterApiUserSearch,
  runTwitterApiUserTimeline,
} from "./backend.js";
import { tweetIdFromInput, type ReplySort, type TwitterApiSearchParams } from "./twitterapi.js";
import { loadTwitterConfig } from "./config.js";
import type { TwitterSearchDetails } from "./types.js";

export interface TwitterToolOptions {
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  /**
   * A single, trusted settings blob. Kept for back-compat; when set, no project
   * settings are read and every key is treated as user-provided.
   */
  settings?: PiSettings;
  /** User (global) settings. Preferred over `settings`. */
  userSettings?: PiSettings;
  /** Project settings; executable/endpoint/credential keys are ignored and disclosed. */
  projectSettings?: PiSettings;
  /** Directory the project `.pi/settings.json` is read from (default `process.cwd()`). */
  cwd?: string;
  /** Agent config directory for user settings (default pi's `getAgentDir()`). */
  agentDir?: string;
}

/** Modes that locate a specific post through the shared `tweet` argument. */
const TWEET_MODES = new Set(["thread", "replies", "quotes", "retweeters"]);

/** Every read mode the tool accepts, in README order. */
const TWITTER_MODES = [
  "posts",
  "users",
  "thread",
  "user",
  "trends",
  "replies",
  "quotes",
  "mentions",
  "followers",
  "followings",
  "profile",
  "about",
  "tweets",
  "retweeters",
  "community",
  "list",
  "space",
] as const;

type TwitterMode = (typeof TWITTER_MODES)[number];

function isTwitterMode(value: string): value is TwitterMode {
  return (TWITTER_MODES as readonly string[]).includes(value);
}

/**
 * The mode literals as a non-empty tuple, which is what `Type.Union` takes.
 * Built from `TWITTER_MODES` so the schema and the runtime guard cannot drift.
 */
function modeLiterals(): [TSchema, ...TSchema[]] {
  const [first, ...rest] = TWITTER_MODES;
  return [Type.Literal(first), ...rest.map((name) => Type.Literal(name))];
}

/** Per-mode parameter allowlist, so a parameter that does not apply is refused. */
const MODE_PARAMS: Record<TwitterMode, readonly string[]> = {
  posts: ["allowed_x_handles", "excluded_x_handles", "from_date", "to_date", "queryType", "count"],
  users: ["count"],
  thread: [],
  user: ["user", "userId", "includeReplies", "limit"],
  trends: ["woeid", "count"],
  replies: ["replySort", "limit"],
  quotes: ["sinceTime", "untilTime", "includeReplies", "limit"],
  mentions: ["user", "sinceTime", "untilTime", "limit"],
  followers: ["user", "pageSize", "limit"],
  followings: ["user", "pageSize", "limit"],
  profile: ["user"],
  tweets: ["ids"],
  community: ["communityId", "limit"],
  list: ["listId", "limit"],
  space: ["spaceId"],
  about: ["user"],
  retweeters: ["limit"],
};

/** Modes that must be told which account to read. */
const USER_MODES = new Set(["user", "mentions", "followers", "followings", "profile", "about"]);

/** The parameter universe, used to report parameters a mode cannot apply. */
const ALL_PARAMS = [
  "allowed_x_handles",
  "excluded_x_handles",
  "from_date",
  "to_date",
  "queryType",
  "count",
  "user",
  "userId",
  "woeid",
  "includeReplies",
  "sinceTime",
  "untilTime",
  "limit",
  "replySort",
  "ids",
  "pageSize",
  "communityId",
  "listId",
  "spaceId",
] as const;

export function registerTwitterTool(pi: ExtensionAPI, options: TwitterToolOptions = {}): void {
  const env = options.env ?? process.env;
  const fetcher = options.fetcher ?? fetch;
  // A single `settings` blob is trusted (back-compat). Otherwise read user and
  // project settings separately so project-level executable paths, endpoints and
  // credential names can be ignored (B1/F1).
  // Both readers report a malformed file instead of throwing: `twitter` must still
  // be registered, with the problem disclosed, when a settings file has a typo (G2).
  const userRead: PiSettingsRead = options.settings
    ? { settings: options.settings }
    : options.userSettings
      ? { settings: options.userSettings }
      : readPiUserSettingsResult(options.agentDir);
  const projectRead: PiSettingsRead | undefined = options.settings
    ? undefined
    : options.projectSettings
      ? { settings: options.projectSettings }
      : readPiProjectSettingsResult(options.cwd);
  const config = loadTwitterConfig(userRead.settings, {
    projectSettings: projectRead?.settings,
    settingsErrors: [userRead.error, projectRead?.error].filter((error): error is string => Boolean(error)),
  });

  pi.registerTool({
    name: "twitter",
    label: "Twitter",
    description:
      "Read X/Twitter via twitterapi.io and return an answer with citation URLs. Modes: posts (default), " +
      "users, thread, user (account timeline), trends, replies, quotes, mentions, followers, followings, " +
      "profile, about, tweets, retweeters, community, list and space. Retrieved content is synthesized into " +
      "an answer by a configured pi model.",
    promptSnippet: "Read X/Twitter via twitterapi.io (posts, users, thread, user timeline, trends, replies, quotes, mentions, followers, followings, profile, about, tweets, retweeters, community, list, space) and return an answer with citation URLs",
    promptGuidelines: [
      "Use twitter when the user needs current discussion or sentiment from X/Twitter and twitterapi.io is configured.",
      "Use mode \"users\" to discover accounts; use mode \"user\" to read a specific account's recent posts.",
      "Use mode \"thread\" with a tweet id or permalink to read a post's whole thread.",
      "Use mode \"replies\" or mode \"quotes\" to read the conversation around a specific post.",
      "Use mode \"retweeters\" with a tweet id or permalink to list the accounts that reposted it.",
      "Use mode \"trends\" with a woeid (1=Worldwide, 23424977=USA) for trending topics.",
      "Use allowed_x_handles and excluded_x_handles with mode \"posts\" to narrow or exclude accounts.",
      "Use from_date and to_date with mode \"posts\" for date ranges; dates must be YYYY-MM-DD.",
      "Do not use twitter as a raw tweet API; it returns an answer and citation URLs, not guaranteed original post objects.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language question or search query. Required for every mode." }),
      mode: Type.Optional(
        Type.Union(modeLiterals(), {
          description: 'What to read: "posts" (default), "users", "thread", "user", "trends", "replies", "quotes", "mentions", "followers", "followings", "profile", "about", "tweets", "retweeters", "community", "list", or "space".',
        }),
      ),
      tweet: Type.Optional(Type.String({ description: 'Post id or X permalink. Required for mode=thread/replies/quotes/retweeters; refused in any other mode.' })),
      user: Type.Optional(Type.String({ description: "X handle (no @) for mode=user, mentions, followers, followings, profile or about." })),
      userId: Type.Optional(Type.String({ description: "Numeric user id for mode=user; preferred over `user` when known." })),
      ids: Type.Optional(Type.Array(Type.String(), { description: "mode=tweets: post ids or X permalinks to fetch (max 100)." })),
      pageSize: Type.Optional(Type.Number({ description: "mode=followers/followings: accounts per page (20–200)." })),
      communityId: Type.Optional(Type.String({ description: "mode=community: the community id." })),
      listId: Type.Optional(Type.String({ description: "mode=list: the list id." })),
      spaceId: Type.Optional(Type.String({ description: "mode=space: the X Space id." })),
      woeid: Type.Optional(Type.Number({ description: "Yahoo Where-On-Earth id for mode=trends (1=Worldwide, 23424977=USA)." })),
      includeReplies: Type.Optional(Type.Boolean({ description: "Include replies: mode=user (timeline) and mode=quotes." })),
      sinceTime: Type.Optional(Type.Number({ description: "mode=quotes/mentions: only items on or after this unix timestamp (seconds)." })),
      untilTime: Type.Optional(Type.Number({ description: "mode=quotes/mentions: only items before this unix timestamp (seconds)." })),
      limit: Type.Optional(Type.Number({ description: "mode=user/mentions/followers/followings/replies/quotes/retweeters/community/list: stop after this many items (max 1000)." })),
      replySort: Type.Optional(
        Type.Union([Type.Literal("Relevance"), Type.Literal("Latest"), Type.Literal("Likes")], {
          description: 'mode=replies sort order: "Relevance" (default), "Latest", or "Likes".',
        }),
      ),
      allowed_x_handles: Type.Optional(Type.Array(Type.String(), { description: "mode=posts: only posts from these handles (max 20, no @)." })),
      excluded_x_handles: Type.Optional(Type.Array(Type.String(), { description: "mode=posts: exclude these handles (max 20, no @)." })),
      from_date: Type.Optional(Type.String({ description: "mode=posts: start date, YYYY-MM-DD." })),
      to_date: Type.Optional(Type.String({ description: "mode=posts: end date, YYYY-MM-DD." })),
      queryType: Type.Optional(
        Type.Union([Type.Literal("Latest"), Type.Literal("Top")], {
          description: 'mode=posts: "Latest" (default, newest first) or "Top" (ranked).',
        }),
      ),
      count: Type.Optional(Type.Number({ description: "mode=posts/users: max items (posts default 10, accounts default 20; max 50). mode=trends: number of trends (min 30)." })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const supplied = params as Record<string, unknown>;
      const requested = typeof supplied.mode === "string" ? supplied.mode : "posts";
      if (!isTwitterMode(requested)) {
        throw new Error(
          `twitter mode must be one of ${TWITTER_MODES.map((name) => `"${name}"`).join(", ")} (got "${requested}")`,
        );
      }
      const mode = requested;

      // The question is validated first: every mode answers it, and a blank one
      // must fail before any retrieval.
      const question = typeof supplied.query === "string" ? supplied.query.trim() : "";
      if (!question) throw new Error("twitter query must not be empty");

      // `tweet` locates a post for the thread/reply/quote modes, and is refused
      // elsewhere rather than silently ignored.
      const tweet = typeof supplied.tweet === "string" ? supplied.tweet : undefined;
      let tweetReference = "";
      if (TWEET_MODES.has(mode)) {
        if (!tweet || !tweet.trim()) {
          throw new Error(`twitter mode "${mode}" needs a tweet: pass a numeric post id or an X permalink as \`tweet\`.`);
        }
        const id = tweetIdFromInput(tweet);
        if (!id) throw new Error(`twitter tweet must be a numeric post id or an X permalink (got "${tweet}")`);
        tweetReference = `https://x.com/i/status/${id}`;
      } else if (tweet !== undefined) {
        throw new Error(
          `twitter tweet can only be used in modes ${[...TWEET_MODES].map((name) => `"${name}"`).join(", ")} ` +
            `(mode is "${mode}"); remove it or change mode.`,
        );
      }

      if (mode === "user" && supplied.user === undefined && supplied.userId === undefined) {
        throw new Error('twitter mode "user" needs `user` (a handle) or `userId`.');
      }
      if (USER_MODES.has(mode) && mode !== "user" && supplied.user === undefined) {
        throw new Error(`twitter mode "${mode}" needs \`user\` (an X handle).`);
      }
      if (mode === "tweets") {
        const ids = supplied.ids;
        if (!Array.isArray(ids) || ids.length === 0) {
          throw new Error('twitter mode "tweets" needs `ids` (an array of post ids or permalinks).');
        }
      }
      for (const [required, param] of [
        ["communityId", "community"],
        ["listId", "list"],
        ["spaceId", "space"],
      ] as const) {
        if (mode === param && (supplied[required] === undefined || String(supplied[required]).trim() === "")) {
          throw new Error(`twitter mode "${param}" needs \`${required}\`.`);
        }
      }
      if (mode === "trends" && !Number.isInteger(supplied.woeid)) {
        throw new Error('twitter mode "trends" needs `woeid` (an integer; 1=Worldwide, 23424977=USA).');
      }

      if (!env.TWITTERAPI_IO_API_KEY) {
        throw new Error(
          "twitter needs credentials: set TWITTERAPI_IO_API_KEY (twitterapi.io). The answer is synthesized by " +
            "twitter.synthesisModel, or by the model running this session when that setting is unset.",
        );
      }

      // The synthesis model falls back to the model running this session, so a
      // key-only setup works without extra configuration. An explicit
      // twitter.synthesisModel always wins.
      const sessionModelId = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const synthesisModel = config.synthesisModel ?? sessionModelId;
      const effectiveConfig = synthesisModel === config.synthesisModel ? config : { ...config, synthesisModel };
      // When the configured model fails at runtime, the answer is retried with
      // the session model — but only when it is a different model.
      const fallbackModelIds = config.synthesisModel && sessionModelId ? [sessionModelId] : undefined;
      const base = {
        config: effectiveConfig,
        env,
        fetcher,
        signal,
        registry: ctx?.modelRegistry,
        fallbackModelIds,
      } as const;

      // A mode that cannot apply a parameter must say so. Silently ignoring it
      // is how an excluded account ends up in a successful answer.
      const disallowed = ALL_PARAMS.filter((name) => !MODE_PARAMS[mode].includes(name));
      const offending = disallowed.filter((name) => supplied[name] !== undefined);
      if (offending.length > 0) {
        const list = offending.join(", ");
        throw new Error(
          `twitter ${list} cannot be applied in mode "${mode}"; remove ${offending.length === 1 ? "it" : "them"}.`,
        );
      }

      const number = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
      const boolean = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
      const text = (value: unknown): string | undefined =>
        typeof value === "string" && value.trim() ? value.trim() : undefined;

      if (mode === "users") {
        const { markdown, details } = await runTwitterApiUserSearch({
          query: question,
          count: number(supplied.count),
          ...base,
        });
        return { content: [{ type: "text", text: markdown }], details };
      }

      if (mode === "thread") {
        const { markdown, details } = await runTwitterApiThread({ tweet: tweetReference, query: question, ...base });
        return { content: [{ type: "text", text: markdown }], details };
      }

      if (mode === "user") {
        const { markdown, details } = await runTwitterApiUserTimeline({
          query: question,
          userName: text(supplied.user),
          userId: text(supplied.userId),
          includeReplies: boolean(supplied.includeReplies),
          limit: number(supplied.limit),
          ...base,
        });
        return { content: [{ type: "text", text: markdown }], details };
      }

      if (mode === "trends") {
        const { markdown, details } = await runTwitterApiTrends({
          query: question,
          woeid: number(supplied.woeid) as number,
          count: number(supplied.count),
          ...base,
        });
        return { content: [{ type: "text", text: markdown }], details };
      }

      if (mode === "replies") {
        const { markdown, details } = await runTwitterApiReplies({
          query: question,
          tweet: tweetReference,
          queryType: text(supplied.replySort) as ReplySort | undefined,
          limit: number(supplied.limit),
          ...base,
        });
        return { content: [{ type: "text", text: markdown }], details };
      }

      if (mode === "quotes") {
        const { markdown, details } = await runTwitterApiQuotes({
          query: question,
          tweet: tweetReference,
          sinceTime: number(supplied.sinceTime),
          untilTime: number(supplied.untilTime),
          includeReplies: boolean(supplied.includeReplies),
          limit: number(supplied.limit),
          ...base,
        });
        return { content: [{ type: "text", text: markdown }], details };
      }

      if (mode === "mentions") {
        const { markdown, details } = await runTwitterApiMentions({
          query: question,
          userName: text(supplied.user) as string,
          sinceTime: number(supplied.sinceTime),
          untilTime: number(supplied.untilTime),
          limit: number(supplied.limit),
          ...base,
        });
        return { content: [{ type: "text", text: markdown }], details };
      }

      if (mode === "followers" || mode === "followings") {
        const runner = mode === "followers" ? runTwitterApiFollowers : runTwitterApiFollowings;
        const { markdown, details } = await runner({
          query: question,
          userName: text(supplied.user) as string,
          pageSize: number(supplied.pageSize),
          limit: number(supplied.limit),
          ...base,
        });
        return { content: [{ type: "text", text: markdown }], details };
      }

      if (mode === "profile") {
        const { markdown, details } = await runTwitterApiProfile({
          query: question,
          userName: text(supplied.user) as string,
          ...base,
        });
        return { content: [{ type: "text", text: markdown }], details };
      }

      if (mode === "tweets") {
        const ids = (supplied.ids as unknown[]).map((value) => String(value));
        const { markdown, details } = await runTwitterApiTweetsByIds({ query: question, ids, ...base });
        return { content: [{ type: "text", text: markdown }], details };
      }

      if (mode === "about") {
        const { markdown, details } = await runTwitterApiAbout({
          query: question,
          userName: text(supplied.user) as string,
          ...base,
        });
        return { content: [{ type: "text", text: markdown }], details };
      }

      if (mode === "retweeters") {
        const { markdown, details } = await runTwitterApiRetweeters({
          query: question,
          tweet: tweetReference,
          limit: number(supplied.limit),
          ...base,
        });
        return { content: [{ type: "text", text: markdown }], details };
      }

      if (mode === "community") {
        const { markdown, details } = await runTwitterApiCommunity({
          query: question,
          communityId: text(supplied.communityId) as string,
          limit: number(supplied.limit),
          ...base,
        });
        return { content: [{ type: "text", text: markdown }], details };
      }

      if (mode === "list") {
        const { markdown, details } = await runTwitterApiList({
          query: question,
          listId: text(supplied.listId) as string,
          limit: number(supplied.limit),
          ...base,
        });
        return { content: [{ type: "text", text: markdown }], details };
      }

      if (mode === "space") {
        const { markdown, details } = await runTwitterApiSpace({
          query: question,
          spaceId: text(supplied.spaceId) as string,
          ...base,
        });
        return { content: [{ type: "text", text: markdown }], details };
      }

      const { markdown, details } = await runTwitterApiSearch({
        params: { ...(params as TwitterApiSearchParams), query: question },
        ...base,
      });
      return { content: [{ type: "text", text: markdown }], details };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      let line = theme.fg("toolTitle", theme.bold("twitter "));
      const mode = typeof (args as { mode?: unknown }).mode === "string" ? (args as { mode: string }).mode : "posts";
      if (mode !== "posts") line += theme.fg("warning", `[${mode}] `);
      const subject =
        mode !== "posts" && (args as { tweet?: unknown }).tweet !== undefined
          ? String((args as { tweet?: unknown }).tweet)
          : mode === "user" || mode === "trends"
            ? String((args as { user?: unknown }).user ?? (args as { woeid?: unknown }).woeid ?? args.query ?? "")
            : args.query ?? "";
      line += theme.fg("accent", subject);
      const handles = args.allowed_x_handles ?? args.excluded_x_handles;
      if (Array.isArray(handles) && handles.length > 0) line += theme.fg("muted", ` · ${handles.map((handle) => `@${handle}`).join(",")}`);
      if (args.from_date || args.to_date) line += theme.fg("dim", ` · ${args.from_date ?? "…"}..${args.to_date ?? "…"}`);
      text.setText(line);
      return text;
    },

    renderResult(result, options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

      if (options.isPartial) {
        text.setText(theme.fg("muted", "Reading X…"));
        return text;
      }

      if (context.isError || !result.details) {
        const raw = result.content.find((content) => content.type === "text")?.text ?? "";
        text.setText(theme.fg("error", raw));
        return text;
      }

      const details = result.details as TwitterSearchDetails;
      const header = theme.fg("success", `✓ Twitter`) + theme.fg("muted", ` · ${details.citations.length} citations · ${details.synthesisCalls ?? 0} synthesis calls`);
      const sources = details.citations.slice(0, options.expanded ? details.citations.length : 5);
      const rows = sources.map((url, index) => `${theme.fg("dim", `${index + 1}.`)} ${theme.fg("accent", url)}`);
      let body = rows.length > 0 ? `\n${rows.join("\n")}` : "";
      const remaining = details.citations.length - sources.length;
      if (remaining > 0) {
        body += theme.fg("muted", `\n… (${remaining} more citations, `) + keyHint("app.tools.expand", "to expand") + theme.fg("muted", ")");
      }
      // Notes carry disclosures (coverage gap, skipped media, dropped links).
      // Showing them collapsed would hide information the markdown result
      // already surfaces, so they appear once the user expands the call.
      if (details.notes?.length && options.expanded) {
        body += "\n" + details.notes.map((note) => theme.fg("muted", `• ${note}`)).join("\n");
      } else if (details.notes?.length) {
        body += theme.fg("muted", `\n• ${details.notes.length} note(s), `) + keyHint("app.tools.expand", "to expand");
      }

      text.setText(header + body);
      return text;
    },
  });
}
