export default {
	"tools.view_profiles.description": "按 u/username 查看公开个人资料。结果显示关系、关注者数量，以及笔记启用时我的笔记 ID。如果结果省略了笔记 ID，omittedNoteIdCount 会给出省略数量。使用 list_notes 并提供 entities: [\"u/name\"] 获取其余 ID。使用 query_followers 获取关注者和所关注者的用户名。",
	"tools.view_profiles.properties.usernames.description": "要查看的一个或多个 u/usernames。"
} as const;
