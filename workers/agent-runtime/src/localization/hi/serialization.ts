export default {
	"time.just_now": "अभी-अभी",
	"time.year.future": {
		"one": "{{count}} साल बाद",
		"other": "{{count}} साल बाद"
	},
	"time.year.past": {
		"one": "{{count}} साल पहले",
		"other": "{{count}} साल पहले"
	},
	"time.month.future": {
		"one": "{{count}} महीने बाद",
		"other": "{{count}} महीने बाद"
	},
	"time.month.past": {
		"one": "{{count}} महीने पहले",
		"other": "{{count}} महीने पहले"
	},
	"time.day.future": {
		"one": "{{count}} दिन बाद",
		"other": "{{count}} दिन बाद"
	},
	"time.day.past": {
		"one": "{{count}} दिन पहले",
		"other": "{{count}} दिन पहले"
	},
	"time.hour.future": {
		"one": "{{count}} घंटे बाद",
		"other": "{{count}} घंटे बाद"
	},
	"time.hour.past": {
		"one": "{{count}} घंटे पहले",
		"other": "{{count}} घंटे पहले"
	},
	"time.minute.future": {
		"one": "{{count}} मिनट बाद",
		"other": "{{count}} मिनट बाद"
	},
	"time.minute.past": {
		"one": "{{count}} मिनट पहले",
		"other": "{{count}} मिनट पहले"
	},
	"read.context.basic": "मेरे {{operation}} ऑपरेशन का परिणाम।",
	"read.context.collapsed_and_trimmed": {
		"one": "मेरे {{operation}} ऑपरेशन का परिणाम। परिणाम को लगभग {{tokenBudget}} टोकन के भीतर रखने के लिए कुछ जवाब-सूचियाँ समेटी गईं और कुछ टिप्पणियों के मुख्य भाग छोटे किए गए।",
		"other": "मेरे {{operation}} ऑपरेशन का परिणाम। परिणाम को लगभग {{tokenBudget}} टोकन के भीतर रखने के लिए कुछ जवाब-सूचियाँ समेटी गईं और कुछ टिप्पणियों के मुख्य भाग छोटे किए गए।"
	},
	"read.context.collapsed": {
		"one": "मेरे {{operation}} ऑपरेशन का परिणाम। परिणाम को लगभग {{tokenBudget}} टोकन के भीतर रखने के लिए कुछ जवाब-सूचियाँ समेटी गईं।",
		"other": "मेरे {{operation}} ऑपरेशन का परिणाम। परिणाम को लगभग {{tokenBudget}} टोकन के भीतर रखने के लिए कुछ जवाब-सूचियाँ समेटी गईं।"
	},
	"read.context.trimmed": {
		"one": "मेरे {{operation}} ऑपरेशन का परिणाम। परिणाम को लगभग {{tokenBudget}} टोकन के भीतर रखने के लिए कुछ टिप्पणियों के मुख्य भाग छोटे किए गए।",
		"other": "मेरे {{operation}} ऑपरेशन का परिणाम। परिणाम को लगभग {{tokenBudget}} टोकन के भीतर रखने के लिए कुछ टिप्पणियों के मुख्य भाग छोटे किए गए।"
	},
	"read.guidance.collapsed": "`replies` का संख्यात्मक मान बताता है कि उतने सीधे उत्तर छोड़ दिए गए हैं; उस शाखा को देखने के लिए उस टिप्पणी के ref के साथ read_comment_by_id कॉल करें।",
	"read.guidance.trimmed": "{{ellipsis}} पर समाप्त होने वाला मुख्य पाठ छोटा किया गया है; पूरी टिप्पणी पढ़ने के लिए उस टिप्पणी के ref के साथ read_comment_by_id कॉल करें।",
	"read.guidance.both": "`replies` का संख्यात्मक मान बताता है कि उतने सीधे उत्तर छोड़ दिए गए हैं; उस शाखा को देखने के लिए उस टिप्पणी के ref के साथ read_comment_by_id कॉल करें। {{ellipsis}} पर समाप्त होने वाला मुख्य पाठ छोटा किया गया है; पूरी टिप्पणी पढ़ने के लिए उस टिप्पणी के ref के साथ read_comment_by_id कॉल करें।",
	"notifications.check.complete": "सूचनाएँ जाँचने का परिणाम।",
	"notifications.check.omitted": {
		"one": "सूचनाएँ जाँचने का परिणाम। कम प्राथमिकता वाली या पुरानी छोड़ी गई सूचनाओं की संख्या {{count}} है। छोड़ी गई हर सूचना लंबित रहती है।",
		"other": "सूचनाएँ जाँचने का परिणाम। कम प्राथमिकता वाली या पुरानी छोड़ी गई सूचनाओं की संख्या {{count}} है। छोड़ी गई हर सूचना लंबित रहती है।"
	},
	"read.focus.description": "मेरा ध्यान इस टिप्पणी पर है।"
} as const;
