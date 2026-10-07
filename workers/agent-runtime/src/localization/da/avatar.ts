export default {
	"avatar.image.participant_system": "Opret en offentlig avatar for denne Bickr-deltager. Følg den ønskede visuelle retning, og brug et eventuelt medfølgende aktuelt profilbillede. Vis motivet tydeligt i en kvadratisk eller beskåret profilvisning. Sæt ikke billedtekster, vandmærker, dele af brugerfladen eller forklarende tekst i billedet.",
	"avatar.image.world_system": "Opret en offentlig avatar for denne Bickr-verden. Følg den ønskede visuelle retning, og brug et eventuelt medfølgende aktuelt billede af verdenen. Vis omgivelserne tydeligt i en kvadratisk eller beskåret profilvisning. Sæt ikke billedtekster, vandmærker, dele af brugerfladen eller forklarende tekst i billedet.",
	"avatar.describe_current.participant_system": "Beskriv det medfølgende offentlige profilbillede til en ny avatar for en Bickr-deltager. Medtag konkrete detaljer om udseende, ansigtsudtryk, positur, tøj, stil, farver, lys, baggrund, billedudsnit og opbygning. Returner kun beskrivelsen.",
	"avatar.describe_current.world_system": "Beskriv det medfølgende offentlige billede af verdenen til en ny avatar for en Bickr-verden. Medtag konkrete detaljer om landskab, bygninger, genstande, stemning, stil, farver, lys, baggrund, billedudsnit og opbygning. Returner kun beskrivelsen.",
	"avatar.world_source.system": "Skriv en visuel prompt til en offentlig avatar for en Bickr-verden. Brug rammen og medlemsprofilerne til at beskrive ét billede af verdenen. Medtag konkrete detaljer om vartegn, landskab, stemning, lys, farver, tekstur, opbygning og kameravinkel. Medtag ikke billedtekster, tekst oven på billedet, dele af brugerfladen, vandmærker eller kommentarer om processen. Returner kun prompten.",
	"avatar.image.world_refresh": "Brug det leverede nuværende billede af verdenen som visuelt input til en fornyet offentlig avatar for verdenen.",
	"avatar.image.participant_refresh": "Brug det leverede nuværende profilbillede som visuelt input til en fornyet offentlig profilavatar.",
	"avatar.describe_current.world": "Giv en fuldstændig visuel beskrivelse af det medfølgende aktuelle billede af verdenen til en prompt for en opdateret offentlig verdensavatar.",
	"avatar.describe_current.participant": "Giv en fuldstændig visuel beskrivelse af det medfølgende aktuelle profilbillede til en prompt for en opdateret offentlig avatar.",
	"avatar.persona_description.structured": "Beskriv dit profilbillede. Returner det påkrævede JSON-objekt. Skriv beskrivelsen i rollen og i første person. Giv mange konkrete visuelle detaljer om udseende, stil, scene, lys og opbygning. Beskriv kun det, der er synligt.",
	"avatar.persona_description.tool": "Beskriv dit profilbillede. Kald {{toolName}}. Skriv i rollen og i første person. Giv mange konkrete visuelle detaljer om udseende, stil, scene, lys og opbygning. Beskriv kun det, der er synligt.",
	"avatar.persona_description.repair_structured": "Returner et JSON-objekt med præcis ét felt ved navn description. Skriv det i rollen og i første person. Beskriv kun det synlige: udseende, stil, scene, lys og opbygning.",
	"avatar.persona_description.repair_tool": "Kald {{toolName}}. Skriv i rollen og i første person. Beskriv kun det synlige: udseende, stil, scene, lys og opbygning.",
	"avatar.world_source.description_and_detail": "Verdensnavn: {{worldName}}\nKort beskrivelse:\n{{description}}\n\nYderligere detaljer om rammen:\n{{detail}}",
	"avatar.world_source.description": "Verdensnavn: {{worldName}}\nKort beskrivelse:\n{{description}}",
	"avatar.world_source.detail": "Verdensnavn: {{worldName}}\nDetaljer om rammen:\n{{detail}}",
	"avatar.image.currentIncluded": "[nuværende avatarbillede vedlagt]"
} as const;
