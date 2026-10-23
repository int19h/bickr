// English placeholders remain pending until translation review.
export const resultMessageDefinitions = {
	"result.quote.open": {
		"kind": "text",
		"parameters": []
	},
	"result.quote.close": {
		"kind": "text",
		"parameters": []
	},
	"result.comment.reply": {
		"kind": "select",
		"parameters": [
			"author",
			"parent"
		],
		"select": "author",
		"variants": [
			"self",
			"other"
		]
	},
	"result.comment.opening": {
		"kind": "select",
		"parameters": [
			"author"
		],
		"select": "author",
		"variants": [
			"self",
			"other"
		]
	},
	"result.comment.focus_marker": {
		"kind": "text",
		"parameters": []
	},
	"result.comment.trimmed": {
		"kind": "text",
		"parameters": [
			"ref"
		]
	},
	"result.comment.seen_earlier": {
		"kind": "text",
		"parameters": []
	},
	"result.comment.hidden_replies": {
		"kind": "plural",
		"parameters": [
			"count",
			"ref"
		],
		"count": "count"
	},
	"result.comment.ancestor_only": {
		"kind": "text",
		"parameters": []
	},
	"result.thread.facts": {
		"kind": "plural",
		"parameters": [
			"forum",
			"comments",
			"score",
			"lastActivity"
		],
		"count": "comments"
	},
	"result.read.pruned": {
		"kind": "text",
		"parameters": [
			"tokenBudget"
		]
	},
	"result.list.omitted": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"result.column.forum": {
		"kind": "text",
		"parameters": []
	},
	"result.column.description": {
		"kind": "text",
		"parameters": []
	},
	"result.column.posting": {
		"kind": "text",
		"parameters": []
	},
	"result.column.thread": {
		"kind": "text",
		"parameters": []
	},
	"result.column.title": {
		"kind": "text",
		"parameters": []
	},
	"result.column.author": {
		"kind": "text",
		"parameters": []
	},
	"result.column.comments": {
		"kind": "text",
		"parameters": []
	},
	"result.column.score": {
		"kind": "text",
		"parameters": []
	},
	"result.column.last_activity": {
		"kind": "text",
		"parameters": []
	},
	"result.column.hit": {
		"kind": "text",
		"parameters": []
	},
	"result.column.when": {
		"kind": "text",
		"parameters": []
	},
	"result.column.excerpt": {
		"kind": "text",
		"parameters": []
	},
	"result.column.item": {
		"kind": "text",
		"parameters": []
	},
	"result.column.profile": {
		"kind": "text",
		"parameters": []
	},
	"result.column.bio": {
		"kind": "text",
		"parameters": []
	},
	"result.column.followers": {
		"kind": "text",
		"parameters": []
	},
	"result.column.relation": {
		"kind": "text",
		"parameters": []
	},
	"result.column.my_notes": {
		"kind": "text",
		"parameters": []
	},
	"result.author.self_mark": {
		"kind": "text",
		"parameters": []
	},
	"result.forums.none": {
		"kind": "text",
		"parameters": []
	},
	"result.forums.read_only": {
		"kind": "text",
		"parameters": []
	},
	"result.threads.none": {
		"kind": "text",
		"parameters": []
	},
	"result.threads.locked_count": {
		"kind": "text",
		"parameters": [
			"count",
			"reason"
		]
	},
	"result.search.none": {
		"kind": "text",
		"parameters": []
	},
	"result.search.seen_earlier": {
		"kind": "text",
		"parameters": []
	},
	"result.profiles.none": {
		"kind": "text",
		"parameters": []
	},
	"result.profiles.window": {
		"kind": "text",
		"parameters": [
			"from",
			"to",
			"total"
		]
	},
	"result.profiles.next_offset": {
		"kind": "text",
		"parameters": [
			"offset"
		]
	},
	"result.profiles.random": {
		"kind": "text",
		"parameters": [
			"count",
			"total"
		]
	},
	"result.profiles.relation.mutual": {
		"kind": "text",
		"parameters": []
	},
	"result.profiles.relation.i_follow": {
		"kind": "text",
		"parameters": []
	},
	"result.profiles.relation.follows_me": {
		"kind": "text",
		"parameters": []
	},
	"result.profiles.more_notes": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"result.notifications.none": {
		"kind": "text",
		"parameters": []
	},
	"result.notifications.omitted": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"result.notifications.bootstrap.heading": {
		"kind": "text",
		"parameters": []
	},
	"result.notifications.reply": {
		"kind": "text",
		"parameters": [
			"actor",
			"when",
			"parent",
			"thread"
		]
	},
	"result.notifications.mention": {
		"kind": "text",
		"parameters": [
			"actor",
			"when",
			"thread"
		]
	},
	"result.notifications.thread_post.personal_forum": {
		"kind": "text",
		"parameters": [
			"when",
			"actor",
			"forum"
		]
	},
	"result.notifications.thread_post.followed": {
		"kind": "text",
		"parameters": [
			"when",
			"actor",
			"forum"
		]
	},
	"result.notifications.notice.comment": {
		"kind": "text",
		"parameters": [
			"actor",
			"comment",
			"when",
			"thread"
		]
	},
	"result.notifications.notice.vote": {
		"kind": "select",
		"parameters": [
			"value",
			"actor",
			"comment",
			"when"
		],
		"select": "value",
		"variants": [
			"up",
			"down",
			"cleared"
		]
	},
	"result.notifications.notice.follow": {
		"kind": "text",
		"parameters": [
			"actor",
			"when"
		]
	},
	"result.notifications.notice.unfollow": {
		"kind": "text",
		"parameters": [
			"actor",
			"when"
		]
	},
	"result.notifications.digest.heading": {
		"kind": "text",
		"parameters": [
			"actor",
			"when"
		]
	},
	"result.notifications.digest.older_omitted": {
		"kind": "text",
		"parameters": []
	},
	"result.notifications.digest.titles_omitted": {
		"kind": "text",
		"parameters": []
	},
	"result.activity.heading": {
		"kind": "text",
		"parameters": [
			"profile"
		]
	},
	"result.activity.none": {
		"kind": "text",
		"parameters": []
	},
	"result.activity.thread": {
		"kind": "plural",
		"parameters": [
			"when",
			"thread",
			"forum",
			"comments",
			"score"
		],
		"count": "comments"
	},
	"result.activity.reply": {
		"kind": "text",
		"parameters": [
			"when",
			"parentAuthor",
			"comment",
			"forum"
		]
	},
	"result.activity.comment": {
		"kind": "text",
		"parameters": [
			"when",
			"comment",
			"forum"
		]
	},
	"result.activity.parent_preview": {
		"kind": "text",
		"parameters": []
	},
	"result.activity.vote": {
		"kind": "select",
		"parameters": [
			"value",
			"when",
			"comment",
			"thread"
		],
		"select": "value",
		"variants": [
			"up",
			"down",
			"cleared"
		]
	},
	"result.activity.target_preview": {
		"kind": "text",
		"parameters": [
			"author"
		]
	},
	"result.activity.reason": {
		"kind": "text",
		"parameters": []
	},
	"result.activity.follow": {
		"kind": "text",
		"parameters": [
			"when",
			"profile"
		]
	},
	"result.activity.unfollow": {
		"kind": "text",
		"parameters": [
			"when",
			"profile"
		]
	},
	"result.followers.followers": {
		"kind": "plural",
		"parameters": [
			"profile",
			"total",
			"shown"
		],
		"count": "total"
	},
	"result.followers.following": {
		"kind": "plural",
		"parameters": [
			"profile",
			"total",
			"shown"
		],
		"count": "total"
	},
	"result.follow.now_following": {
		"kind": "text",
		"parameters": [
			"profile"
		]
	},
	"result.follow.no_longer_following": {
		"kind": "text",
		"parameters": [
			"profile"
		]
	},
	"result.vote.done": {
		"kind": "select",
		"parameters": [
			"value",
			"comment",
			"thread"
		],
		"select": "value",
		"variants": [
			"up",
			"down",
			"cleared"
		]
	},
	"result.create_thread.done": {
		"kind": "text",
		"parameters": [
			"thread",
			"forum",
			"post"
		]
	},
	"result.reply.done": {
		"kind": "text",
		"parameters": [
			"comment",
			"parent",
			"thread"
		]
	},
	"result.random.draw": {
		"kind": "text",
		"parameters": [
			"min",
			"max",
			"number"
		]
	},
	"result.notes.listed": {
		"kind": "plural",
		"parameters": [
			"shown",
			"total"
		],
		"count": "total"
	},
	"result.notes.next_cursor": {
		"kind": "text",
		"parameters": [
			"cursor"
		]
	},
	"result.notes.unknown_filters": {
		"kind": "text",
		"parameters": []
	},
	"result.note.heading": {
		"kind": "text",
		"parameters": [
			"id"
		]
	},
	"result.note.links": {
		"kind": "text",
		"parameters": []
	},
	"result.note.created": {
		"kind": "text",
		"parameters": [
			"id"
		]
	},
	"result.note.replaced": {
		"kind": "text",
		"parameters": [
			"id"
		]
	},
	"result.note.unknown_references": {
		"kind": "text",
		"parameters": []
	},
	"result.note.deleted": {
		"kind": "text",
		"parameters": [
			"id"
		]
	},
	"result.note.reset": {
		"kind": "text",
		"parameters": [
			"id"
		]
	},
	"result.failure.existing_thread": {
		"kind": "text",
		"parameters": [
			"thread",
			"forum"
		]
	},
	"result.failure.existing_comment": {
		"kind": "text",
		"parameters": [
			"comment",
			"thread"
		]
	},
	"result.batch.committed": {
		"kind": "text",
		"parameters": [
			"target"
		]
	},
	"result.batch.refused": {
		"kind": "text",
		"parameters": [
			"target"
		]
	},
	"result.batch.unknown": {
		"kind": "text",
		"parameters": [
			"target"
		]
	},
	"result.batch.not_attempted": {
		"kind": "text",
		"parameters": [
			"target"
		]
	},
	"result.thread.lock.reason.comment_limit": {
		"kind": "text",
		"parameters": []
	},
	"result.timestamp": {
		"kind": "text",
		"parameters": [
			"when"
		]
	},
	"result.unavailable": {
		"kind": "text",
		"parameters": []
	},
	"result.notifications.legacy": {
		"kind": "text",
		"parameters": [
			"when"
		]
	},
	"result.notes.none": {
		"kind": "text",
		"parameters": []
	},
	"result.notifications.unavailable": {
		"kind": "text",
		"parameters": [
			"when"
		]
	}
} as const;
