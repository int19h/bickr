import {
	InferenceConfigurationDataError,
	inheritInferenceConfigurationInput,
	inferenceConfigurationOwnerQuota,
	resolveInferenceConfigurationValues,
	type InferenceConfigurationNode,
	type InheritedInferenceInput,
	type InferenceResolutionValues,
	type ResolveInferenceConfigurationOptions,
} from "./inference-configuration";

type ResolvedNode = {
	node: InferenceConfigurationNode;
	input: InheritedInferenceInput;
	account: InheritedInferenceInput;
	depth: number;
	values: InferenceResolutionValues;
};

/** Resolve each required ancestor once within one immutable graph snapshot. */
export function createInferenceSnapshotResolver(
	snapshot: ReadonlyMap<string, InferenceConfigurationNode>,
	options: ResolveInferenceConfigurationOptions = {},
): (configurationId: string) => InferenceResolutionValues {
	const resolved = new Map<string, ResolvedNode>();
	return (configurationId) => {
		const pending: InferenceConfigurationNode[] = [];
		const visited = new Set<string>();
		let currentId: string | null = configurationId;
		let parent: ResolvedNode | undefined;
		while (currentId !== null) {
			parent = resolved.get(currentId);
			if (parent) break;
			if (visited.has(currentId)) {
				throw new InferenceConfigurationDataError("path_cycle", "Inference configuration snapshot contains a cycle.");
			}
			visited.add(currentId);
			const node = snapshot.get(currentId);
			if (!node || node.id !== currentId) {
				throw new InferenceConfigurationDataError("invalid_path", "Inference configuration snapshot is incomplete.");
			}
			pending.push(node);
			if (pending.length > inferenceConfigurationOwnerQuota) {
				throw new InferenceConfigurationDataError("path_over_limit", "Inference configuration path exceeds the owner quota.");
			}
			currentId = node.parentId;
		}
		for (let index = pending.length - 1; index >= 0; index -= 1) {
			const node = pending[index]!;
			if (parent ? node.parentId !== parent.node.id || node.ownerUserId !== parent.node.ownerUserId :
				node.kind !== "account_default" || node.parentId !== null) {
				throw new InferenceConfigurationDataError("invalid_path", "Inference configuration snapshot has a broken parent edge.");
			}
			const depth = parent ? parent.depth + 1 : 0;
			if (depth >= inferenceConfigurationOwnerQuota) {
				throw new InferenceConfigurationDataError("path_over_limit", "Inference configuration path exceeds the owner quota.");
			}
			const input = inheritInferenceConfigurationInput(node, parent?.input, parent?.account, depth, options.defaults);
			parent = {
				node,
				input,
				account: parent?.account ?? input,
				depth,
				values: resolveInferenceConfigurationValues(input, options),
			};
			resolved.set(node.id, parent);
		}
		if (!parent) throw new InferenceConfigurationDataError("invalid_path", "Inference configuration snapshot is empty.");
		return parent.values;
	};
}
