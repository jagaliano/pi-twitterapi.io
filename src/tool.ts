import { Type } from "@sinclair/typebox";
import { type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readMergedPiSettings, type PiSettings } from "./settings.js";
import { runTwitterApiSearch, runTwitterApiThread, runTwitterApiUserSearch } from "./backend.js";
import { tweetIdFromInput, type TwitterApiSearchParams } from "./twitterapi.js";
import { loadTwitterConfig } from "./config.js";
import type { TwitterSearchDetails } from "./types.js";

export interface TwitterToolOptions {
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  settings?: PiSettings;
}

export function registerTwitterTool(pi: ExtensionAPI, options: TwitterToolOptions = {}): void {
  const env = options.env ?? process.env;
  const fetcher = options.fetcher ?? fetch;
  const settings = options.settings ?? readMergedPiSettings();
  const config = loadTwitterConfig(settings);

  pi.registerTool({
    name: "twitter",
    label: "Twitter",
    description:
      "Search X/Twitter via twitterapi.io and return an answer with citation URLs. " +
      "Supports post search, account (user) search, and thread fetch; retrieved posts are " +
      "synthesized into an answer by a configured pi model.",
    promptSnippet: "Search X/Twitter via twitterapi.io for realtime posts, accounts, or a thread, and return an answer with citation URLs",
    promptGuidelines: [
      "Use twitter when the user needs current discussion or sentiment from X/Twitter and twitterapi.io is configured.",
      "Use mode \"users\" when the user wants to find or discover X accounts rather than posts.",
      "Use mode \"thread\" with a tweet id or permalink to read a specific post's whole thread.",
      "Use allowed_x_handles when the user asks to search specific X accounts.",
      "Use excluded_x_handles when the user asks to exclude specific X accounts.",
      "Use from_date and to_date for date ranges; dates must be YYYY-MM-DD.",
      "Do not use twitter as a raw tweet API; it returns an answer and citation URLs, not guaranteed original post objects.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language X/Twitter search query. For mode=users, the keyword matched against account names, handles and bios." }),
      mode: Type.Optional(Type.String({ description: 'What to search: "posts" (default), "users" (discover accounts), or "thread" (a post\'s thread context).' })),
      tweet: Type.Optional(Type.String({ description: 'Required for mode=thread: a numeric post id or an X permalink belonging to the thread. Refused in any other mode.' })),
      allowed_x_handles: Type.Optional(Type.Array(Type.String(), { description: "Only consider posts from these X handles (max 20). Do not include @." })),
      excluded_x_handles: Type.Optional(Type.Array(Type.String(), { description: "Exclude posts from these X handles (max 20). Do not include @." })),
      from_date: Type.Optional(Type.String({ description: "Start date for search range, YYYY-MM-DD." })),
      to_date: Type.Optional(Type.String({ description: "End date for search range, YYYY-MM-DD." })),
      queryType: Type.Optional(Type.String({ description: '"Latest" (default, newest first) or "Top" (ranked).' })),
      count: Type.Optional(Type.Number({ description: "Max items to consider and cite — posts (default 10) or accounts (default 20); max 50." })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // Argument validation comes first: an invalid call should be reported as
      // such rather than as a missing key.
      const supplied = params as Record<string, unknown>;
      const mode = typeof supplied.mode === "string" ? supplied.mode : "posts";
      if (mode !== "posts" && mode !== "users" && mode !== "thread") {
        throw new Error(`twitter mode must be "posts", "users", or "thread" (got "${mode}")`);
      }
      const tweet = typeof supplied.tweet === "string" ? supplied.tweet : undefined;
      if (mode !== "thread" && tweet !== undefined) {
        throw new Error(
          `twitter tweet can only be used in mode "thread" (mode is "${mode}"); remove it or set mode to "thread".`,
        );
      }
      // Canonicalised once so an invalid reference fails before any retrieval.
      let threadReference = "";
      if (mode === "thread") {
        if (!tweet || !tweet.trim()) {
          throw new Error('twitter mode "thread" needs a tweet: pass a numeric post id or an X permalink as `tweet`.');
        }
        const id = tweetIdFromInput(tweet);
        if (!id) {
          throw new Error(`twitter tweet must be a numeric post id or an X permalink (got "${tweet}")`);
        }
        threadReference = `https://x.com/i/status/${id}`;
      }

      const question = typeof supplied.query === "string" ? supplied.query.trim() : "";
      if (!question) throw new Error("twitter query must not be empty");

      if (!env.TWITTERAPI_IO_API_KEY) {
        throw new Error(
          "twitter needs credentials: set TWITTERAPI_IO_API_KEY (twitterapi.io) and twitter.synthesisModel " +
            "(a pi model id used to synthesize the answer).",
        );
      }

      // A mode that cannot apply a parameter must say so. Silently ignoring them
      // is how an excluded account ends up in a successful answer.
      const reject = (names: string[]): void => {
        const offending = names.filter((name) => supplied[name] !== undefined);
        if (offending.length === 0) return;
        const list = offending.join(", ");
        throw new Error(
          offending.length === 1
            ? `twitter ${list} cannot be applied in mode "${mode}"; remove it or use mode "posts".`
            : `twitter ${list} cannot be applied in mode "${mode}"; remove them or use mode "posts".`,
        );
      };

      if (mode === "users") {
        reject(["allowed_x_handles", "excluded_x_handles", "from_date", "to_date", "queryType"]);
        const { markdown, details } = await runTwitterApiUserSearch({
          query: question,
          count: (params as TwitterApiSearchParams).count,
          config,
          env,
          fetcher,
          signal,
          registry: ctx?.modelRegistry,
        });
        return { content: [{ type: "text", text: markdown }], details };
      }

      if (mode === "thread") {
        reject(["allowed_x_handles", "excluded_x_handles", "from_date", "to_date", "queryType", "count"]);
        const { markdown, details } = await runTwitterApiThread({
          tweet: threadReference,
          // Keep the question: the reference only locates the thread.
          query: question,
          config,
          env,
          fetcher,
          signal,
          registry: ctx?.modelRegistry,
        });
        return { content: [{ type: "text", text: markdown }], details };
      }

      const { markdown, details } = await runTwitterApiSearch({
        params: { ...(params as TwitterApiSearchParams), query: question },
        config,
        env,
        fetcher,
        signal,
        // No cast: RegistryLike only requires find/getAll, which every supported
        // ModelRegistry provides. `complete` is optional there and detected at
        // call time, so an incompatible registry fails with a clear error rather
        // than being asserted away here.
        registry: ctx?.modelRegistry,
      });
      return { content: [{ type: "text", text: markdown }], details };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      let line = theme.fg("toolTitle", theme.bold("twitter "));
      const mode = typeof (args as { mode?: unknown }).mode === "string" ? (args as { mode: string }).mode : "posts";
      if (mode !== "posts") line += theme.fg("warning", `[${mode}] `);
      line += theme.fg("accent", mode === "thread" ? String((args as { tweet?: unknown }).tweet ?? "") : args.query ?? "");
      const handles = args.allowed_x_handles ?? args.excluded_x_handles;
      if (Array.isArray(handles) && handles.length > 0) line += theme.fg("muted", ` · ${handles.map((handle) => `@${handle}`).join(",")}`);
      if (args.from_date || args.to_date) line += theme.fg("dim", ` · ${args.from_date ?? "…"}..${args.to_date ?? "…"}`);
      text.setText(line);
      return text;
    },

    renderResult(result, options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

      if (options.isPartial) {
        text.setText(theme.fg("muted", "Searching X…"));
        return text;
      }

      if (context.isError || !result.details) {
        const raw = result.content.find((content) => content.type === "text")?.text ?? "";
        text.setText(theme.fg("error", raw));
        return text;
      }

      const details = result.details as TwitterSearchDetails;
      const header = theme.fg("success", `✓ Twitter search`) + theme.fg("muted", ` · ${details.citations.length} citations · ${details.synthesisCalls ?? 0} synthesis calls`);
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
