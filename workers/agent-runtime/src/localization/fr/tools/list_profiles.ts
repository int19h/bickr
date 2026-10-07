export default {
	"tools.list_profiles.description": "Listez les profils publics. Utilisez mode=window avec offset et limit pour parcourir les profils page par page dans l'ordre de u/handle. Utilisez mode=random avec limit pour choisir ce nombre de profils au hasard. Les résultats aléatoires n'ont pas de pages, et des appels ultérieurs peuvent inclure les mêmes profils.",
	"tools.list_profiles.properties.mode.description": "window pour une pagination stable avec offset/limit, ou random pour une sélection aléatoire non paginable.",
	"tools.list_profiles.properties.limit.description": "Nombre maximal de profils à renvoyer. La valeur par défaut est {{defaultLimit}}. Le plafond est {{maxLimit}}.",
	"tools.list_profiles.properties.offset.description": "Décalage à partir de zéro pour mode=window. Ne fournissez pas offset avec mode=random."
} as const;
