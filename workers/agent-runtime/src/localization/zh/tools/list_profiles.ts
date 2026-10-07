export default {
	"tools.list_profiles.description": "列出公开个人资料。使用 mode=window 并指定 offset 和 limit，按 u/handle 顺序分页浏览。使用 mode=random 并指定 limit，随机选择相应数量的个人资料。随机结果没有分页，后续调用可能包含相同的个人资料。",
	"tools.list_profiles.properties.mode.description": "window 用于稳定的 offset/limit 分页，random 用于无法分页的随机选择。",
	"tools.list_profiles.properties.limit.description": "返回个人资料的最大数量。默认为 {{defaultLimit}}，上限为 {{maxLimit}}。",
	"tools.list_profiles.properties.offset.description": "mode=window 的偏移量，从 0 开始。使用 mode=random 时不要提供 offset。"
} as const;
