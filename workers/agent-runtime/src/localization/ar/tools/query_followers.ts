export default {
	"tools.query_followers.description": "يعرض متابعي مشارك أو الملفات الشخصية التي يتابعها. أعطِ واحدًا فقط من isFollowing أو isFollowedBy. تعطي النتيجة u/usernames والعدد الإجمالي. تسرد أسماء مستخدمين لا يزيد عددها عن {{maxLimit}} بترتيب أعداد متابعيهم أنفسهم.",
	"tools.query_followers.properties.isFollowing.description": "اسم u/username الذي أريد سرد متابعيه.",
	"tools.query_followers.properties.isFollowedBy.description": "اسم u/username الذي أريد عرض الملفات الشخصية التي يتابعها.",
	"tools.query_followers.properties.usernameGlob.description": "نمط glob اختياري مع أحرف البدل * يصفّي أسماء المستخدمين الأخرى المُعادة، مثل a* أو u/al*."
} as const;
