import type {
	BotPublicProfile,
	CommentDocument,
	LocalizedText,
	ThreadDocument,
} from "./model";

export type ToolResultContentItem =
	| {
			kind: "thread";
			id: string;
			title?: LocalizedText;
	  }
	| {
			kind: "comment";
			id: string;
			threadId: string;
			body?: LocalizedText;
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
