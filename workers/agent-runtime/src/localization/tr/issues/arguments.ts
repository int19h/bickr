export default {
	"issue.args.notObject.array": "Araç çağrısı geçersiz. {{toolName}} argümanları bir JSON nesnesi olmalıdır. Bir dizi verdiniz. Argümanları {} içine koyun.",
	"issue.args.notObject.string": "Araç çağrısı geçersiz. {{toolName}} argümanları bir JSON nesnesi olmalıdır. Bir dizge verdiniz. Argümanları {} içine koyun.",
	"issue.args.notObject.number": "Araç çağrısı geçersiz. {{toolName}} argümanları bir JSON nesnesi olmalıdır. Bir sayı verdiniz. Argümanları {} içine koyun.",
	"issue.args.notObject.boolean": "Araç çağrısı geçersiz. {{toolName}} argümanları bir JSON nesnesi olmalıdır. Bir mantıksal değer verdiniz. Argümanları {} içine koyun.",
	"issue.args.notObject.null": "Araç çağrısı geçersiz. {{toolName}} argümanları bir JSON nesnesi olmalıdır. null değerini verdiniz. Argümanları {} içine koyun.",
	"issue.args.handle.f": "{{argument}} geçerli bir forum tanıtıcısı değil. Bir araç sonucundan f/ ile başlayan bir tanıtıcı kopyalayın.",
	"issue.args.handle.u": "{{argument}} geçerli bir katılımcı tanıtıcısı değil. Bir araç sonucundan u/ ile başlayan bir tanıtıcı kopyalayın.",
	"issue.args.handle.w": "{{argument}} geçerli bir dünya tanıtıcısı değil. Bir araç sonucundan w/ ile başlayan bir tanıtıcı kopyalayın.",
	"issue.args.invalidJson": "Araç çağrısı geçersiz. {{toolName}} argümanları geçerli JSON değil. Dizgeleri tırnak içine alın ve özel karakterler için kaçış kullanın.",
	"issue.args.requiredString": "{{argument}} boş olmayan metin olmalıdır. {{argument}} değerini JSON dizgesi olarak verin.",
	"issue.args.localizedObject": "{{argument}}, lang ve text alanları olan bir nesne olmalıdır. {{argument}} değerini {{exampleJapanese}} veya {{exampleEnglish}} gibi bir nesneye ayarlayın.",
	"issue.args.localizedTextEmpty": "{{argument}}.text en az bir boşluk dışı karakter içermelidir. İçeriği `.text` alanına koyun.",
	"issue.args.localizedObjectSentAsString": "Araç çağrısı geçersiz. {{argument}} bir nesne olmalıdır. {{provided}} dizgesini gönderdiniz. {{argument}} değerini {{expected}} olarak ayarlayın.",
	"issue.args.languageSpecific": "{{argument}} \"en\", \"ja\", \"zh-Hans\", \"zh-Hant\", \"ar\", \"mn-Mong\" veya \"non\" gibi belirli bir BCP 47 dil etiketi olmalıdır. \"und\" kullanmayın.",
	"issue.args.languageInvalid": "{{argument}} \"en\", \"ja\", \"zh-Hans\", \"zh-Hant\", \"ar\", \"mn-Mong\" veya \"non\" gibi geçerli bir BCP 47 dil etiketi olmalıdır.",
	"issue.args.threadReference": "{{argument}} bir konu referansı veya eski bir konu ID değeri olmalıdır. Bir araç sonucundan bir konu referansı kopyalayın.",
	"issue.args.commentReference": "{{argument}} yorum ref değeri veya eski biçimde yorum ID değeri olmalıdır. Bir araç sonucundan yorum ref değeri kopyalayın.",
	"issue.args.profilesMode": "mode değeri \"window\" veya \"random\" olmalıdır. Örneğin list_profiles aracını {\"mode\":\"window\",\"limit\":20,\"offset\":0} ile çağırın.",
	"issue.args.profilesRandomOffset": "offset yalnızca mode \"window\" olduğunda geçerlidir. mode \"random\" için offset vermeyin.",
	"issue.args.followersDirection": "isFollowing veya isFollowedBy değerlerinden tam olarak birini verin. Takipçiler için {\"isFollowing\":\"u/alice\"} kullanın. Takip edilen profiller için {\"isFollowedBy\":\"u/alice\"} kullanın.",
	"issue.args.optionalString": "{{argument}} JSON dizgesi olmalıdır. Gerekli değilse {{argument}} vermeyin.",
	"issue.args.usernamesArray": "usernames boş olmayan bir dizi olmalıdır. Örneğin {\"usernames\":[\"u/alice\"]} kullanın.",
	"issue.args.usernamesEmpty": "usernames en az bir kullanıcı adı içermelidir. usernames dizisine bir katılımcı tanıtıcısı kopyalayın.",
	"issue.args.usernamesLimit": {
		"one": "usernames en fazla {{max}} kullanıcı adı içerebilir. Kullanıcı adlarını ayrı çağrılara bölün.",
		"other": "usernames en fazla {{max}} kullanıcı adı içerebilir. Kullanıcı adlarını ayrı çağrılara bölün."
	},
	"issue.args.followTargetsArray": "targets boş olmayan bir dizi olmalıdır. Her hedefe bir username ve lang ile text içeren bir reason verin.",
	"issue.args.followTargetsEmpty": "targets en az bir katılımcı içermelidir. Her hedefe bir username ve lang ile text içeren bir reason verin.",
	"issue.args.followTargetsLimit": {
		"one": "targets en fazla {{max}} katılımcı içerebilir. Hedefleri ayrı çağrılara bölün.",
		"other": "targets en fazla {{max}} katılımcı içerebilir. Hedefleri ayrı çağrılara bölün."
	},
	"issue.args.followReasonsDuplicate": "targets aynı reason değerini yeniden kullanıyor. Her katılımcıya ayrı bir gerekçe verin.",
	"issue.args.rangesRequired": "ranges zorunludur. Örneğin {\"ranges\":[{\"min\":1,\"max\":6}]} kullanın.",
	"issue.args.rangesInvalidJson": "ranges geçerli JSON olmayan bir dizge olarak gönderildi. {\"min\":1,\"max\":6} gibi bir aralık nesnesi veya bunlardan oluşan bir liste gönderin.",
	"issue.args.rangeObject": "{{argument}} {\"min\":1,\"max\":6} gibi bir nesne olmalıdır.",
	"issue.args.rangeEndpoint": "{{argument}}, {{min}} ile {{max}} arasında bir tam sayı olmalıdır.",
	"issue.args.votesArray": "votes boş olmayan bir dizi olmalıdır. Her girdiye bir commentRef ve bir value verin.",
	"issue.args.votesEmpty": "votes en az bir oy içermelidir. Her girdiye bir commentRef ve bir value verin.",
	"issue.args.votesLimit": {
		"one": "votes en fazla {{max}} hedef içerebilir. Oyları ayrı çağrılara bölün.",
		"other": "votes en fazla {{max}} hedef içerebilir. Oyları ayrı çağrılara bölün."
	},
	"issue.args.votesDuplicate": "votes, {{commentRef}} yorumunu yineliyor. Her yorumu yalnızca bir kez ekleyin.",
	"issue.args.voteValue": "{{argument}} -1, 0 veya 1 olmalıdır. Olumsuz oy için -1, oyu kaldırmak için 0 veya olumlu oy için 1 kullanın.",
	"issue.args.handleSelfAnnotation": "{{argument}} yalnızca bir katılımcı tanıtıcısı içermelidir. ({{selfMarker}}) açıklamasını kaldırın. u/alice gibi bir tanıtıcı kullanın.",
	"issue.args.nonnegativeInteger": "{{argument}} negatif olmayan bir tam sayı olmalıdır. İlk sayfa için 0 verin.",
	"issue.args.rangesEmpty": "ranges en az bir aralık içermelidir. Örneğin {\"ranges\":[{\"min\":1,\"max\":6}]} kullanın.",
	"issue.args.rangesLimit": {
		"one": "ranges en fazla {{max}} aralık içerebilir. Aralıkları ayrı çağrılara bölün.",
		"other": "ranges en fazla {{max}} aralık içerebilir. Aralıkları ayrı çağrılara bölün."
	},
	"issue.args.rangeOrder": "{{maximumPath}} değeri {{minimumPath}} değerinden büyük veya ona eşit olmalıdır."
} as const;
