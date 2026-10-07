export default {
	"structured_output.unexpected_tools.compaction": "META: Do not call tools. Reply with a detailed first-person summary that follows the required JSON schema.",
	"structured_output.unexpected_tools.other": "Do not use a Bickr control for this response. Reply with the required JSON object containing only {{property}}.",
	"structured_output.empty.compaction": "The summary response was empty. Return a JSON object with nonempty text in {{property}}.",
	"structured_output.empty.translation": "The translation response was empty. Return a JSON object with nonempty text in {{property}}.",
	"structured_output.empty.avatar_description": "The profile image description response was empty. Return a JSON object with nonempty text in {{property}}.",
	"structured_output.invalid_json.compaction": "The summary response must be a JSON object. Give only {{property}} with its text value.",
	"structured_output.invalid_json.translation": "The translation response must be a JSON object. Give only {{property}} with its text value.",
	"structured_output.invalid_json.avatar_description": "The profile image description response must be a JSON object. Give only {{property}} with its text value.",
	"structured_output.missing_tool": "No {{toolName}} tool call was returned. Call {{toolName}} once with nonempty text in {{property}}.",
	"structured_output.wrong_tool": "Use only {{toolName}} for this request. Do not use {{receivedTool}} here.",
	"structured_output.tool_count": {
		"one": "Expected one {{toolName}} tool call, but received {{count}} tool call. Call {{toolName}} exactly once.",
		"other": "Expected one {{toolName}} tool call, but received {{count}} tool calls. Call {{toolName}} exactly once."
	},
	"structured_output.tool_mismatch": "Expected tool {{toolName}}, but received {{receivedTool}}. Call {{toolName}} instead.",
	"structured_output.invalid_arguments_json": "The {{toolName}} arguments were not valid JSON. Give a JSON object with text in {{property}}. Escape special characters in strings.",
	"structured_output.arguments_object": "The {{toolName}} arguments must be a JSON object. Put {{property}} and its text value inside {}.",
	"structured_output.output_object": "The structured output must be a JSON object. Put {{property}} and its text value inside {}.",
	"structured_output.extra_arguments": {
		"one": "There is {{count}} unexpected argument: {{fields}}. Remove that argument. Give only {{property}}.",
		"other": "There are {{count}} unexpected arguments: {{fields}}. Remove those arguments. Give only {{property}}."
	},
	"structured_output.extra_fields": {
		"one": "There is {{count}} unexpected field: {{fields}}. Remove that field. Give only {{property}}.",
		"other": "There are {{count}} unexpected fields: {{fields}}. Remove those fields. Give only {{property}}."
	},
	"structured_output.nonempty.compaction": "The summary argument must be a nonempty string. Put the text in {{property}}.",
	"structured_output.nonempty.translation": "The translation argument must be a nonempty string. Put the text in {{property}}.",
	"structured_output.nonempty.avatar_description": "The profile image description argument must be a nonempty string. Put the text in {{property}}.",
	"structured_output.transcript": "Write the summary in {{property}} as ordinary first-person prose. Remove the transcript line {{line}}. Do not write lines labeled {{labels}}.",
	"structured_output.minimum.compaction": {
		"one": "The summary in {{property}} must be at least {{minimum}} character. Add relevant detail to the text.",
		"other": "The summary in {{property}} must be at least {{minimum}} characters. Add relevant detail to the text."
	},
	"structured_output.minimum.translation": {
		"one": "The translation in {{property}} must be at least {{minimum}} character. Add relevant detail to the text.",
		"other": "The translation in {{property}} must be at least {{minimum}} characters. Add relevant detail to the text."
	},
	"structured_output.minimum.avatar_description": {
		"one": "The profile image description in {{property}} must be at least {{minimum}} character. Add relevant detail to the text.",
		"other": "The profile image description in {{property}} must be at least {{minimum}} characters. Add relevant detail to the text."
	},
	"structured_output.maximum.compaction": {
		"one": "The summary in {{property}} must be at most {{maximum}} character. Shorten the text.",
		"other": "The summary in {{property}} must be at most {{maximum}} characters. Shorten the text."
	},
	"structured_output.maximum.translation": {
		"one": "The translation in {{property}} must be at most {{maximum}} character. Shorten the text.",
		"other": "The translation in {{property}} must be at most {{maximum}} characters. Shorten the text."
	},
	"structured_output.maximum.avatar_description": {
		"one": "The profile image description in {{property}} must be at most {{maximum}} character. Shorten the text.",
		"other": "The profile image description in {{property}} must be at most {{maximum}} characters. Shorten the text."
	},
	"structured_output.wrong_tool.unnamed": "Use only {{toolName}} for this request. Do not send a tool call without a name.",
	"structured_output.tool_mismatch.unnamed": "Expected tool {{toolName}}, but received a tool call without a name. Call {{toolName}} instead.",
	"structured_output.nonreducing.estimate": {
		"one": "The summary in {{property}} did not reduce the context. Its estimated length is {{replacementTokens}} token.",
		"other": "The summary in {{property}} did not reduce the context. Its estimated length is {{replacementTokens}} tokens."
	},
	"structured_output.nonreducing.before": {
		"one": "The context had {{compactedTokens}} token before replacement. Shorten the summary while retaining the required facts.",
		"other": "The context had {{compactedTokens}} tokens before replacement. Shorten the summary while retaining the required facts."
	},
	"structured_output.nonempty.compaction.field": "The summary field must be a nonempty string. Put the text in {{property}}.",
	"structured_output.nonempty.translation.field": "The translation field must be a nonempty string. Put the text in {{property}}.",
	"structured_output.nonempty.avatar_description.field": "The profile image description field must be a nonempty string. Put the text in {{property}}."
} as const;
