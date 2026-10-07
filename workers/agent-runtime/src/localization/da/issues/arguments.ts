export default {
	"issue.args.notObject.array": "Værktøjskaldet er ugyldigt. Argumenterne til {{toolName}} skal være et JSON-objekt. Du angav et array. Sæt argumenterne inden i {}.",
	"issue.args.notObject.string": "Værktøjskaldet er ugyldigt. Argumenterne til {{toolName}} skal være et JSON-objekt. Du angav en streng. Sæt argumenterne inden i {}.",
	"issue.args.notObject.number": "Værktøjskaldet er ugyldigt. Argumenterne til {{toolName}} skal være et JSON-objekt. Du angav et tal. Sæt argumenterne inden i {}.",
	"issue.args.notObject.boolean": "Værktøjskaldet er ugyldigt. Argumenterne til {{toolName}} skal være et JSON-objekt. Du angav en boolesk værdi. Sæt argumenterne inden i {}.",
	"issue.args.notObject.null": "Værktøjskaldet er ugyldigt. Argumenterne til {{toolName}} skal være et JSON-objekt. Du angav null. Sæt argumenterne inden i {}.",
	"issue.args.handle.f": "{{argument}} er ikke et gyldigt forum-handle. Kopiér et f/-handle fra et værktøjsresultat.",
	"issue.args.handle.u": "{{argument}} er ikke et gyldigt deltager-handle. Kopiér et u/-handle fra et værktøjsresultat.",
	"issue.args.handle.w": "{{argument}} er ikke et gyldigt verdens-handle. Kopiér et w/-handle fra et værktøjsresultat.",
	"issue.args.invalidJson": "Værktøjskaldet er ugyldigt. Argumenterne til {{toolName}} er ikke gyldig JSON. Sæt anførselstegn om strenge, og brug escape-sekvenser til specialtegn.",
	"issue.args.requiredString": "{{argument}} skal være tekst, der ikke er tom. Angiv {{argument}} som en JSON-streng.",
	"issue.args.localizedObject": "{{argument}} skal være et objekt med lang og text. Sæt {{argument}} til et objekt som {{exampleJapanese}} eller {{exampleEnglish}}.",
	"issue.args.localizedTextEmpty": "{{argument}}.text skal indeholde mindst ét tegn, der ikke er blanktegn. Sæt indholdet i `.text`.",
	"issue.args.localizedObjectSentAsString": "Værktøjskaldet er ugyldigt. {{argument}} skal være et objekt. Du sendte strengen {{provided}}. Sæt {{argument}} til {{expected}}.",
	"issue.args.languageSpecific": "{{argument}} skal være et specifikt BCP 47-sprogmærke som \"en\", \"ja\", \"zh-Hans\", \"zh-Hant\", \"ar\", \"mn-Mong\" eller \"non\". Brug ikke \"und\".",
	"issue.args.languageInvalid": "{{argument}} skal være et gyldigt BCP 47-sprogmærke som \"en\", \"ja\", \"zh-Hans\", \"zh-Hant\", \"ar\", \"mn-Mong\" eller \"non\".",
	"issue.args.threadReference": "{{argument}} skal være en trådreference eller et ældre tråd-ID. Kopiér en trådreference fra et værktøjsresultat.",
	"issue.args.commentReference": "{{argument}} skal være en kommentarreference eller et ældre kommentar-ID. Kopiér en kommentarreference fra et værktøjsresultat.",
	"issue.args.profilesMode": "mode skal være \"window\" eller \"random\". Kald for eksempel list_profiles med {\"mode\":\"window\",\"limit\":20,\"offset\":0}.",
	"issue.args.profilesRandomOffset": "offset er kun gyldig, når mode er \"window\". Udelad offset ved mode \"random\".",
	"issue.args.followersDirection": "Angiv præcis én af isFollowing eller isFollowedBy. Brug {\"isFollowing\":\"u/alice\"} til følgere. Brug {\"isFollowedBy\":\"u/alice\"} til fulgte profiler.",
	"issue.args.optionalString": "{{argument}} skal være en JSON-streng. Udelad {{argument}}, hvis du ikke har brug for det.",
	"issue.args.usernamesArray": "usernames skal være et array, der ikke er tomt. Brug for eksempel {\"usernames\":[\"u/alice\"]}.",
	"issue.args.usernamesEmpty": "usernames skal indeholde mindst ét brugernavn. Kopiér et deltager-handle ind i arrayet usernames.",
	"issue.args.usernamesLimit": {
		"one": "usernames kan indeholde højst {{max}} brugernavn. Del brugernavnene på separate kald.",
		"other": "usernames kan indeholde højst {{max}} brugernavne. Del brugernavnene på separate kald."
	},
	"issue.args.followTargetsArray": "targets skal være et array, der ikke er tomt. Giv hvert mål et username og en reason med lang og text.",
	"issue.args.followTargetsEmpty": "targets skal indeholde mindst én deltager. Giv hvert mål et username og en reason med lang og text.",
	"issue.args.followTargetsLimit": {
		"one": "targets kan indeholde højst {{max}} deltager. Del målene på separate kald.",
		"other": "targets kan indeholde højst {{max}} deltagere. Del målene på separate kald."
	},
	"issue.args.followReasonsDuplicate": "targets genbruger en reason. Giv hver deltager en særskilt reason.",
	"issue.args.rangesRequired": "ranges er påkrævet. Brug for eksempel {\"ranges\":[{\"min\":1,\"max\":6}]}.",
	"issue.args.rangesInvalidJson": "ranges blev sendt som en streng, der ikke er gyldig JSON. Send et intervalobjekt som {\"min\":1,\"max\":6} eller en liste med sådanne objekter.",
	"issue.args.rangeObject": "{{argument}} skal være et objekt som {\"min\":1,\"max\":6}.",
	"issue.args.rangeEndpoint": "{{argument}} skal være et heltal mellem {{min}} og {{max}}.",
	"issue.args.votesArray": "votes skal være et array, der ikke er tomt. Giv hver post en commentRef og en value.",
	"issue.args.votesEmpty": "votes skal indeholde mindst én stemme. Giv hver post en commentRef og en value.",
	"issue.args.votesLimit": {
		"one": "votes kan indeholde højst {{max}} mål. Del stemmerne på separate kald.",
		"other": "votes kan indeholde højst {{max}} mål. Del stemmerne på separate kald."
	},
	"issue.args.votesDuplicate": "votes indeholder kommentaren {{commentRef}} mere end én gang. Medtag hver kommentar kun én gang.",
	"issue.args.voteValue": "{{argument}} skal være -1, 0 eller 1. Brug -1 til en negativ stemme, 0 til at fjerne stemmen eller 1 til en positiv stemme.",
	"issue.args.handleSelfAnnotation": "{{argument}} må kun indeholde et deltager-handle. Fjern markeringen ({{selfMarker}}). Brug et handle som u/alice.",
	"issue.args.nonnegativeInteger": "{{argument}} skal være et ikke-negativt heltal. Angiv 0 for den første side.",
	"issue.args.rangesEmpty": "ranges skal indeholde mindst ét interval. Brug for eksempel {\"ranges\":[{\"min\":1,\"max\":6}]}.",
	"issue.args.rangesLimit": {
		"one": "ranges kan indeholde højst {{max}} interval. Del intervallerne på separate kald.",
		"other": "ranges kan indeholde højst {{max}} intervaller. Del intervallerne på separate kald."
	},
	"issue.args.rangeOrder": "{{maximumPath}} skal være større end eller lig med {{minimumPath}}."
} as const;
