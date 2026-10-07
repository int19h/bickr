export default {
	"time.just_now": "gerade eben",
	"time.year.future": {
		"one": "in {{count}} Jahr",
		"other": "in {{count}} Jahren"
	},
	"time.year.past": {
		"one": "vor {{count}} Jahr",
		"other": "vor {{count}} Jahren"
	},
	"time.month.future": {
		"one": "in {{count}} Monat",
		"other": "in {{count}} Monaten"
	},
	"time.month.past": {
		"one": "vor {{count}} Monat",
		"other": "vor {{count}} Monaten"
	},
	"time.day.future": {
		"one": "in {{count}} Tag",
		"other": "in {{count}} Tagen"
	},
	"time.day.past": {
		"one": "vor {{count}} Tag",
		"other": "vor {{count}} Tagen"
	},
	"time.hour.future": {
		"one": "in {{count}} Stunde",
		"other": "in {{count}} Stunden"
	},
	"time.hour.past": {
		"one": "vor {{count}} Stunde",
		"other": "vor {{count}} Stunden"
	},
	"time.minute.future": {
		"one": "in {{count}} Minute",
		"other": "in {{count}} Minuten"
	},
	"time.minute.past": {
		"one": "vor {{count}} Minute",
		"other": "vor {{count}} Minuten"
	},
	"read.context.basic": "Ergebnis meiner Aktion {{operation}}.",
	"read.context.collapsed_and_trimmed": {
		"one": "Ergebnis meiner Aktion {{operation}}. Einige Antwortlisten wurden eingeklappt und einige Kommentartexte gekürzt, um das Ergebnis auf ungefähr {{tokenBudget}} Token zu begrenzen.",
		"other": "Ergebnis meiner Aktion {{operation}}. Einige Antwortlisten wurden eingeklappt und einige Kommentartexte gekürzt, um das Ergebnis auf ungefähr {{tokenBudget}} Token zu begrenzen."
	},
	"read.context.collapsed": {
		"one": "Ergebnis meiner Aktion {{operation}}. Einige Antwortlisten wurden eingeklappt, um das Ergebnis auf ungefähr {{tokenBudget}} Token zu begrenzen.",
		"other": "Ergebnis meiner Aktion {{operation}}. Einige Antwortlisten wurden eingeklappt, um das Ergebnis auf ungefähr {{tokenBudget}} Token zu begrenzen."
	},
	"read.context.trimmed": {
		"one": "Ergebnis meiner Aktion {{operation}}. Einige Kommentartexte wurden gekürzt, um das Ergebnis auf ungefähr {{tokenBudget}} Token zu begrenzen.",
		"other": "Ergebnis meiner Aktion {{operation}}. Einige Kommentartexte wurden gekürzt, um das Ergebnis auf ungefähr {{tokenBudget}} Token zu begrenzen."
	},
	"read.guidance.collapsed": "Ein numerischer Wert von `replies` bedeutet, dass so viele direkte Antworten ausgelassen wurden. Rufen Sie read_comment_by_id mit der Referenz dieses Kommentars auf, um diesen Zweig anzusehen.",
	"read.guidance.trimmed": "Ein Text, der mit {{ellipsis}} endet, wurde gekürzt. Rufen Sie read_comment_by_id mit der Referenz dieses Kommentars auf, um den vollständigen Kommentar zu lesen.",
	"read.guidance.both": "Ein numerischer Wert von `replies` bedeutet, dass so viele direkte Antworten ausgelassen wurden. Rufen Sie read_comment_by_id mit der Referenz dieses Kommentars auf, um diesen Zweig anzusehen. Ein Text, der mit {{ellipsis}} endet, wurde gekürzt. Rufen Sie read_comment_by_id mit der Referenz dieses Kommentars auf, um den vollständigen Kommentar zu lesen.",
	"notifications.check.complete": "Ergebnis der Prüfung der Benachrichtigungen.",
	"notifications.check.omitted": {
		"one": "Ergebnis der Prüfung der Benachrichtigungen. {{count}} Benachrichtigung mit niedrigerer Priorität oder älterem Datum wurde ausgelassen. Sie bleibt ausstehend.",
		"other": "Ergebnis der Prüfung der Benachrichtigungen. {{count}} Benachrichtigungen mit niedrigerer Priorität oder älterem Datum wurden ausgelassen. Sie bleiben ausstehend."
	},
	"read.focus.description": "Mein Fokus liegt auf diesem Kommentar."
} as const;
