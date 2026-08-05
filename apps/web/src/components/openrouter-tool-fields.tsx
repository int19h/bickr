import { Field } from "../ui";
import {
	type BotToolDraft,
	type OpenRouterDatetimeToolDraft,
	type OpenRouterWebFetchToolDraft,
	type OpenRouterWebSearchToolDraft,
} from "../tool-settings-draft";

const webSearchEngineOptions = ["auto", "native", "exa", "firecrawl", "parallel"];

const webFetchEngineOptions = ["auto", "native", "exa", "openrouter", "firecrawl"];

const searchContextSizeOptions = ["low", "medium", "high"];

export function OpenRouterServerToolFields({
	available,
	draft,
	onChange,
}: {
	available: boolean;
	draft: BotToolDraft;
	onChange: (draft: BotToolDraft) => void;
}) {
	function patchOpenRouter(update: Partial<BotToolDraft["openRouter"]>): void {
		onChange({ openRouter: { ...draft.openRouter, ...update } });
	}

	function patchDatetime(update: Partial<OpenRouterDatetimeToolDraft>): void {
		patchOpenRouter({ datetime: { ...draft.openRouter.datetime, ...update } });
	}

	function patchWebSearch(update: Partial<OpenRouterWebSearchToolDraft>): void {
		patchOpenRouter({ webSearch: { ...draft.openRouter.webSearch, ...update } });
	}

	function patchWebFetch(update: Partial<OpenRouterWebFetchToolDraft>): void {
		patchOpenRouter({ webFetch: { ...draft.openRouter.webFetch, ...update } });
	}

	return (
		<div className="field-stack">
			{!available && <div className="help">Unavailable while this participant uses a non-OpenRouter base URL.</div>}
			<fieldset className="tool-group" disabled={!available}>
				<label className="tool-group-title">
					<input
						checked={draft.openRouter.datetime.enabled}
						onChange={(event) => patchDatetime({ enabled: event.target.checked })}
						type="checkbox"
					/>
					<span>Datetime</span>
				</label>
				<Field help="IANA timezone name. Blank uses OpenRouter's default." label="Timezone">
					<input
						className="input"
						disabled={!draft.openRouter.datetime.enabled}
						onChange={(event) => patchDatetime({ timezone: event.target.value })}
						placeholder="America/Los_Angeles"
						value={draft.openRouter.datetime.timezone}
					/>
				</Field>
			</fieldset>
			<fieldset className="tool-group" disabled={!available}>
				<label className="tool-group-title">
					<input
						checked={draft.openRouter.webSearch.enabled}
						onChange={(event) => patchWebSearch({ enabled: event.target.checked })}
						type="checkbox"
					/>
					<span>Web Search</span>
				</label>
				<div className="field-row">
					<Field label="Engine">
						<select
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ engine: event.target.value })}
							value={draft.openRouter.webSearch.engine}
						>
							<option value="">default</option>
							{webSearchEngineOptions.map((engine) => (
								<option key={engine} value={engine}>
									{engine}
								</option>
							))}
						</select>
					</Field>
					<Field label="Context size">
						<select
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ searchContextSize: event.target.value })}
							value={draft.openRouter.webSearch.searchContextSize}
						>
							<option value="">default</option>
							{searchContextSizeOptions.map((size) => (
								<option key={size} value={size}>
									{size}
								</option>
							))}
						</select>
					</Field>
				</div>
				<div className="field-row">
					<Field label="Max results">
						<input
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							max={25}
							min={1}
							onChange={(event) => patchWebSearch({ maxResults: event.target.value })}
							placeholder="5"
							type="number"
							value={draft.openRouter.webSearch.maxResults}
						/>
					</Field>
					<Field label="Max total results">
						<input
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							min={1}
							onChange={(event) => patchWebSearch({ maxTotalResults: event.target.value })}
							placeholder="default"
							type="number"
							value={draft.openRouter.webSearch.maxTotalResults}
						/>
					</Field>
				</div>
				<div className="field-row">
					<Field label="Allowed domains">
						<textarea
							className="textarea domain-list"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ allowedDomains: event.target.value })}
							placeholder="example.com, docs.example.com"
							rows={2}
							value={draft.openRouter.webSearch.allowedDomains}
						/>
					</Field>
					<Field label="Excluded domains">
						<textarea
							className="textarea domain-list"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ excludedDomains: event.target.value })}
							placeholder="reddit.com"
							rows={2}
							value={draft.openRouter.webSearch.excludedDomains}
						/>
					</Field>
				</div>
				<div className="field-row">
					<Field label="Location city">
						<input
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ userLocationCity: event.target.value })}
							placeholder="San Francisco"
							value={draft.openRouter.webSearch.userLocationCity}
						/>
					</Field>
					<Field label="Location region">
						<input
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ userLocationRegion: event.target.value })}
							placeholder="California"
							value={draft.openRouter.webSearch.userLocationRegion}
						/>
					</Field>
				</div>
				<div className="field-row">
					<Field label="Location country">
						<input
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							maxLength={2}
							onChange={(event) => patchWebSearch({ userLocationCountry: event.target.value })}
							placeholder="US"
							value={draft.openRouter.webSearch.userLocationCountry}
						/>
					</Field>
					<Field label="Location timezone">
						<input
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ userLocationTimezone: event.target.value })}
							placeholder="America/Los_Angeles"
							value={draft.openRouter.webSearch.userLocationTimezone}
						/>
					</Field>
				</div>
			</fieldset>
			<fieldset className="tool-group" disabled={!available}>
				<label className="tool-group-title">
					<input
						checked={draft.openRouter.webFetch.enabled}
						onChange={(event) => patchWebFetch({ enabled: event.target.checked })}
						type="checkbox"
					/>
					<span>Web Fetch</span>
				</label>
				<div className="field-row">
					<Field label="Engine">
						<select
							className="input"
							disabled={!draft.openRouter.webFetch.enabled}
							onChange={(event) => patchWebFetch({ engine: event.target.value })}
							value={draft.openRouter.webFetch.engine}
						>
							<option value="">default</option>
							{webFetchEngineOptions.map((engine) => (
								<option key={engine} value={engine}>
									{engine}
								</option>
							))}
						</select>
					</Field>
					<Field label="Max uses">
						<input
							className="input"
							disabled={!draft.openRouter.webFetch.enabled}
							min={1}
							onChange={(event) => patchWebFetch({ maxUses: event.target.value })}
							placeholder="default"
							type="number"
							value={draft.openRouter.webFetch.maxUses}
						/>
					</Field>
				</div>
				<Field label="Max content tokens">
					<input
						className="input"
						disabled={!draft.openRouter.webFetch.enabled}
						min={1}
						onChange={(event) => patchWebFetch({ maxContentTokens: event.target.value })}
						placeholder="50000"
						type="number"
						value={draft.openRouter.webFetch.maxContentTokens}
					/>
				</Field>
				<div className="field-row">
					<Field label="Allowed domains">
						<textarea
							className="textarea domain-list"
							disabled={!draft.openRouter.webFetch.enabled}
							onChange={(event) => patchWebFetch({ allowedDomains: event.target.value })}
							placeholder="docs.example.com"
							rows={2}
							value={draft.openRouter.webFetch.allowedDomains}
						/>
					</Field>
					<Field label="Blocked domains">
						<textarea
							className="textarea domain-list"
							disabled={!draft.openRouter.webFetch.enabled}
							onChange={(event) => patchWebFetch({ blockedDomains: event.target.value })}
							placeholder="private.example.com"
							rows={2}
							value={draft.openRouter.webFetch.blockedDomains}
						/>
					</Field>
				</div>
			</fieldset>
		</div>
	);
}
