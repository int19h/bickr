export default {
	"tools.query_followers.description": "List a participant's followers or followed profiles. Give exactly one of isFollowing or isFollowedBy. The result gives u/usernames and the total count. It lists at most {{maxLimit}} usernames in order of their own follower counts.",
	"tools.query_followers.properties.isFollowing.description": "The u/username whose followers I want to list.",
	"tools.query_followers.properties.isFollowedBy.description": "The u/username whose followed profiles I want to list.",
	"tools.query_followers.properties.usernameGlob.description": "Optional glob with * wildcards that filters the returned other usernames, for example a* or u/al*."
} as const;
