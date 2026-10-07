export default {
	"time.just_now": "방금",
	"time.year.future": {
		"other": "{{count}}년 후"
	},
	"time.year.past": {
		"other": "{{count}}년 전"
	},
	"time.month.future": {
		"other": "{{count}}개월 후"
	},
	"time.month.past": {
		"other": "{{count}}개월 전"
	},
	"time.day.future": {
		"other": "{{count}}일 후"
	},
	"time.day.past": {
		"other": "{{count}}일 전"
	},
	"time.hour.future": {
		"other": "{{count}}시간 후"
	},
	"time.hour.past": {
		"other": "{{count}}시간 전"
	},
	"time.minute.future": {
		"other": "{{count}}분 후"
	},
	"time.minute.past": {
		"other": "{{count}}분 전"
	},
	"read.context.basic": "내 {{operation}} 작업의 결과입니다.",
	"read.context.collapsed_and_trimmed": {
		"other": "내 {{operation}} 작업의 결과입니다. 결과를 약 {{tokenBudget}} 토큰 이내로 유지하기 위해 일부 답글 목록이 접히고 일부 댓글 본문이 짧아졌습니다."
	},
	"read.context.collapsed": {
		"other": "내 {{operation}} 작업의 결과입니다. 결과를 약 {{tokenBudget}} 토큰 이내로 유지하기 위해 일부 답글 목록이 접혔습니다."
	},
	"read.context.trimmed": {
		"other": "내 {{operation}} 작업의 결과입니다. 결과를 약 {{tokenBudget}} 토큰 이내로 유지하기 위해 일부 댓글 본문이 짧아졌습니다."
	},
	"read.guidance.collapsed": "`replies` 값이 숫자이면 그 수만큼의 직접 답글이 생략되었다는 뜻입니다. 해당 댓글에서 이어지는 답글을 확인하려면 해당 댓글의 참조를 지정해 read_comment_by_id를 호출하세요.",
	"read.guidance.trimmed": "{{ellipsis}} 기호로 끝나는 본문은 줄어든 것입니다. 댓글 전체를 읽으려면 해당 댓글의 참조를 지정해 read_comment_by_id를 호출하세요.",
	"read.guidance.both": "`replies` 값이 숫자이면 그 수만큼의 직접 답글이 생략되었다는 뜻입니다. 해당 댓글에서 이어지는 답글을 확인하려면 해당 댓글의 참조를 지정해 read_comment_by_id를 호출하세요. {{ellipsis}} 기호로 끝나는 본문은 줄어든 것입니다. 댓글 전체를 읽으려면 해당 댓글의 참조를 지정해 read_comment_by_id를 호출하세요.",
	"notifications.check.complete": "알림을 확인한 결과입니다.",
	"notifications.check.omitted": {
		"other": "알림 확인 결과입니다. 우선순위가 낮거나 오래된 알림 {{count}} 개가 생략되었습니다. 해당 알림은 계속 대기 상태입니다."
	},
	"read.focus.description": "나는 이 댓글에 집중하고 있다."
} as const;
