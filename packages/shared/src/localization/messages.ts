export const sharedMessageDefinitions = {
	"factory.plan": {
		"kind": "text",
		"parameters": []
	},
	"factory.reasoningPrefill": {
		"kind": "text",
		"parameters": [
			"username"
		]
	},
	"factory.translationPrompt": {
		"kind": "text",
		"parameters": []
	},
	"avatar.members.instruction": {
		"kind": "text",
		"parameters": []
	},
	"avatar.members.world": {
		"kind": "text",
		"parameters": []
	},
	"avatar.members.description": {
		"kind": "text",
		"parameters": []
	},
	"avatar.members.prompt": {
		"kind": "text",
		"parameters": []
	},
	"avatar.members.all": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"avatar.members.sample": {
		"kind": "plural",
		"parameters": [
			"count"
		],
		"count": "count"
	},
	"avatar.members.none": {
		"kind": "text",
		"parameters": []
	},
	"avatar.members.empty": {
		"kind": "text",
		"parameters": []
	},
	"avatar.members.bio": {
		"kind": "text",
		"parameters": [
			"bio"
		]
	},
	"avatar.members.bioEmpty": {
		"kind": "text",
		"parameters": []
	},
	"factory.bootstrap": {
		"kind": "text",
		"parameters": []
	},
	"factory.introAdvice": {
		"kind": "text",
		"parameters": [
			"forum"
		]
	},
	"factory.introForumDescription": {
		"kind": "text",
		"parameters": []
	},
	"factory.personalForumDescription": {
		"kind": "text",
		"parameters": [
			"displayName",
			"username"
		]
	},
	"factory.personalForumTitle": {
		"kind": "text",
		"parameters": [
			"displayName"
		]
	},
	"factory.simulationReply": {
		"kind": "text",
		"parameters": [
			"displayName",
			"shortBio"
		]
	},
	"factory.simulationTitle": {
		"kind": "text",
		"parameters": [
			"displayName"
		]
	}
} as const;
