export default {
	"structured_output.unexpected_tools.compaction": "META: Non chiamare strumenti. Rispondi con un riassunto dettagliato in prima persona conforme allo schema JSON richiesto.",
	"structured_output.unexpected_tools.other": "Non usare un comando di Bickr per questa risposta. Rispondi con l'oggetto JSON richiesto che contiene solo {{property}}.",
	"structured_output.empty.compaction": "La risposta con il riassunto era vuota. Restituisci un oggetto JSON con testo non vuoto in {{property}}.",
	"structured_output.empty.translation": "La risposta con la traduzione era vuota. Restituisci un oggetto JSON con testo non vuoto in {{property}}.",
	"structured_output.empty.avatar_description": "La risposta con la descrizione dell'immagine del profilo era vuota. Restituisci un oggetto JSON con testo non vuoto in {{property}}.",
	"structured_output.invalid_json.compaction": "La risposta con il riassunto deve essere un oggetto JSON. Fornisci solo {{property}} con il suo valore testuale.",
	"structured_output.invalid_json.translation": "La risposta con la traduzione deve essere un oggetto JSON. Fornisci solo {{property}} con il suo valore testuale.",
	"structured_output.invalid_json.avatar_description": "La risposta con la descrizione dell'immagine del profilo deve essere un oggetto JSON. Fornisci solo {{property}} con il suo valore testuale.",
	"structured_output.missing_tool": "Non è stata restituita una chiamata allo strumento {{toolName}}. Chiama {{toolName}} una volta con testo non vuoto in {{property}}.",
	"structured_output.wrong_tool": "Usa solo {{toolName}} per questa richiesta. Non usare {{receivedTool}} qui.",
	"structured_output.tool_count": {
		"one": "Era prevista una chiamata allo strumento {{toolName}}, ma il numero di chiamate ricevute è {{count}}. Chiama {{toolName}} esattamente una volta.",
		"many": "Era prevista una chiamata allo strumento {{toolName}}, ma il numero di chiamate ricevute è {{count}}. Chiama {{toolName}} esattamente una volta.",
		"other": "Era prevista una chiamata allo strumento {{toolName}}, ma il numero di chiamate ricevute è {{count}}. Chiama {{toolName}} esattamente una volta."
	},
	"structured_output.tool_mismatch": "Era previsto lo strumento {{toolName}}, ma è stato ricevuto {{receivedTool}}. Chiama invece {{toolName}}.",
	"structured_output.invalid_arguments_json": "Gli argomenti di {{toolName}} non erano JSON valido. Fornisci un oggetto JSON con testo in {{property}}. Esegui l'escape dei caratteri speciali nelle stringhe.",
	"structured_output.arguments_object": "Gli argomenti di {{toolName}} devono essere un oggetto JSON. Metti {{property}} e il suo valore testuale dentro {}.",
	"structured_output.output_object": "L'output strutturato deve essere un oggetto JSON. Metti {{property}} e il suo valore testuale dentro {}.",
	"structured_output.extra_arguments": {
		"one": "C'è {{count}} argomento imprevisto: {{fields}}. Rimuovi quell'argomento. Fornisci solo {{property}}.",
		"many": "Ci sono {{count}} argomenti imprevisti: {{fields}}. Rimuovi quegli argomenti. Fornisci solo {{property}}.",
		"other": "Ci sono {{count}} argomenti imprevisti: {{fields}}. Rimuovi quegli argomenti. Fornisci solo {{property}}."
	},
	"structured_output.extra_fields": {
		"one": "C'è {{count}} campo imprevisto: {{fields}}. Rimuovi quel campo. Fornisci solo {{property}}.",
		"many": "Ci sono {{count}} campi imprevisti: {{fields}}. Rimuovi quei campi. Fornisci solo {{property}}.",
		"other": "Ci sono {{count}} campi imprevisti: {{fields}}. Rimuovi quei campi. Fornisci solo {{property}}."
	},
	"structured_output.nonempty.compaction": "L'argomento del riassunto deve essere una stringa non vuota. Metti il testo in {{property}}.",
	"structured_output.nonempty.translation": "L'argomento della traduzione deve essere una stringa non vuota. Metti il testo in {{property}}.",
	"structured_output.nonempty.avatar_description": "L'argomento della descrizione dell'immagine del profilo deve essere una stringa non vuota. Metti il testo in {{property}}.",
	"structured_output.transcript": "Scrivi il riassunto in {{property}} come normale prosa in prima persona. Rimuovi la riga di trascrizione {{line}}. Non scrivere righe con le etichette {{labels}}.",
	"structured_output.minimum.compaction": {
		"one": "Il riassunto in {{property}} deve contenere almeno {{minimum}} carattere. Aggiungi al testo dettagli pertinenti.",
		"many": "Il riassunto in {{property}} deve contenere almeno {{minimum}} caratteri. Aggiungi al testo dettagli pertinenti.",
		"other": "Il riassunto in {{property}} deve contenere almeno {{minimum}} caratteri. Aggiungi al testo dettagli pertinenti."
	},
	"structured_output.minimum.translation": {
		"one": "La traduzione in {{property}} deve contenere almeno {{minimum}} carattere. Aggiungi al testo dettagli pertinenti.",
		"many": "La traduzione in {{property}} deve contenere almeno {{minimum}} caratteri. Aggiungi al testo dettagli pertinenti.",
		"other": "La traduzione in {{property}} deve contenere almeno {{minimum}} caratteri. Aggiungi al testo dettagli pertinenti."
	},
	"structured_output.minimum.avatar_description": {
		"one": "La descrizione dell'immagine del profilo in {{property}} deve contenere almeno {{minimum}} carattere. Aggiungi al testo dettagli pertinenti.",
		"many": "La descrizione dell'immagine del profilo in {{property}} deve contenere almeno {{minimum}} caratteri. Aggiungi al testo dettagli pertinenti.",
		"other": "La descrizione dell'immagine del profilo in {{property}} deve contenere almeno {{minimum}} caratteri. Aggiungi al testo dettagli pertinenti."
	},
	"structured_output.maximum.compaction": {
		"one": "Il riassunto in {{property}} deve contenere al massimo {{maximum}} carattere. Accorcia il testo.",
		"many": "Il riassunto in {{property}} deve contenere al massimo {{maximum}} caratteri. Accorcia il testo.",
		"other": "Il riassunto in {{property}} deve contenere al massimo {{maximum}} caratteri. Accorcia il testo."
	},
	"structured_output.maximum.translation": {
		"one": "La traduzione in {{property}} deve contenere al massimo {{maximum}} carattere. Accorcia il testo.",
		"many": "La traduzione in {{property}} deve contenere al massimo {{maximum}} caratteri. Accorcia il testo.",
		"other": "La traduzione in {{property}} deve contenere al massimo {{maximum}} caratteri. Accorcia il testo."
	},
	"structured_output.maximum.avatar_description": {
		"one": "La descrizione dell'immagine del profilo in {{property}} deve contenere al massimo {{maximum}} carattere. Accorcia il testo.",
		"many": "La descrizione dell'immagine del profilo in {{property}} deve contenere al massimo {{maximum}} caratteri. Accorcia il testo.",
		"other": "La descrizione dell'immagine del profilo in {{property}} deve contenere al massimo {{maximum}} caratteri. Accorcia il testo."
	},
	"structured_output.wrong_tool.unnamed": "Usa solo {{toolName}} per questa richiesta. Non inviare una chiamata di strumento senza nome.",
	"structured_output.tool_mismatch.unnamed": "Era previsto lo strumento {{toolName}}, ma è arrivata una chiamata di strumento senza nome. Chiama invece {{toolName}}.",
	"structured_output.nonreducing.estimate": {
		"one": "Il riassunto in {{property}} non ha ridotto il contesto. La sua lunghezza stimata in token è {{replacementTokens}}.",
		"many": "Il riassunto in {{property}} non ha ridotto il contesto. La sua lunghezza stimata in token è {{replacementTokens}}.",
		"other": "Il riassunto in {{property}} non ha ridotto il contesto. La sua lunghezza stimata in token è {{replacementTokens}}."
	},
	"structured_output.nonreducing.before": {
		"one": "Il numero di token del contesto prima della sostituzione era {{compactedTokens}}. Accorcia il riassunto mantenendo i fatti richiesti.",
		"many": "Il numero di token del contesto prima della sostituzione era {{compactedTokens}}. Accorcia il riassunto mantenendo i fatti richiesti.",
		"other": "Il numero di token del contesto prima della sostituzione era {{compactedTokens}}. Accorcia il riassunto mantenendo i fatti richiesti."
	},
	"structured_output.nonempty.compaction.field": "Il campo del riassunto deve essere una stringa non vuota. Metti il testo in {{property}}.",
	"structured_output.nonempty.translation.field": "Il campo della traduzione deve essere una stringa non vuota. Metti il testo in {{property}}.",
	"structured_output.nonempty.avatar_description.field": "Il campo della descrizione dell'immagine del profilo deve essere una stringa non vuota. Metti il testo in {{property}}."
} as const;
