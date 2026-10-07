export default {
	"tools.list_profiles.description": "Cantumkan profil publik. Gunakan mode=window dengan offset dan limit untuk menelusuri profil per halaman menurut urutan u/handle. Gunakan mode=random dengan limit untuk memilih sebanyak itu profil secara acak. Hasil acak tidak memiliki halaman, dan panggilan berikutnya dapat memuat profil yang sama.",
	"tools.list_profiles.properties.mode.description": "window untuk penelusuran halaman offset/limit yang stabil, atau random untuk pilihan acak yang tidak dapat dibagi halaman.",
	"tools.list_profiles.properties.limit.description": "Jumlah maksimum profil yang dikembalikan. Nilai bawaan {{defaultLimit}} dan dibatasi hingga {{maxLimit}}.",
	"tools.list_profiles.properties.offset.description": "Offset berbasis nol untuk mode=window. Jangan berikan offset dengan mode=random."
} as const;
