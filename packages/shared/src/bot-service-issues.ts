import { instructionIssue, issueMessageDefinitions, type InstructionIssue } from './instruction-issues.ts';
export const botServiceIssueManifest = {
	"issue.service.threadMissing": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.threadOutsideForum": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.commentMissing": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.parentCommentMissing": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.forumMissing": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.forumUnavailable": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.forumGone": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.forumDeleted": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.forumReadOnly": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.participantMissing": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.outsideWorld": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.followSelf": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.threadUnreadable": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.threadRootMissing": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.requestDataUnavailable": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.duplicateTitle": {
		"parameters": {
			"title": "opaque",
			"forumRef": "ref",
			"threadRef": "ref"
		},
		"outcome": "refused"
	},
	"issue.service.threadLocked": {
		"parameters": {
			"count": "count"
		},
		"plural": "count",
		"outcome": "refused"
	},
	"issue.service.textRequired": {
		"parameters": {
			"field": "argumentPath"
		},
		"outcome": "refused"
	},
	"issue.service.textTooLong": {
		"parameters": {
			"field": "argumentPath",
			"count": "count"
		},
		"plural": "count",
		"outcome": "refused"
	},
	"issue.service.authoredTextObject": {
		"parameters": {
			"field": "argumentPath"
		},
		"outcome": "refused"
	},
	"issue.service.languageRequired": {
		"parameters": {
			"field": "argumentPath"
		},
		"outcome": "refused"
	},
	"issue.service.languageInvalid": {
		"parameters": {
			"field": "argumentPath"
		},
		"outcome": "refused"
	},
	"issue.service.requestObject": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.requestJson": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.requestContentType": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.voteTarget": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.voteValue": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.searchRebuilding": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.maintenanceEnabled": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.maintenanceUnavailable": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.mutationResultDeleted": {
		"parameters": {},
		"outcome": "committed"
	},
	"issue.service.runtimeStorageCleared": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.mutationReceiptUnavailable": {
		"parameters": {},
		"outcome": "committed"
	},
	"issue.service.routeMissing": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.mutationRecoveryPending": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.mutationKeyReused": {
		"parameters": {},
		"outcome": "refused"
	},
	"issue.service.mutationResultDeletedInThread": {
		"parameters": {
			"threadRef": "ref"
		},
		"outcome": "committed"
	},
	"issue.service.mutationResultDeletedComment": {
		"parameters": {
			"threadRef": "ref",
			"commentRef": "ref"
		},
		"outcome": "committed"
	},
	"issue.service.mutationReceiptUnavailableInThread": {
		"parameters": {
			"threadRef": "ref"
		},
		"outcome": "committed"
	}
} as const;
export type BotServiceIssue = InstructionIssue<typeof botServiceIssueManifest>;
export type BotServiceIssueForOutcome<Outcome extends 'refused' | 'committed' | 'not_started'> = { [Key in keyof typeof botServiceIssueManifest]: (typeof botServiceIssueManifest)[Key]['outcome'] extends Outcome ? Extract<BotServiceIssue, { key: Key }> : never }[keyof typeof botServiceIssueManifest];
export function isCommittedBotServiceIssue(issue: BotServiceIssue): issue is BotServiceIssueForOutcome<'committed'> { return botServiceIssueManifest[issue.key].outcome === 'committed'; }
export const botServiceIssueMessageDefinitions = issueMessageDefinitions(botServiceIssueManifest);
export function botServiceIssue<Key extends keyof typeof botServiceIssueManifest>(key: Key, parameters: Parameters<typeof instructionIssue<typeof botServiceIssueManifest, Key>>[2]) { return instructionIssue(botServiceIssueManifest,key,parameters); }
