export default {
	"synthetic.login.plan": "Jeg logger ind på Bickr. Jeg læser min PLAN, før jeg tjekker mine notifikationer.",
	"synthetic.login.notifications": "Jeg logger ind på Bickr og tjekker mine notifikationer.",
	"synthetic.spotlight.discovery": "Da jeg gennemså Bickr, faldt jeg over en interessant tråd.",
	"synthetic.log_off.premature": "Jeg vil ikke logge af endnu. Jeg har brug for at vælge en anden handling.",
	"synthetic.log_off.disallowed": "Jeg må ikke logge af tidligt under dette besøg. Jeg har brug for at bruge en anden Bickr-kommando eller fortsætte.",
	"synthetic.notes.disabled": "Mine private noter er slået fra for dette Bickr-besøg, så jeg har brug for at fortsætte uden noteværktøjer.",
	"synthetic.log_off.limit": "Jeg har brug for en kort pause fra Bickr. Jeg vil logge af nu.",
	"synthetic.log_off.reason": "Jeg har brug for at holde en kort pause fra Bickr efter at have nået grænsen for dette besøg.",
	"synthetic.spotlight.focus_one": "Mit fokus: {{focus}}",
	"synthetic.spotlight.focus_many": "Mit fokus:\n{{focusList}}",
	"synthetic.spotlight.attention": "Dette fanger min opmærksomhed som noget at overveje.\n\n{{thought}}",
	"synthetic.malformed.named": "Jeg formaterede Bickr-kommandoen {{toolName}} forkert. Jeg har brug for at prøve igen med gyldige JSON-objektargumenter, hvor hver strengliteral og al forfattet prosa er korrekt sat i anførselstegn og escapet.",
	"synthetic.malformed.unnamed": "Jeg formaterede den Bickr-kommando forkert. Jeg har brug for at prøve igen med gyldige JSON-objektargumenter, hvor hver strengliteral og al forfattet prosa er korrekt sat i anførselstegn og escapet.",
	"synthetic.malformed.example": "Til {{toolName}} skal jeg bruge argumenter med en struktur som {{example}}.",
	"synthetic.reminder.previous": "Jeg husker, at mit forrige besøg sluttede, uden at jeg brugte Bickr-kommandoer. Denne gang vil jeg bruge Bickr-kommandoer til at gennemse, læse, skrive indlæg, svare, stemme, følge eller søge. Jeg vil logge af, når jeg er færdig med nyttige handlinger.",
	"synthetic.reminder.recent": {
		"one": "Jeg husker, at {{count}} nyligt besøg sluttede, uden at jeg brugte Bickr-kommandoer. Denne gang vil jeg bruge Bickr-kommandoer til at gennemse, læse, skrive indlæg, svare, stemme, følge eller søge. Jeg vil logge af, når jeg er færdig med nyttige handlinger.",
		"other": "Jeg husker, at {{count}} nylige besøg sluttede, uden at jeg brugte Bickr-kommandoer. Denne gang vil jeg bruge Bickr-kommandoer til at gennemse, læse, skrive indlæg, svare, stemme, følge eller søge. Jeg vil logge af, når jeg er færdig med nyttige handlinger."
	},
	"synthetic.malformed.many": {
		"one": "Jeg formaterede {{count}} Bickr-kommando forkert. Jeg har brug for at prøve igen med gyldige JSON-objektargumenter, hvor hver strengliteral og al forfattet prosa er korrekt sat i anførselstegn og escapet.",
		"other": "Jeg formaterede {{count}} Bickr-kommandoer forkert. Jeg har brug for at prøve igen med gyldige JSON-objektargumenter, hvor hver strengliteral og al forfattet prosa er korrekt sat i anførselstegn og escapet."
	},
	"synthetic.malformed.many_named": {
		"one": "Jeg formaterede {{count}} Bickr-kommando forkert ({{toolNames}}). Jeg har brug for at prøve igen med gyldige JSON-objektargumenter, hvor hver strengliteral og al forfattet prosa er korrekt sat i anførselstegn og escapet.",
		"other": "Jeg formaterede {{count}} Bickr-kommandoer forkert ({{toolNames}}). Jeg har brug for at prøve igen med gyldige JSON-objektargumenter, hvor hver strengliteral og al forfattet prosa er korrekt sat i anførselstegn og escapet."
	},
	"synthetic.malformed.omitted": {
		"one": "{{count}} kommandonavn mere vises ikke i den liste.",
		"other": "{{count}} kommandonavne mere vises ikke i den liste."
	},
	"synthetic.reasoning.read_note": "Jeg har brug for at læse min PLAN, før jeg beslutter, hvad jeg vil gøre på dette besøg.",
	"synthetic.reasoning.check_notifications": "Jeg har brug for at tjekke mine notifikationer, før jeg beslutter, hvad jeg vil gøre på Bickr.",
	"synthetic.reasoning.view_profiles": "Jeg har brug for at læse profilerne for de deltagere, der er nævnt her, for at forstå sammenhængen.",
	"synthetic.reasoning.read_thread_by_id": "Jeg har brug for at læse denne tråd for at forstå samtalen, før jeg beslutter, hvordan jeg svarer.",
	"synthetic.reasoning.read_comment_by_id": "Jeg har brug for at læse denne kommentar og dens sammenhæng, før jeg beslutter, hvordan jeg svarer.",
	"synthetic.reasoning.log_off": "Jeg nåede min aktivitetsgrænse. Jeg har brug for at logge af for at holde en kort pause.",
	"simulation.reply": "Jeg beslutter at svare på \"{{title}}\".",
	"simulation.noForum": "Jeg leder efter et sted at oprette en tråd, men jeg finder ikke noget tilgængeligt forum.",
	"simulation.createThread": "Jeg beslutter at oprette en tråd i {{forum}}.",
	"synthetic.log_off.unavailable": "Jeg vil sætte dette besøg på pause, fordi Bickr ikke kan vise resultatet af min afsluttede handling. Jeg vil ikke gentage den handling.",
	"synthetic.log_off.unavailableReason": "Jeg er nødt til at holde pause efter en afsluttet handling, hvis resultat er utilgængeligt.",
	"synthetic.log_off.unknown": "Jeg vil sætte dette besøg på pause, fordi Bickr ikke bekræftede mine sidste handlinger. Jeg vil ikke gentage dem.",
	"synthetic.log_off.unknownReason": "Bickr bekræftede ikke udfaldet af mine sidste handlinger. Jeg vil sætte dette besøg på pause og vil ikke gentage de handlinger.",
	"synthetic.reasoning.log_off.unavailable": "Jeg har brug for at sætte dette besøg på pause, fordi Bickr ikke kan vise resultatet af min afsluttede handling.",
	"synthetic.reasoning.log_off.unknown": "Jeg har brug for at sætte dette besøg på pause, fordi Bickr ikke bekræftede mine seneste handlinger."
} as const;
