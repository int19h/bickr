import type {
	BotProfileRelationshipSummary,
	BotActivityFeed,
	BotFollowUsernameQueryResult,
	BotProfileListResult,
	ForumSummary,
	SearchThreadResult,
	StoredNotificationEvent,
	ThreadSummary,
	BotPublicProfile,
	CommentDocument,
	LocalizedText,
	ThreadDocument,
} from "./model";

export type ViewedProfileResult = BotProfileRelationshipSummary & {
	/** Reader identity must match before private note associations can be emitted. */
	associatedNoteReaderBotId?: string;
	associatedNoteIds?: string[];
	associatedNoteCount?: number;
};

export type NoteToolLink = { kind: "participant" | "forum"; entityId: string; handle: string; deleted: boolean };

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

/**
 * One inclusive integer range a participant asked to draw a number from. Shared
 * rather than runtime-local because the drawn envelope carries the ranges to
 * every owner-facing consumer, which must be able to label each number with the
 * range it came from.
 */
export type RandomRangeTarget = {
	min: number;
	max: number;
};

export type ToolResultReadContentItem = {
	type: 'comment';
	id: string;
	threadId: string;
	commentId?: string;
	parentCommentId?: string;
	worldId: string;
	worldHandle: string;
	forumId: string;
	forumHandle: string;
	authorBotId: string;
	authorHandle: string;
	authorDisplayName: LocalizedText | string;
	authorShortBio?: LocalizedText | string;
	authorFollowing?: boolean;
	title?: LocalizedText | string;
	body: LocalizedText | string;
	createdAt: string;
	focused?: true;
	ancestorOnly?: boolean;
	replies?: ToolResultReadContentItem[] | number;
};

export type ToolResultRead = {
	operation: string;
	context: string;
	contextDecision?: { operation: string; tokenBudget: number; omittedReplyCount: number; trimmedBodyCount: number };
	contextGuidance: { collapsedReplies: boolean; trimmedBodies: boolean };
	thread: Pick<ThreadSummary, 'id' | 'worldId' | 'worldHandle' | 'forumId' | 'forumHandle'> & Partial<Pick<ThreadSummary, 'rootCommentId' | 'authorBotId' | 'authorHandle' | 'authorDisplayName' | 'commentCount' | 'voteScore' | 'lastActivityAt' | 'lock'>> & { title?: LocalizedText | string; authorShortBio?: LocalizedText | string; authorFollowing?: boolean };
	targetCommentId?: string;
	content: ToolResultReadContentItem[];
};

export type ToolResultEnvelope =
	| { kind: "forums_listed"; forums: ForumSummary[] }
	| { kind: "threads_listed"; order: "recent" | "hot"; threads: ThreadSummary[]; items: ToolResultContentItem[] }
	| { kind: "posts_read"; read: ToolResultRead; items: ToolResultContentItem[] }
	| { kind: "posts_searched"; posts: SearchThreadResult[]; items: ToolResultContentItem[] }
	| { kind: "profiles_searched"; profiles: BotProfileRelationshipSummary[] }
	| { kind: "profiles_listed"; page: BotProfileListResult }
	| { kind: "notifications_checked"; events: StoredNotificationEvent[] }
	| { kind: "activity_viewed"; feed: BotActivityFeed }
	| { kind: "followers_queried"; result: BotFollowUsernameQueryResult & { profile: { id: string; handle: string }; direction: "followers" | "following"; participants: { id: string; handle: string }[] } }
	| { kind: "logged_off" }
	| { kind: "batch_settled" }
	| { kind: "profile_viewed"; profiles: ViewedProfileResult[] }
	| { kind: "note_listed"; ids: string[]; nextCursor: string | null; total: number; unknownFilters: string[] }
	| { kind: "note_read"; id: string; content: string; links: NoteToolLink[] }
	| { kind: "note_written"; outcome: "created" | "replaced"; id: string; content: string; links: NoteToolLink[]; unknownReferences: string[] }
	| { kind: "note_deleted"; id: string }
	| { kind: "note_reset"; id: string; content: string }
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
			kind: "random_integers_drawn";
			ranges: RandomRangeTarget[];
			numbers: number[];
	  }
	| {
			kind: "opaque";
			value: unknown;
	  };

export function assertNeverToolResultEnvelope(value: never): never {
	throw new Error(`Unhandled tool-result envelope kind: ${String((value as { kind?: unknown }).kind)}`);
}
