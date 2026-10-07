import { sharedMessageDefinitions } from '@bickr/shared/localization';
import { agentIssueMessageDefinitions } from './issues';
import { botServiceIssueMessageDefinitions } from '@bickr/shared/bot-service-issues';
export const messageParameters = { ...sharedMessageDefinitions, ...agentIssueMessageDefinitions, ...botServiceIssueMessageDefinitions, ...({
	"system.nativeLanguage": {
		"kind": "text",
		"parameters": [
			"language"
		]
	},
	"system.identity": {
		"kind": "text",
		"parameters": [
			"username",
			"selfAuthor"
		]
	},
	"system.actionDecisionWithLogOff": {
		"kind": "text",
		"parameters": []
	},
	"system.actionDecision": {
		"kind": "text",
		"parameters": []
	},
	"system.plan": {
		"kind": "text",
		"parameters": []
	},
	"system.notes": {
		"kind": "text",
		"parameters": [
			"plan"
		]
	},
	"system.logOffInstruction": {
		"kind": "text",
		"parameters": []
	},
	"system.setting": {
		"kind": "text",
		"parameters": [
			"setting"
		]
	},
	"system.main": {
		"kind": "text",
		"parameters": [
			"actionDecision",
			"logOffInstruction",
			"notes",
			"identity",
			"nativeLanguage",
			"displayName",
			"shortBio",
			"persona",
			"setting",
			"mathKiB",
			"svgKiB",
			"svgElements",
			"mermaidKiB"
		]
	},
	"examples.create_thread.title.text": {
		"kind": "text",
		"parameters": []
	},
	"examples.create_thread.body.text": {
		"kind": "text",
		"parameters": []
	},
	"examples.reply_to_comment.body.text": {
		"kind": "text",
		"parameters": []
	},
	"examples.make_additional_reply_to_the_same_comment.body.text": {
		"kind": "text",
		"parameters": []
	},
	"examples.vote.reason.text": {
		"kind": "text",
		"parameters": []
	},
	"examples.search_threads.query": {
		"kind": "text",
		"parameters": []
	},
	"examples.search_threads_semantic.query": {
		"kind": "text",
		"parameters": []
	},
	"examples.write_note.content": {
		"kind": "text",
		"parameters": []
	},
	"examples.follow_profile.targets.reason.text": {
		"kind": "text",
		"parameters": []
	},
	"examples.unfollow_profile.targets.reason.text": {
		"kind": "text",
		"parameters": []
	},
	"examples.log_off.reason.text": {
		"kind": "text",
		"parameters": []
	},
	"examples.provide_summary.detailedFirstPersonSummary": {
		"kind": "text",
		"parameters": []
	},
	"examples.save_avatar_description.description": {
		"kind": "text",
		"parameters": []
	},
	"schema.compaction.summary": {
		"kind": "text",
		"parameters": [
			"transcriptLabels"
		]
	},
	"schema.compaction.property": {
		"kind": "text",
		"parameters": []
	},
	"tools.draw_random_integers.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.list_accessible_forums.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.list_recent_threads.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.list_hot_threads.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.read_thread.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.read_thread_by_id.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.read_comment_by_id.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.create_thread.description": {
		"kind": "text",
		"parameters": []
	},
	"schema.authored_text.thread_title": {
		"kind": "text",
		"parameters": []
	},
	"schema.authored_text.root_body": {
		"kind": "text",
		"parameters": []
	},
	"tools.reply_to_comment.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.make_additional_reply_to_the_same_comment.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.vote.description": {
		"kind": "text",
		"parameters": []
	},
	"schema.authored_text.vote_reason": {
		"kind": "text",
		"parameters": []
	},
	"tools.vote.properties.votes.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.search_threads.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.search_threads_semantic.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.search_profiles.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.list_profiles.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.list_profiles.properties.mode.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.list_profiles.properties.limit.description": {
		"kind": "text",
		"parameters": [
			"defaultLimit",
			"maxLimit"
		]
	},
	"tools.list_profiles.properties.offset.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.view_profiles.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.view_profiles.properties.usernames.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.list_notes.description": {
		"kind": "text",
		"parameters": [
			"maxFilters"
		]
	},
	"tools.list_notes.properties.entities.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.list_notes.properties.cursor.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.read_note.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.write_note.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.delete_note.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.query_followers.description": {
		"kind": "text",
		"parameters": [
			"maxLimit"
		]
	},
	"tools.query_followers.properties.isFollowing.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.query_followers.properties.isFollowedBy.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.query_followers.properties.usernameGlob.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.view_activity.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.follow_profile.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.follow_profile.properties.targets.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.follow_profile.properties.targets.items.properties.username.description": {
		"kind": "text",
		"parameters": []
	},
	"schema.authored_text.follow_reason": {
		"kind": "text",
		"parameters": []
	},
	"tools.unfollow_profile.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.unfollow_profile.properties.targets.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.unfollow_profile.properties.targets.items.properties.username.description": {
		"kind": "text",
		"parameters": []
	},
	"schema.authored_text.unfollow_reason": {
		"kind": "text",
		"parameters": []
	},
	"tools.log_off.description": {
		"kind": "text",
		"parameters": []
	},
	"schema.authored_text.log_off_reason": {
		"kind": "text",
		"parameters": []
	},
	"schema.authored_text.reply_body": {
		"kind": "text",
		"parameters": []
	},
	"schema.random_ranges.list": {
		"kind": "text",
		"parameters": []
	},
	"schema.random_ranges.choice": {
		"kind": "plural",
		"parameters": [
			"maxRanges"
		],
		"count": "maxRanges"
	},
	"schema.random_range.description": {
		"kind": "text",
		"parameters": []
	},
	"schema.random_range.min": {
		"kind": "text",
		"parameters": []
	},
	"schema.random_range.max": {
		"kind": "text",
		"parameters": []
	},
	"schema.authored_text.language": {
		"kind": "text",
		"parameters": [
			"languageTagExamples"
		]
	},
	"schema.example_arguments": {
		"kind": "text",
		"parameters": [
			"description",
			"exampleArguments"
		]
	},
	"tools.provide_summary.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.save_translation.description": {
		"kind": "text",
		"parameters": []
	},
	"tools.save_avatar_description.description": {
		"kind": "text",
		"parameters": []
	},
	"schema.authored.threadTitle": {
		"kind": "text",
		"parameters": [
			"languageTagExamples"
		]
	},
	"schema.authored.rootBody": {
		"kind": "text",
		"parameters": [
			"languageTagExamples"
		]
	},
	"schema.authored.voteReason": {
		"kind": "text",
		"parameters": [
			"languageTagExamples"
		]
	},
	"schema.authored.followReason": {
		"kind": "text",
		"parameters": [
			"languageTagExamples"
		]
	},
	"schema.authored.unfollowReason": {
		"kind": "text",
		"parameters": [
			"languageTagExamples"
		]
	},
	"schema.authored.logOffReason": {
		"kind": "text",
		"parameters": [
			"languageTagExamples"
		]
	},
	"schema.authored.replyBody": {
		"kind": "text",
		"parameters": [
			"languageTagExamples"
		]
	},
	"compaction.continuation": {
		"kind": "text",
		"parameters": []
	},
	"compaction.persona.instruction": {
		"kind": "text",
		"parameters": []
	},
	"compaction.persona.display_name": {
		"kind": "text",
		"parameters": [
			"displayName"
		]
	},
	"compaction.persona.short_bio": {
		"kind": "text",
		"parameters": [
			"shortBio"
		]
	},
	"compaction.persona.persona": {
		"kind": "text",
		"parameters": [
			"persona"
		]
	},
	"compaction.system.autonomous": {
		"kind": "text",
		"parameters": []
	},
	"compaction.system.roles": {
		"kind": "text",
		"parameters": []
	},
	"compaction.system.setting": {
		"kind": "text",
		"parameters": [
			"setting"
		]
	},
	"compaction.system.required_tool": {
		"kind": "text",
		"parameters": [
			"toolName"
		]
	},
	"compaction.summary.structured": {
		"kind": "text",
		"parameters": [
			"property",
			"handle",
			"lengthInstruction",
			"transcriptLabels"
		]
	},
	"compaction.summary.tool": {
		"kind": "text",
		"parameters": [
			"toolName",
			"property",
			"handle",
			"lengthInstruction",
			"transcriptLabels"
		]
	},
	"compaction.shorten.structured": {
		"kind": "text",
		"parameters": [
			"property",
			"lengthInstruction"
		]
	},
	"compaction.shorten.tool": {
		"kind": "text",
		"parameters": [
			"toolName",
			"property",
			"lengthInstruction"
		]
	},
	"compaction.repair.structured_response": {
		"kind": "text",
		"parameters": [
			"property"
		]
	},
	"compaction.repair.tool_response": {
		"kind": "text",
		"parameters": [
			"toolName",
			"property"
		]
	},
	"compaction.repair.system": {
		"kind": "text",
		"parameters": [
			"responseInstruction",
			"lengthInstruction"
		]
	},
	"compaction.length.exact": {
		"kind": "plural",
		"parameters": [
			"maxCharacters"
		],
		"count": "maxCharacters"
	},
	"compaction.length.range": {
		"kind": "plural",
		"parameters": [
			"minCharacters",
			"maxCharacters"
		],
		"count": "maxCharacters"
	},
	"compaction.repair.produce_summary": {
		"kind": "text",
		"parameters": []
	},
	"compaction.summary.call_now": {
		"kind": "text",
		"parameters": [
			"toolName",
			"property",
			"lengthInstruction"
		]
	},
	"compaction.self_correction.tool": {
		"kind": "text",
		"parameters": [
			"toolName"
		]
	},
	"compaction.self_correction.structured": {
		"kind": "text",
		"parameters": []
	},
	"compaction.tools.require_one_of": {
		"kind": "text",
		"parameters": [
			"toolNames"
		]
	},
	"compaction.tools.require_any": {
		"kind": "text",
		"parameters": []
	},
	"compaction.tools.meta_only_when_directed": {
		"kind": "text",
		"parameters": [
			"toolName"
		]
	},
	"compaction.tools.self_correction_one_of": {
		"kind": "text",
		"parameters": [
			"toolNames"
		]
	},
	"compaction.tools.self_correction_any": {
		"kind": "text",
		"parameters": []
	},
	"formatting.action": {
		"kind": "text",
		"parameters": []
	},
	"formatting.result": {
		"kind": "text",
		"parameters": []
	},
	"formatting.input": {
		"kind": "text",
		"parameters": []
	},
	"formatting.thought": {
		"kind": "text",
		"parameters": []
	},
	"formatting.orPair": {
		"kind": "text",
		"parameters": [
			"first",
			"last"
		]
	},
	"formatting.orMany": {
		"kind": "text",
		"parameters": [
			"first",
			"last"
		]
	},
	"formatting.sentenceSeparator": {
		"kind": "text",
		"parameters": []
	},
	"formatting.listSeparator": {
		"kind": "text",
		"parameters": []
	},
	"compaction.summary.structured.immediate": {
		"kind": "text",
		"parameters": [
			"property",
			"handle",
			"lengthInstruction",
			"transcriptLabels"
		]
	},
	"compaction.shorten.structured.immediate": {
		"kind": "text",
		"parameters": [
			"property",
			"lengthInstruction"
		]
	},
	"compaction.repair.structured_response.immediate": {
		"kind": "text",
		"parameters": [
			"property"
		]
	},
	"structured_output.unexpected_tools.compaction": {
		"kind": "text",
		"parameters": []
	},
	"structured_output.unexpected_tools.other": {
		"kind": "text",
		"parameters": [
			"property"
		]
	},
	"structured_output.empty.compaction": {
		"kind": "text",
		"parameters": [
			"property"
		]
	},
	"structured_output.empty.translation": {
		"kind": "text",
		"parameters": [
			"property"
		]
	},
	"structured_output.empty.avatar_description": {
		"kind": "text",
		"parameters": [
			"property"
		]
	},
	"structured_output.invalid_json.compaction": {
		"kind": "text",
		"parameters": [
			"property"
		]
	},
	"structured_output.invalid_json.translation": {
		"kind": "text",
		"parameters": [
			"property"
		]
	},
	"structured_output.invalid_json.avatar_description": {
		"kind": "text",
		"parameters": [
			"property"
		]
	},
	"structured_output.missing_tool": {
		"kind": "text",
		"parameters": [
			"toolName",
			"property"
		]
	},
	"structured_output.wrong_tool": {
		"kind": "text",
		"parameters": [
			"toolName",
			"receivedTool"
		]
	},
	"structured_output.tool_count": {
		"kind": "plural",
		"parameters": [
			"toolName",
			"count"
		],
		"count": "count"
	},
	"structured_output.tool_mismatch": {
		"kind": "text",
		"parameters": [
			"toolName",
			"receivedTool"
		]
	},
	"structured_output.invalid_arguments_json": {
		"kind": "text",
		"parameters": [
			"toolName",
			"property"
		]
	},
	"structured_output.arguments_object": {
		"kind": "text",
		"parameters": [
			"toolName",
			"property"
		]
	},
	"structured_output.output_object": {
		"kind": "text",
		"parameters": [
			"property"
		]
	},
	"structured_output.extra_arguments": {
		"kind": "plural",
		"parameters": [
			"fields",
			"property",
			"count"
		],
		"count": "count"
	},
	"structured_output.extra_fields": {
		"kind": "plural",
		"parameters": [
			"fields",
			"property",
			"count"
		],
		"count": "count"
	},
	"structured_output.nonempty.compaction": {
		"kind": "text",
		"parameters": [
			"property"
		]
	},
	"structured_output.nonempty.translation": {
		"kind": "text",
		"parameters": [
			"property"
		]
	},
	"structured_output.nonempty.avatar_description": {
		"kind": "text",
		"parameters": [
			"property"
		]
	},
	"structured_output.transcript": {
		"kind": "text",
		"parameters": [
			"property",
			"line",
			"labels"
		]
	},
	"structured_output.minimum.compaction": {
		"kind": "plural",
		"parameters": [
			"minimum",
			"property"
		],
		"count": "minimum"
	},
	"structured_output.minimum.translation": {
		"kind": "plural",
		"parameters": [
			"minimum",
			"property"
		],
		"count": "minimum"
	},
	"structured_output.minimum.avatar_description": {
		"kind": "plural",
		"parameters": [
			"minimum",
			"property"
		],
		"count": "minimum"
	},
	"structured_output.maximum.compaction": {
		"kind": "plural",
		"parameters": [
			"maximum",
			"property"
		],
		"count": "maximum"
	},
	"structured_output.maximum.translation": {
		"kind": "plural",
		"parameters": [
			"maximum",
			"property"
		],
		"count": "maximum"
	},
	"structured_output.maximum.avatar_description": {
		"kind": "plural",
		"parameters": [
			"maximum",
			"property"
		],
		"count": "maximum"
	},
	"avatar.image.participant_system": {
		"kind": "text",
		"parameters": []
	},
	"avatar.image.world_system": {
		"kind": "text",
		"parameters": []
	},
	"avatar.describe_current.participant_system": {
		"kind": "text",
		"parameters": []
	},
	"avatar.describe_current.world_system": {
		"kind": "text",
		"parameters": []
	},
	"avatar.world_source.system": {
		"kind": "text",
		"parameters": []
	},
	"avatar.image.world_refresh": {
		"kind": "text",
		"parameters": []
	},
	"avatar.image.participant_refresh": {
		"kind": "text",
		"parameters": []
	},
	"avatar.describe_current.world": {
		"kind": "text",
		"parameters": []
	},
	"avatar.describe_current.participant": {
		"kind": "text",
		"parameters": []
	},
	"avatar.persona_description.structured": {
		"kind": "text",
		"parameters": []
	},
	"avatar.persona_description.tool": {
		"kind": "text",
		"parameters": [
			"toolName"
		]
	},
	"avatar.persona_description.repair_structured": {
		"kind": "text",
		"parameters": []
	},
	"avatar.persona_description.repair_tool": {
		"kind": "text",
		"parameters": [
			"toolName"
		]
	},
	"time.just_now": {
		"kind": "text",
		"parameters": []
	},
	"time.year.future": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"time.year.past": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"time.month.future": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"time.month.past": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"time.day.future": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"time.day.past": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"time.hour.future": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"time.hour.past": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"time.minute.future": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"time.minute.past": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"read.context.basic": {
		"kind": "text",
		"parameters": [
			"operation"
		]
	},
	"read.context.collapsed_and_trimmed": {
		"kind": "plural",
		"parameters": [
			"operation",
			"tokenBudget"
		],
		"count": "tokenBudget"
	},
	"read.context.collapsed": {
		"kind": "plural",
		"parameters": [
			"operation",
			"tokenBudget"
		],
		"count": "tokenBudget"
	},
	"read.context.trimmed": {
		"kind": "plural",
		"parameters": [
			"operation",
			"tokenBudget"
		],
		"count": "tokenBudget"
	},
	"read.guidance.collapsed": {
		"kind": "text",
		"parameters": []
	},
	"read.guidance.trimmed": {
		"kind": "text",
		"parameters": [
			"ellipsis"
		]
	},
	"read.guidance.both": {
		"kind": "text",
		"parameters": [
			"ellipsis"
		]
	},
	"notifications.check.complete": {
		"kind": "text",
		"parameters": []
	},
	"notifications.check.omitted": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"structured_output.wrong_tool.unnamed": {
		"kind": "text",
		"parameters": [
			"toolName"
		]
	},
	"structured_output.tool_mismatch.unnamed": {
		"kind": "text",
		"parameters": [
			"toolName"
		]
	},
	"structured_output.nonreducing.estimate": {
		"kind": "plural",
		"parameters": [
			"replacementTokens",
			"property"
		],
		"count": "replacementTokens"
	},
	"structured_output.nonreducing.before": {
		"kind": "plural",
		"parameters": [
			"compactedTokens"
		],
		"count": "compactedTokens"
	},
	"structured_output.nonempty.compaction.field": {
		"kind": "text",
		"parameters": [
			"property"
		]
	},
	"structured_output.nonempty.translation.field": {
		"kind": "text",
		"parameters": [
			"property"
		]
	},
	"structured_output.nonempty.avatar_description.field": {
		"kind": "text",
		"parameters": [
			"property"
		]
	},
	"avatar.world_source.description_and_detail": {
		"kind": "text",
		"parameters": [
			"worldName",
			"description",
			"detail"
		]
	},
	"avatar.world_source.description": {
		"kind": "text",
		"parameters": [
			"worldName",
			"description"
		]
	},
	"avatar.world_source.detail": {
		"kind": "text",
		"parameters": [
			"worldName",
			"detail"
		]
	},
	"synthetic.login.plan": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.login.notifications": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.spotlight.discovery": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.log_off.premature": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.log_off.disallowed": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.notes.disabled": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.log_off.limit": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.log_off.reason": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.spotlight.focus_one": {
		"kind": "text",
		"parameters": [
			"focus"
		]
	},
	"synthetic.spotlight.focus_many": {
		"kind": "text",
		"parameters": [
			"focusList"
		]
	},
	"synthetic.spotlight.attention": {
		"kind": "text",
		"parameters": [
			"thought"
		]
	},
	"synthetic.malformed.named": {
		"kind": "text",
		"parameters": [
			"toolName"
		]
	},
	"synthetic.malformed.unnamed": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.malformed.example": {
		"kind": "text",
		"parameters": [
			"toolName",
			"example"
		]
	},
	"synthetic.reminder.previous": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.reminder.recent": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"synthetic.malformed.many": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"synthetic.malformed.many_named": {
		"kind": "plural",
		"parameters": [
			"count",
			"toolNames"
		],
		"count": "count"
	},
	"synthetic.malformed.omitted": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"report.elapsed.moment": {
		"kind": "text",
		"parameters": []
	},
	"report.elapsed.second": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"report.elapsed.minute": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"report.elapsed.hour": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"report.elapsed.day": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"synthetic.reasoning.read_note": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.reasoning.check_notifications": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.reasoning.view_profiles": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.reasoning.read_thread_by_id": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.reasoning.read_comment_by_id": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.reasoning.log_off": {
		"kind": "text",
		"parameters": []
	},
	"formatting.andPair": {
		"kind": "text",
		"parameters": [
			"first",
			"last"
		]
	},
	"formatting.andMany": {
		"kind": "text",
		"parameters": [
			"first",
			"last"
		]
	},
	"recovery.follow.already_following": {
		"kind": "plural",
		"parameters": [
			"count",
			"names"
		],
		"count": "count"
	},
	"recovery.follow.not_following": {
		"kind": "plural",
		"parameters": [
			"count",
			"names"
		],
		"count": "count"
	},
	"recovery.follow.self": {
		"kind": "plural",
		"parameters": [
			"count",
			"names"
		],
		"count": "count"
	},
	"recovery.follow.missing": {
		"kind": "plural",
		"parameters": [
			"count",
			"names"
		],
		"count": "count"
	},
	"recovery.follow.empty": {
		"kind": "text",
		"parameters": []
	},
	"recovery.follow.follow_profile": {
		"kind": "text",
		"parameters": [
			"reasons"
		]
	},
	"recovery.follow.unfollow_profile": {
		"kind": "text",
		"parameters": [
			"reasons"
		]
	},
	"tool.log_off.finished": {
		"kind": "text",
		"parameters": []
	},
	"read.focus.description": {
		"kind": "text",
		"parameters": []
	},
	"recovery.read_only.named": {
		"kind": "text",
		"parameters": [
			"forum"
		]
	},
	"recovery.read_only.unnamed": {
		"kind": "text",
		"parameters": []
	},
	"recovery.duplicate_title.named": {
		"kind": "text",
		"parameters": [
			"threadRef",
			"forum"
		]
	},
	"recovery.duplicate_title.unnamed": {
		"kind": "text",
		"parameters": [
			"threadRef"
		]
	},
	"recovery.location": {
		"kind": "text",
		"parameters": [
			"path"
		]
	},
	"recovery.already_replied.comment": {
		"kind": "text",
		"parameters": [
			"ref"
		]
	},
	"recovery.already_replied.thread": {
		"kind": "text",
		"parameters": [
			"ref"
		]
	},
	"recovery.already_replied.there": {
		"kind": "text",
		"parameters": []
	},
	"recovery.already_replied.reply": {
		"kind": "text",
		"parameters": [
			"ref"
		]
	},
	"recovery.already_replied.next": {
		"kind": "text",
		"parameters": []
	},
	"recovery.duplicate_comment.base": {
		"kind": "text",
		"parameters": []
	},
	"recovery.duplicate_comment.comment": {
		"kind": "text",
		"parameters": [
			"ref"
		]
	},
	"recovery.duplicate_comment.thread": {
		"kind": "text",
		"parameters": [
			"ref"
		]
	},
	"recovery.duplicate_comment.next": {
		"kind": "text",
		"parameters": []
	},
	"recovery.guidance.duplicateReply": {
		"kind": "text",
		"parameters": [
			"commentRef"
		]
	},
	"recovery.guidance.noteMissing": {
		"kind": "text",
		"parameters": []
	},
	"recovery.guidance.forumMissing": {
		"kind": "text",
		"parameters": []
	},
	"recovery.guidance.threadMissing": {
		"kind": "text",
		"parameters": []
	},
	"recovery.guidance.commentMissing": {
		"kind": "text",
		"parameters": []
	},
	"recovery.guidance.profileMissing": {
		"kind": "text",
		"parameters": []
	},
	"recovery.guidance.targetMissing": {
		"kind": "text",
		"parameters": []
	},
	"recovery.guidance.accessDenied": {
		"kind": "text",
		"parameters": []
	},
	"recovery.guidance.serviceFailure": {
		"kind": "text",
		"parameters": []
	},
	"recovery.unknown.thread": {
		"kind": "text",
		"parameters": []
	},
	"recovery.unknown.comment": {
		"kind": "text",
		"parameters": []
	},
	"recovery.unknown.profile": {
		"kind": "text",
		"parameters": []
	},
	"recovery.unknown.note": {
		"kind": "text",
		"parameters": []
	},
	"recovery.unknown.page": {
		"kind": "text",
		"parameters": []
	},
	"recovery.preparationFailure": {
		"kind": "text",
		"parameters": []
	},
	"recovery.notDispatched": {
		"kind": "text",
		"parameters": []
	},
	"recovery.interrupted": {
		"kind": "text",
		"parameters": []
	},
	"recovery.genericError": {
		"kind": "text",
		"parameters": []
	},
	"recovery.failureReport": {
		"kind": "text",
		"parameters": [
			"toolName",
			"arguments",
			"message"
		]
	},
	"recovery.hintReport": {
		"kind": "text",
		"parameters": [
			"hint"
		]
	},
	"recovery.correction.already_replied": {
		"kind": "text",
		"parameters": []
	},
	"recovery.correction.duplicate_comment": {
		"kind": "text",
		"parameters": []
	},
	"recovery.correction.conflict": {
		"kind": "text",
		"parameters": []
	},
	"recovery.correction.not_found": {
		"kind": "text",
		"parameters": []
	},
	"recovery.correction.bad_request": {
		"kind": "text",
		"parameters": []
	},
	"recovery.correction.invalid_arguments_json": {
		"kind": "text",
		"parameters": []
	},
	"recovery.correction.arguments_not_json_object": {
		"kind": "text",
		"parameters": []
	},
	"recovery.correction.server_error": {
		"kind": "text",
		"parameters": []
	},
	"recovery.correction.access": {
		"kind": "text",
		"parameters": []
	},
	"recovery.correction.timeout": {
		"kind": "text",
		"parameters": []
	},
	"recovery.correction.unknown": {
		"kind": "text",
		"parameters": []
	},
	"compaction.history.app": {
		"kind": "text",
		"parameters": [
			"content"
		]
	},
	"compaction.history.action": {
		"kind": "text",
		"parameters": [
			"toolName",
			"arguments"
		]
	},
	"compaction.history.thought": {
		"kind": "text",
		"parameters": [
			"content"
		]
	},
	"compaction.history.written": {
		"kind": "text",
		"parameters": [
			"content"
		]
	},
	"compaction.history.toolResult": {
		"kind": "text",
		"parameters": [
			"callId",
			"content"
		]
	},
	"compaction.history.toolResultUnnamed": {
		"kind": "text",
		"parameters": [
			"content"
		]
	},
	"compaction.history.other": {
		"kind": "text",
		"parameters": [
			"role",
			"content"
		]
	},
	"compaction.legacy.preface": {
		"kind": "text",
		"parameters": [
			"history"
		]
	},
	"compaction.legacy.memory": {
		"kind": "text",
		"parameters": [
			"memory"
		]
	},
	"compaction.legacy.input": {
		"kind": "text",
		"parameters": [
			"input"
		]
	},
	"compaction.legacy.result": {
		"kind": "text",
		"parameters": [
			"toolName",
			"result"
		]
	},
	"compaction.legacy.thought": {
		"kind": "text",
		"parameters": [
			"thought"
		]
	},
	"recovery.metaCompactionUnavailable": {
		"kind": "text",
		"parameters": [
			"toolName"
		]
	},
	"simulation.reply": {
		"kind": "text",
		"parameters": [
			"title"
		]
	},
	"simulation.noForum": {
		"kind": "text",
		"parameters": []
	},
	"simulation.createThread": {
		"kind": "text",
		"parameters": [
			"forum"
		]
	},
	"recovery.replyEarlierUnknown": {
		"kind": "text",
		"parameters": []
	},
	"avatar.image.currentIncluded": {
		"kind": "text",
		"parameters": []
	},
	"translation.request": {
		"kind": "text",
		"parameters": [
			"toolName",
			"sourceText"
		]
	},
	"recovery.replyEarlierCommitted": {
		"kind": "text",
		"parameters": []
	},
	"recovery.batch.notAttempted": {
		"kind": "text",
		"parameters": []
	},
	"recovery.batch.guidance": {
		"kind": "text",
		"parameters": []
	},
	"recovery.batch.failed": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.log_off.unavailable": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.log_off.unavailableReason": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.log_off.unknown": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.log_off.unknownReason": {
		"kind": "text",
		"parameters": []
	},
	"recovery.unknown.siblingNotAttempted": {
		"kind": "text",
		"parameters": []
	},
	"recovery.threadEarlierUnknown": {
		"kind": "text",
		"parameters": []
	},
	"recovery.threadEarlierCommitted": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.reasoning.log_off.unavailable": {
		"kind": "text",
		"parameters": []
	},
	"synthetic.reasoning.log_off.unknown": {
		"kind": "text",
		"parameters": []
	}
} as const) } as const;
