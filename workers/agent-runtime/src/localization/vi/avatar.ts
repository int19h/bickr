export default {
	"avatar.image.participant_system": "Tạo ảnh đại diện công khai cho người tham gia Bickr này. Làm theo định hướng hình ảnh được yêu cầu và dùng ảnh hồ sơ hiện tại được cung cấp, nếu có. Làm rõ chủ thể trong khung hồ sơ vuông hoặc được cắt. Không đặt chú thích, hình mờ, phần giao diện hoặc văn bản giải thích vào ảnh.",
	"avatar.image.world_system": "Tạo ảnh đại diện công khai cho thế giới Bickr này. Làm theo định hướng hình ảnh được yêu cầu và dùng ảnh thế giới hiện tại được cung cấp, nếu có. Làm rõ bối cảnh trong khung hồ sơ vuông hoặc được cắt. Không đặt chú thích, hình mờ, phần giao diện hoặc văn bản giải thích vào ảnh.",
	"avatar.describe_current.participant_system": "Mô tả ảnh hồ sơ công khai được cung cấp cho ảnh đại diện mới của người tham gia Bickr. Nêu chi tiết cụ thể về ngoại hình, biểu cảm, tư thế, trang phục, phong cách, màu sắc, ánh sáng, hậu cảnh, khung hình và bố cục. Chỉ trả về phần mô tả.",
	"avatar.describe_current.world_system": "Mô tả ảnh thế giới công khai được cung cấp cho ảnh đại diện mới của thế giới Bickr. Nêu chi tiết cụ thể về phong cảnh, tòa nhà, đồ vật, không khí, phong cách, màu sắc, ánh sáng, nền, khung hình và bố cục. Chỉ trả về mô tả.",
	"avatar.world_source.system": "Viết một chỉ dẫn hình ảnh cho ảnh đại diện công khai của một thế giới Bickr. Dùng bối cảnh và hồ sơ thành viên để mô tả một hình ảnh của thế giới. Nêu chi tiết cụ thể về địa danh, phong cảnh, bầu không khí, ánh sáng, màu sắc, chất liệu bề mặt, bố cục và góc máy. Không thêm chú thích, chữ chồng lên ảnh, thành phần giao diện, hình mờ hay nhận xét về quá trình. Chỉ trả về chỉ dẫn.",
	"avatar.image.world_refresh": "Dùng ảnh thế giới hiện tại được cung cấp làm đầu vào hình ảnh cho một ảnh đại diện công khai được làm mới cho thế giới.",
	"avatar.image.participant_refresh": "Dùng ảnh hồ sơ hiện tại được cung cấp làm đầu vào hình ảnh cho ảnh đại diện hồ sơ công khai được làm mới.",
	"avatar.describe_current.world": "Cung cấp mô tả hình ảnh đầy đủ của ảnh thế giới hiện tại được cung cấp để dùng trong chỉ dẫn cho ảnh đại diện công khai được làm mới cho thế giới.",
	"avatar.describe_current.participant": "Cung cấp mô tả hình ảnh đầy đủ của ảnh hồ sơ hiện tại được cung cấp cho chỉ dẫn ảnh đại diện công khai được làm mới.",
	"avatar.persona_description.structured": "Mô tả ảnh hồ sơ của bạn. Trả về đối tượng JSON bắt buộc. Viết phần mô tả trong vai nhân vật và ở ngôi thứ nhất. Đưa ra nhiều chi tiết hình ảnh cụ thể về ngoại hình, phong cách, cảnh, ánh sáng và bố cục. Chỉ mô tả những gì nhìn thấy được.",
	"avatar.persona_description.tool": "Mô tả ảnh hồ sơ của bạn. Gọi {{toolName}}. Viết trong vai nhân vật và ở ngôi thứ nhất. Đưa ra nhiều chi tiết hình ảnh cụ thể về ngoại hình, phong cách, cảnh, ánh sáng và bố cục. Chỉ mô tả những gì nhìn thấy được.",
	"avatar.persona_description.repair_structured": "Trả về một đối tượng JSON có đúng một trường tên là description. Viết nó trong vai nhân vật và ở ngôi thứ nhất. Chỉ mô tả ngoại hình, phong cách, cảnh, ánh sáng và bố cục nhìn thấy được.",
	"avatar.persona_description.repair_tool": "Gọi {{toolName}}. Viết trong vai nhân vật và ở ngôi thứ nhất. Chỉ mô tả ngoại hình, phong cách, cảnh, ánh sáng và bố cục nhìn thấy được.",
	"avatar.world_source.description_and_detail": "Tên thế giới: {{worldName}}\nMô tả ngắn:\n{{description}}\n\nChi tiết bối cảnh bổ sung:\n{{detail}}",
	"avatar.world_source.description": "Tên thế giới: {{worldName}}\nMô tả ngắn:\n{{description}}",
	"avatar.world_source.detail": "Tên thế giới: {{worldName}}\nChi tiết bối cảnh:\n{{detail}}",
	"avatar.image.currentIncluded": "[đã đính kèm ảnh đại diện hiện tại]"
} as const;
