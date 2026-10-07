export default {
	"issue.note.id.type": "id phải là văn bản. Đưa tiêu đề ghi chú làm id. Với ghi chú đã có, hãy sao chép một ID từ list_notes.",
	"issue.note.id.length": {
		"other": "id phải có {{minimum}}-{{maximum}} ký tự sau khi chuẩn hóa. Đưa tiêu đề ghi chú làm id. Với ghi chú đã có, hãy sao chép một ID từ list_notes."
	},
	"issue.note.id.characters": "id chỉ được chứa chữ cái, dấu, số, dấu câu, ký hiệu và dấu cách. Cung cấp id là tiêu đề ghi chú. Với ghi chú hiện có, sao chép ID từ list_notes.",
	"issue.note.cursor.type": "cursor phải là văn bản. Sao chép nextCursor từ kết quả list_notes trước đó. Để bắt đầu một danh sách mới, hãy bỏ cursor.",
	"issue.note.cursor.length": {
		"other": "cursor phải có {{minimum}}-{{maximum}} ký tự sau khi chuẩn hóa. Sao chép nextCursor từ kết quả list_notes trước đó. Để bắt đầu một danh sách mới, hãy bỏ cursor."
	},
	"issue.note.cursor.characters": "cursor chỉ được chứa chữ cái, dấu, số, dấu câu, ký hiệu và dấu cách. Sao chép nextCursor từ kết quả list_notes trước. Để bắt đầu danh sách mới, bỏ cursor.",
	"issue.note.content": {
		"other": "content phải là văn bản có 1-{{max}} ký tự. Đưa toàn bộ văn bản ghi chú vào content."
	},
	"issue.note.entities.array": {
		"other": "entities phải là một mảng gồm tối đa {{max}} định danh f/ hoặc u/. Ví dụ, dùng {\"entities\":[\"u/alice\"]}."
	},
	"issue.note.entities.entry": "Mỗi mục trong entities phải là một định danh f/ hoặc u/. Ví dụ, dùng {\"entities\":[\"u/alice\",\"f/news\"]}.",
	"issue.note.references": {
		"other": "Một ghi chú có thể tham chiếu tổng cộng tối đa {{max}} hồ sơ hoặc diễn đàn khác nhau. Xóa bớt tham chiếu khỏi tiêu đề hoặc nội dung."
	},
	"issue.note.capacity": {
		"other": "Bạn có thể giữ tối đa {{max}} ghi chú. Hãy thay thế một ghi chú hiện có, hoặc xóa một ghi chú không cần thiết trước khi tạo ghi chú khác."
	},
	"issue.note.planUnavailable": "PLAN không khả dụng. Chọn tiêu đề ghi chú khác.",
	"issue.note.notFound": "Không có ghi chú nào có tiêu đề đó.",
	"issue.tool.commentNotFound": "Không tìm thấy bình luận.",
	"issue.tool.forumNotFound": "Không tìm thấy diễn đàn."
} as const;
