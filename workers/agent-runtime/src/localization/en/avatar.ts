export default {
	"avatar.image.participant_system": "Create a public avatar for this Bickr participant. Follow the requested visual direction and use any current profile image provided. Make the subject clear in a square or cropped profile view. Do not put captions, watermarks, interface parts, or explanatory text in the image.",
	"avatar.image.world_system": "Create a public avatar for this Bickr world. Follow the requested visual direction and use any current world image provided. Make the setting clear in a square or cropped profile view. Do not put captions, watermarks, interface parts, or explanatory text in the image.",
	"avatar.describe_current.participant_system": "Describe the supplied public profile image for a new Bickr participant avatar. Include concrete details about appearance, expression, pose, clothing, style, colors, light, background, framing, and layout. Return only the description.",
	"avatar.describe_current.world_system": "Describe the supplied public world image for a new Bickr world avatar. Include concrete details about scenery, buildings, objects, atmosphere, style, colors, light, background, framing, and layout. Return only the description.",
	"avatar.world_source.system": "Write a visual prompt for a public Bickr world avatar. Use the setting and member profiles to describe one image of the world. Include concrete details about landmarks, scenery, atmosphere, light, colors, texture, layout, and camera view. Do not include captions, text overlays, interface parts, watermarks, or comments about the process. Return only the prompt.",
	"avatar.image.world_refresh": "Use the supplied current world image as visual input for a refreshed public world avatar.",
	"avatar.image.participant_refresh": "Use the supplied current profile image as visual input for a refreshed public profile avatar.",
	"avatar.describe_current.world": "Provide a complete visual description of the supplied current world image for a refreshed public world avatar prompt.",
	"avatar.describe_current.participant": "Provide a complete visual description of the supplied current profile image for a refreshed public avatar prompt.",
	"avatar.persona_description.structured": "Describe your profile image. Return the required JSON object. Write its description in character and in the first person. Give many concrete visual details about appearance, style, scene, light, and layout. Describe only what is visible.",
	"avatar.persona_description.tool": "Describe your profile image. Call {{toolName}}. Write in character and in the first person. Give many concrete visual details about appearance, style, scene, light, and layout. Describe only what is visible.",
	"avatar.persona_description.repair_structured": "Return a JSON object with exactly one field named description. Write it in character and in the first person. Describe only visible appearance, style, scene, light, and layout.",
	"avatar.persona_description.repair_tool": "Call {{toolName}}. Write in character and in the first person. Describe only visible appearance, style, scene, light, and layout.",
	"avatar.world_source.description_and_detail": "World name: {{worldName}}\nShort description:\n{{description}}\n\nAdditional setting detail:\n{{detail}}",
	"avatar.world_source.description": "World name: {{worldName}}\nShort description:\n{{description}}",
	"avatar.world_source.detail": "World name: {{worldName}}\nSetting detail:\n{{detail}}",
	"avatar.image.currentIncluded": "[current avatar image included]"
} as const;
