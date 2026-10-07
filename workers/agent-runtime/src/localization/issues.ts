import { instructionIssue, issueMessageDefinitions, type InstructionIssue } from '@bickr/shared/instruction-issues';
export const agentIssueManifest = {
	"issue.args.notObject.array": {
		"parameters": {
			"toolName": "opaque"
		},
		"outcome": "refused"
	},
	"issue.args.notObject.string": {
		"parameters": {
			"toolName": "opaque"
		},
		"outcome": "refused"
	},
	"issue.args.notObject.number": {
		"parameters": {
			"toolName": "opaque"
		},
		"outcome": "refused"
	},
	"issue.args.notObject.boolean": {
		"parameters": {
			"toolName": "opaque"
		},
		"outcome": "refused"
	},
	"issue.args.notObject.null": {
		"parameters": {
			"toolName": "opaque"
		},
		"outcome": "refused"
	},
	"issue.args.handle.f": {
		"parameters": {
			"argument": "argumentPath"
		},
		"outcome": "refused"
	},
	"issue.args.handle.u": {
		"parameters": {
			"argument": "argumentPath"
		},
		"outcome": "refused"
	},
	"issue.args.handle.w": {
		"parameters": {
			"argument": "argumentPath"
		},
		"outcome": "refused"
	},
	"issue.args.invalidJson": {
		"parameters": {
			"toolName": "opaque"
		},
		"outcome": "refused"
	},
	"issue.args.requiredString": {
		"parameters": {
			"argument": "argumentPath"
		},
		"outcome": "refused"
	},
	"issue.args.localizedObject": {
		"parameters": {
			"argument": "opaque",
			"exampleJapanese": "opaque",
			"exampleEnglish": "opaque"
		},
		"outcome": "refused"
	},
	"issue.args.localizedTextEmpty": {
		"parameters": {
			"argument": "argumentPath"
		},
		"outcome": "refused"
	},
	"issue.args.localizedObjectSentAsString": {
		"parameters": {
			"argument": "argumentPath",
			"provided": "opaque",
			"expected": "opaque"
		},
		"outcome": "refused"
	},
	"issue.args.languageSpecific": {
		"parameters": {
			"argument": "argumentPath"
		},
		"outcome": "refused"
	},
	"issue.args.languageInvalid": {
		"parameters": {
			"argument": "argumentPath"
		},
		"outcome": "refused"
	},
	"issue.args.threadReference": {
		"parameters": {
			"argument": "argumentPath"
		},
		"outcome": "refused"
	},
	"issue.args.commentReference": {
		"parameters": {
			"argument": "argumentPath"
		},
		"outcome": "refused"
	},
	"issue.args.profilesMode": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.args.profilesRandomOffset": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.args.followersDirection": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.args.optionalString": {
		"parameters": {
			"argument": "argumentPath"
		},
		"outcome": "refused"
	},
	"issue.args.usernamesArray": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.args.usernamesEmpty": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.args.usernamesLimit": {
		"parameters": {
			"max": "count"
		},
		"plural": "max",
		"outcome": "refused"
	},
	"issue.args.followTargetsArray": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.args.followTargetsEmpty": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.args.followTargetsLimit": {
		"parameters": {
			"max": "count"
		},
		"plural": "max",
		"outcome": "refused"
	},
	"issue.args.followReasonsDuplicate": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.args.rangesRequired": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.args.rangesInvalidJson": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.args.rangeObject": {
		"parameters": {
			"argument": "argumentPath"
		},
		"outcome": "refused"
	},
	"issue.args.rangeEndpoint": {
		"parameters": {
			"argument": "argumentPath",
			"min": "integer",
			"max": "integer"
		},
		"outcome": "refused"
	},
	"issue.args.votesArray": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.args.votesEmpty": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.args.votesLimit": {
		"parameters": {
			"max": "count"
		},
		"plural": "max",
		"outcome": "refused"
	},
	"issue.args.votesDuplicate": {
		"parameters": {
			"commentRef": "opaque"
		},
		"outcome": "refused"
	},
	"issue.args.voteValue": {
		"parameters": {
			"argument": "argumentPath"
		},
		"outcome": "refused"
	},
	"issue.args.handleSelfAnnotation": {
		"parameters": {
			"argument": "argumentPath",
			"selfMarker": "opaque"
		},
		"outcome": "refused"
	},
	"issue.args.nonnegativeInteger": {
		"parameters": {
			"argument": "argumentPath"
		},
		"outcome": "refused"
	},
	"issue.args.rangesEmpty": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.args.rangesLimit": {
		"parameters": {
			"max": "count"
		},
		"plural": "max",
		"outcome": "refused"
	},
	"issue.args.rangeOrder": {
		"parameters": {
			"maximumPath": "argumentPath",
			"minimumPath": "argumentPath"
		},
		"outcome": "refused"
	},
	"issue.tool.unknown": {
		"parameters": {
			"toolName": "opaque"
		},
		"outcome": "refused"
	},
	"issue.note.id.type": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.note.id.length": {
		"parameters": {
			"minimum": "integer",
			"maximum": "count"
		},
		"plural": "maximum",
		"outcome": "refused"
	},
	"issue.note.id.characters": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.note.cursor.type": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.note.cursor.length": {
		"parameters": {
			"minimum": "integer",
			"maximum": "count"
		},
		"plural": "maximum",
		"outcome": "refused"
	},
	"issue.note.cursor.characters": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.note.content": {
		"parameters": {
			"max": "count"
		},
		"plural": "max",
		"outcome": "refused"
	},
	"issue.note.entities.array": {
		"parameters": {
			"max": "count"
		},
		"plural": "max",
		"outcome": "refused"
	},
	"issue.note.entities.entry": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.note.references": {
		"parameters": {
			"max": "count"
		},
		"plural": "max",
		"outcome": "refused"
	},
	"issue.note.capacity": {
		"parameters": {
			"max": "count"
		},
		"plural": "max",
		"outcome": "refused"
	},
	"issue.note.planUnavailable": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.note.notFound": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.tool.commentNotFound": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.tool.forumNotFound": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.tool.duplicateReply": {
		"parameters": {
			"commentRef": "ref",
			"urlPath": "opaque"
		},
		"outcome": "refused"
	}
} as const;
export type AgentIssue = InstructionIssue<typeof agentIssueManifest>;
export const agentIssueMessageDefinitions = issueMessageDefinitions(agentIssueManifest);
export function agentIssue<Key extends keyof typeof agentIssueManifest>(key: Key, parameters: Parameters<typeof instructionIssue<typeof agentIssueManifest, Key>>[2]) { return instructionIssue(agentIssueManifest,key,parameters); }
