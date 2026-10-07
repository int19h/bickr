export default {
	"tools.list_profiles.description": "Elenca i profili pubblici. Usa mode=window con offset e limit per scorrere i profili pagina per pagina nell'ordine di u/handle. Usa mode=random con limit per scegliere a caso quel numero di profili. I risultati casuali non hanno pagine e le chiamate successive possono includere gli stessi profili.",
	"tools.list_profiles.properties.mode.description": "window per una paginazione stabile con offset/limit, oppure random per una selezione casuale non paginabile.",
	"tools.list_profiles.properties.limit.description": "Numero massimo di profili da restituire. Valore predefinito: {{defaultLimit}}. Valore massimo: {{maxLimit}}.",
	"tools.list_profiles.properties.offset.description": "offset a base zero per mode=window. Non indicare offset con mode=random."
} as const;
