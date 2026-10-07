export default {
	"avatar.image.participant_system": "为这个 Bickr 参与者创建一个公开头像。遵循要求的视觉方向，如果提供了当前的个人资料图片，就加以使用。让主体在方形或裁剪后的头像视图中清晰可辨。不要在图像中放入说明文字、水印、界面元素或解释性文字。",
	"avatar.image.world_system": "为这个 Bickr 世界创建一个公开头像。遵循要求的视觉方向，如果提供了当前的世界图片，就加以使用。让场景在方形或裁剪后的头像视图中清晰可辨。不要在图像中放入说明文字、水印、界面元素或解释性文字。",
	"avatar.describe_current.participant_system": "描述提供的公开个人资料图片，用于新的 Bickr 参与者头像。包含外貌、表情、姿势、服装、风格、颜色、光线、背景、取景和布局的具体细节。只返回描述。",
	"avatar.describe_current.world_system": "描述提供的公开世界图片，用于新的 Bickr 世界头像。包含景色、建筑、物体、氛围、风格、颜色、光线、背景、取景和布局的具体细节。只返回描述。",
	"avatar.world_source.system": "为公开的 Bickr 世界头像写一个视觉提示词。用背景设定和成员个人资料描述这个世界的一张图像。包含关于地标、景色、氛围、光线、颜色、质感、布局和镜头视角的具体细节。不要包含说明文字、叠加文字、界面元素、水印或关于过程的评论。只返回提示词。",
	"avatar.image.world_refresh": "将提供的当前世界图片用作更新公开世界头像的视觉输入。",
	"avatar.image.participant_refresh": "将提供的当前个人资料图片用作更新公开个人头像的视觉输入。",
	"avatar.describe_current.world": "为更新后的公开世界头像提示词，对所提供的当前世界图片做完整的视觉描述。",
	"avatar.describe_current.participant": "为更新后的公开头像提示词，对所提供的当前个人资料图片做完整的视觉描述。",
	"avatar.persona_description.structured": "描述你的头像图片。返回所需的 JSON 对象。以角色身份用第一人称写描述。提供大量关于外貌、风格、场景、光线和布局的具体视觉细节。只描述可见的内容。",
	"avatar.persona_description.tool": "描述你的头像图片。调用 {{toolName}}。以角色身份用第一人称写。提供大量关于外貌、风格、场景、光线和布局的具体视觉细节。只描述可见的内容。",
	"avatar.persona_description.repair_structured": "返回一个 JSON 对象，其中恰好有一个名为 description 的字段。以角色身份、用第一人称写它。只描述看得见的外观、风格、场景、光线和布局。",
	"avatar.persona_description.repair_tool": "调用 {{toolName}}。以角色身份用第一人称写。只描述可见的外貌、风格、场景、光线和布局。",
	"avatar.world_source.description_and_detail": "世界名称：{{worldName}}\n简短描述：\n{{description}}\n\n其他背景设定细节：\n{{detail}}",
	"avatar.world_source.description": "世界名称：{{worldName}}\n简短描述：\n{{description}}",
	"avatar.world_source.detail": "世界名称：{{worldName}}\n背景设定细节：\n{{detail}}",
	"avatar.image.currentIncluded": "[已包含当前头像图片]"
} as const;
