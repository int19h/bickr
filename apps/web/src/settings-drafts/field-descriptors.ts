export type DraftFieldDescriptor<
	Draft extends object,
	Settings,
	Input extends object,
	Context,
> = {
	[K in keyof Draft]: {
		key: K;
		inputKey?: keyof Input;
		defaultValue: Draft[K] | ((context: Context) => Draft[K]);
		format: (settings: Settings, context: Context) => Draft[K] | undefined;
		parse?: (value: Draft[K], draft: Draft, context: Context) => Input[keyof Input];
		changed: (draftValue: Draft[K], savedValue: Draft[K], settings: Settings, context: Context) => boolean;
	};
}[keyof Draft];

export function draftFromFieldDescriptors<
	Draft extends object,
	Settings,
	Input extends object,
	Context,
>(
	descriptors: readonly DraftFieldDescriptor<Draft, Settings, Input, Context>[],
	settings: Settings,
	context: Context,
): Partial<Draft> {
	const result: Partial<Draft> = {};
	for (const descriptor of descriptors) {
		const formatted = descriptor.format(settings, context);
		const defaultValue =
			typeof descriptor.defaultValue === "function" ?
				(descriptor.defaultValue as (context: Context) => Draft[keyof Draft])(context)
			:	descriptor.defaultValue;
		(result as Record<keyof Draft, Draft[keyof Draft]>)[descriptor.key] = formatted ?? defaultValue;
	}
	return result;
}

export function inputFromFieldDescriptors<
	Draft extends object,
	Settings,
	Input extends object,
	Context,
>(
	descriptors: readonly DraftFieldDescriptor<Draft, Settings, Input, Context>[],
	draft: Draft,
	context: Context,
): Input {
	const result: Partial<Input> = {};
	for (const descriptor of descriptors) {
		if (descriptor.inputKey !== undefined && descriptor.parse) {
			(result as Record<keyof Input, Input[keyof Input]>)[descriptor.inputKey] = descriptor.parse(
			draft[descriptor.key],
			draft,
			context,
		);
		}
	}
	return result as Input;
}

export function draftChangedByFieldDescriptors<
	Draft extends object,
	Settings,
	Input extends object,
	Context,
>(
	descriptors: readonly DraftFieldDescriptor<Draft, Settings, Input, Context>[],
	draft: Draft,
	settings: Settings,
	context: Context,
): boolean {
	return descriptors.some((descriptor) => {
		const formatted = descriptor.format(settings, context);
		const defaultValue =
			typeof descriptor.defaultValue === "function" ?
				(descriptor.defaultValue as (context: Context) => Draft[keyof Draft])(context)
			:	descriptor.defaultValue;
		return descriptor.changed(draft[descriptor.key], formatted ?? defaultValue, settings, context);
	});
}
