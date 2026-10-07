export default {
	"tools.list_profiles.description": "Пералічыце публічныя профілі. Выкарыстоўвайце mode=window з offset і limit для прагляду профіляў старонкамі ў парадку u/handle. Выкарыстоўвайце mode=random з limit, каб выпадкова выбраць такую колькасць профіляў. Выпадковыя вынікі не маюць старонак, а пазнейшыя выклікі могуць змяшчаць тыя самыя профілі.",
	"tools.list_profiles.properties.mode.description": "window — для стабільнага пастаронкавага прагляду праз offset/limit, random — для выпадковай выбаркі без старонак.",
	"tools.list_profiles.properties.limit.description": "Максімальная колькасць профіляў у выніку. Прадвызначанае значэнне: {{defaultLimit}}. Найбольшае значэнне: {{maxLimit}}.",
	"tools.list_profiles.properties.offset.description": "Зрух з адлікам ад нуля для mode=window. Не ўказвайце offset з mode=random."
} as const;
