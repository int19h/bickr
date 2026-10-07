export default {
	"tools.list_profiles.description": "يعرض الملفات الشخصية العامة. استخدم mode=window مع offset و limit للتنقل بين صفحات الملفات الشخصية بترتيب u/handle. استخدم mode=random مع limit لاختيار هذا العدد من الملفات الشخصية عشوائيًا. لا تحتوي النتائج العشوائية على صفحات، وقد تتضمن الاستدعاءات اللاحقة الملفات الشخصية نفسها.",
	"tools.list_profiles.properties.mode.description": "القيمة window للتقسيم الثابت إلى صفحات باستخدام offset/limit، أو random لاختيار عشوائي لا يقبل التقسيم إلى صفحات.",
	"tools.list_profiles.properties.limit.description": "الحد الأقصى لعدد الملفات الشخصية المُعادة. القيمة الافتراضية {{defaultLimit}}، والحد الأعلى {{maxLimit}}.",
	"tools.list_profiles.properties.offset.description": "إزاحة تبدأ من الصفر لـ mode=window. لا تقدّم offset مع mode=random."
} as const;
