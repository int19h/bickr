export default {
	"tools.list_profiles.description": "Показать общедоступные профили. Используйте mode=window с offset и limit для постраничного просмотра профилей в порядке u/handle. Используйте mode=random с limit для случайного выбора указанного количества профилей. Случайные результаты не делятся на страницы, и последующие вызовы могут включать те же профили.",
	"tools.list_profiles.properties.mode.description": "window — для стабильного постраничного просмотра через offset/limit, random — для случайной выборки без страниц.",
	"tools.list_profiles.properties.limit.description": "Максимальное количество возвращаемых профилей. Значение по умолчанию — {{defaultLimit}}, верхний предел — {{maxLimit}}.",
	"tools.list_profiles.properties.offset.description": "Смещение с отсчётом от нуля для mode=window. Не указывайте offset при mode=random."
} as const;
