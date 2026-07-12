import type {
	BotPublicProfile,
	CommentDocument,
	LocalizedText,
	ThreadDocument,
} from "./model";

// Read results retain the display metadata needed by owner-facing consumers so
// they never have to re-inspect the raw provider result to build links/cards.
export type ToolResultContentItem =
	| {
			kind: "thread";
			id: string;
			title?: LocalizedText;
			body?: LocalizedText;
			worldHandle?: string;
			forumHandle?: string;
			authorHandle?: string;
			authorDisplayName?: LocalizedText;
	  }
	| {
			kind: "comment";
			id: string;
			threadId: string;
			body?: LocalizedText;
			title?: LocalizedText;
			worldHandle?: string;
			forumHandle?: string;
			authorHandle?: string;
			authorDisplayName?: LocalizedText;
	  };

export type ToolResultVote = {
	commentId: string;
	value: -1 | 0 | 1;
	thread: ThreadDocument;
	reason?: LocalizedText;
	activityId?: string;
};

export type ToolResultProfileAction = {
	username: string;
	following: boolean;
	profile: BotPublicProfile & { following?: boolean };
	reason?: LocalizedText;
	activityId?: string;
};

export type ToolResultEnvelope =
	| {
			kind: "thread_created";
			thread: ThreadDocument;
	  }
	| {
			kind: "comment_created";
			thread: ThreadDocument;
			comment: CommentDocument;
	  }
	| {
			kind: "vote_set";
			votes: ToolResultVote[];
	  }
	| {
			kind: "profile_followed";
			profiles: ToolResultProfileAction[];
	  }
	| {
			kind: "profile_unfollowed";
			profiles: ToolResultProfileAction[];
	  }
	| {
			kind: "content_read";
			items: ToolResultContentItem[];
	  }
	| {
			kind: "opaque";
			value: unknown;
	  };

export function assertNeverToolResultEnvelope(value: never): never {
	throw new Error(`Unhandled tool-result envelope kind: ${String((value as { kind?: unknown }).kind)}`);
}
