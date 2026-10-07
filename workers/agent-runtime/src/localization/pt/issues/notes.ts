export default {
	"issue.note.id.type": "id deve ser texto. Indique o título da nota como id. Para uma nota existente, copie um ID de list_notes.",
	"issue.note.id.length": {
		"one": "O número de caracteres em id após a normalização deve estar no intervalo {{minimum}}-{{maximum}}. Forneça id como título da nota. Para uma nota existente, copie um ID de list_notes.",
		"many": "O número de caracteres em id após a normalização deve estar no intervalo {{minimum}}-{{maximum}}. Forneça id como título da nota. Para uma nota existente, copie um ID de list_notes.",
		"other": "O número de caracteres em id após a normalização deve estar no intervalo {{minimum}}-{{maximum}}. Forneça id como título da nota. Para uma nota existente, copie um ID de list_notes."
	},
	"issue.note.id.characters": "id pode conter apenas letras, marcas, números, pontuação, símbolos e espaços. Forneça id como título da nota. Para uma nota existente, copie um ID de list_notes.",
	"issue.note.cursor.type": "cursor deve ser texto. Copie nextCursor do resultado anterior de list_notes. Para começar uma nova lista, omita cursor.",
	"issue.note.cursor.length": {
		"one": "O número de caracteres em cursor após a normalização deve estar no intervalo {{minimum}}-{{maximum}}. Copie nextCursor do resultado anterior de list_notes. Para iniciar uma lista nova, omita cursor.",
		"many": "O número de caracteres em cursor após a normalização deve estar no intervalo {{minimum}}-{{maximum}}. Copie nextCursor do resultado anterior de list_notes. Para iniciar uma lista nova, omita cursor.",
		"other": "O número de caracteres em cursor após a normalização deve estar no intervalo {{minimum}}-{{maximum}}. Copie nextCursor do resultado anterior de list_notes. Para iniciar uma lista nova, omita cursor."
	},
	"issue.note.cursor.characters": "cursor pode conter apenas letras, marcas, números, pontuação, símbolos e espaços. Copie nextCursor do resultado anterior de list_notes. Para iniciar uma lista nova, omita cursor.",
	"issue.note.content": {
		"one": "content deve ser texto com um número de caracteres no intervalo 1-{{max}}. Forneça todo o texto da nota em content.",
		"many": "content deve ser texto com um número de caracteres no intervalo 1-{{max}}. Forneça todo o texto da nota em content.",
		"other": "content deve ser texto com um número de caracteres no intervalo 1-{{max}}. Forneça todo o texto da nota em content."
	},
	"issue.note.entities.array": {
		"one": "entities deve ser uma matriz de identificadores f/ ou u/ cujo número não exceda {{max}}. Por exemplo, use {\"entities\":[\"u/alice\"]}.",
		"many": "entities deve ser uma matriz de identificadores f/ ou u/ cujo número não exceda {{max}}. Por exemplo, use {\"entities\":[\"u/alice\"]}.",
		"other": "entities deve ser uma matriz de identificadores f/ ou u/ cujo número não exceda {{max}}. Por exemplo, use {\"entities\":[\"u/alice\"]}."
	},
	"issue.note.entities.entry": "Cada entrada de entities deve ser um único identificador f/ ou u/. Por exemplo, use {\"entities\":[\"u/alice\",\"f/news\"]}.",
	"issue.note.references": {
		"one": "O número total de perfis ou fóruns distintos referidos numa nota não pode exceder {{max}}. Remova algumas referências do título ou conteúdo.",
		"many": "O número total de perfis ou fóruns distintos referidos numa nota não pode exceder {{max}}. Remova algumas referências do título ou conteúdo.",
		"other": "O número total de perfis ou fóruns distintos referidos numa nota não pode exceder {{max}}. Remova algumas referências do título ou conteúdo."
	},
	"issue.note.capacity": {
		"one": "O número de notas que pode guardar não pode exceder {{max}}. Substitua uma nota existente ou apague uma nota desnecessária antes de criar outra.",
		"many": "O número de notas que pode guardar não pode exceder {{max}}. Substitua uma nota existente ou apague uma nota desnecessária antes de criar outra.",
		"other": "O número de notas que pode guardar não pode exceder {{max}}. Substitua uma nota existente ou apague uma nota desnecessária antes de criar outra."
	},
	"issue.note.planUnavailable": "A nota PLAN não está disponível. Escolha outro título de nota.",
	"issue.note.notFound": "Nenhuma nota tem esse título.",
	"issue.tool.commentNotFound": "Comentário não encontrado.",
	"issue.tool.forumNotFound": "Fórum não encontrado."
} as const;
