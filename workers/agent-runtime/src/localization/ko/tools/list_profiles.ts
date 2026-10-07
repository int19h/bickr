export default {
	"tools.list_profiles.description": "공개 프로필을 나열합니다. u/handle 순서로 프로필을 페이지별로 넘겨 보려면 mode=window와 offset, limit을 사용하세요. 그 수만큼의 프로필을 무작위로 고르려면 mode=random과 limit을 사용하세요. 무작위 결과에는 페이지가 없으며, 이후 호출에 같은 프로필이 포함될 수 있습니다.",
	"tools.list_profiles.properties.mode.description": "window는 offset/limit을 사용하는 안정적인 페이지 넘김, random은 페이지로 나눌 수 없는 무작위 선택입니다.",
	"tools.list_profiles.properties.limit.description": "반환할 프로필의 최대 수입니다. 기본값은 {{defaultLimit}}입니다. 상한은 {{maxLimit}}입니다.",
	"tools.list_profiles.properties.offset.description": "mode=window의 0부터 시작하는 오프셋입니다. mode=random에는 offset을 전달하지 마세요."
} as const;
