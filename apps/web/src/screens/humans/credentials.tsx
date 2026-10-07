import type { AccountCredential, AccountCredentialPage } from "@bickr/shared/auth-credentials";
import type { McpScope } from "@bickr/shared/mcp-auth";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { useRequestIdentity } from "../../use-request-identity";
import { Confirm } from "../../ui";

type Selection = { kind: "credential"; credential: AccountCredential } | { kind: "all" };
const permissions: Record<McpScope, string> = {
	"bickr.read": "Read Bickr content", "bickr.write": "Create and change Bickr content", "bickr.runtime": "Manage participant activity",
};

function originalName(credential: AccountCredential): string {
	switch (credential.kind) {
		case "session": {
			const details = credential.browserDetails;
			if (details?.browser && details.operatingSystem) return `${details.browser} on ${details.operatingSystem}`;
			if (details?.browser) return `${details.browser} · device details unavailable`;
			if (details?.operatingSystem) return `Browser on ${details.operatingSystem}`;
			return "Browser details unavailable";
		}
		case "cli_token": return credential.label;
		case "mcp_grant": return credential.clientName || "Unnamed MCP app";
	}
}

function description(credential: AccountCredential) {
	switch (credential.kind) {
		case "session": return { kind: "Browser session", created: "Signed in", action: "Sign out", consequence: credential.isCurrent ? "This signs you out of this browser." : "This signs out the selected browser session." };
		case "cli_token": return { kind: "CLI token", created: "Created", action: "Revoke token", consequence: "Requests that use this CLI token will fail." };
		case "mcp_grant": return { kind: "MCP connection", created: "Connected", action: "Disconnect", consequence: "This disconnects this app connection. Its access and refresh tokens will no longer work." };
	}
}

function shortDate(value: string): string {
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Unknown";
}

export function AccountCredentials(props: { userId: string; onSessionRevoked: () => void }) {
	return <CredentialPanel key={props.userId} onSessionRevoked={props.onSessionRevoked} />;
}

function CredentialPanel({ onSessionRevoked }: { onSessionRevoked: () => void }) {
	const requests = useRequestIdentity();
	const [page, setPage] = useState<AccountCredentialPage | null>(null);
	const [cursor, setCursor] = useState("");
	const [busy, setBusy] = useState(true);
	const [error, setError] = useState("");
	const [selection, setSelection] = useState<Selection | null>(null);
	const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

	async function load(after = "") {
		const current = requests.begin();
		setBusy(true);
		setError("");
		const result = await api<AccountCredentialPage>(`/api/me/auth/credentials?after=${encodeURIComponent(after)}`, { timeoutMs: 15_000 });
		if (!current()) return;
		if (result.ok) {
			setPage(result.data);
			setCursor(after);
		} else if (result.error === "unauthorized") {
			onSessionRevoked();
		} else setError(result.message);
		setBusy(false);
	}

	useEffect(() => { void load(); }, [requests]);

	async function revoke(target: Selection) {
		const current = requests.begin();
		setBusy(true);
		setError("");
		const result = await api<{ revoked: boolean; sessionRevoked: boolean }>("/api/me/auth/credentials", {
			method: "DELETE", body: target.kind === "all" ? { kind: "all" } : { kind: "credential", id: target.credential.id }, timeoutMs: 15_000,
		});
		if (!current()) return;
		if (!result.ok) {
			if (result.error === "unauthorized") onSessionRevoked();
			else setError(result.message);
			setBusy(false);
			return;
		}
		if (result.data.sessionRevoked) onSessionRevoked();
		else {
			setEditing(null);
			await load();
		}
	}

	async function rename() {
		if (!editing || busy) return;
		const current = requests.begin();
		setBusy(true);
		setError("");
		const result = await api<{ renamed: boolean }>("/api/me/auth/credentials", {
			method: "PATCH", body: { id: editing.id, name: editing.name }, timeoutMs: 15_000,
		});
		if (!current()) return;
		if (!result.ok) {
			if (result.error === "unauthorized") onSessionRevoked();
			else setError(result.message);
			setBusy(false);
			return;
		}
		setEditing(null);
		await load(cursor);
	}

	const selected = selection?.kind === "credential" ? description(selection.credential) : null;
	return <section className="section account-access">
		<div className="section-head"><h2>Account access</h2></div>
		<p className="help">Manage signed-in browsers, CLI tokens, and connected apps.</p>
		{page && !page.legacyMigrationComplete && <p className="help">Some older access is not listed. Revoke all access includes it.</p>}
		{error && <p className="runtime-message" role="alert">{error}</p>}
		<div className="field-stack" aria-busy={busy}>
			{page?.credentials.map((credential) => {
				const info = description(credential);
				const name = credential.customName || originalName(credential);
				return <article className="card credential-card" key={credential.id} aria-label={name}>
					<div className="credential-title">{name}</div>
					<div className="credential-meta">{info.kind}{credential.kind === "session" && credential.isCurrent && <span className="credential-current">This session</span>}</div>
					<div className="credential-meta">{info.created} <time dateTime={credential.createdAt}>{shortDate(credential.createdAt)}</time></div>
					<div className="credential-meta">Expires <time dateTime={credential.expiresAt}>{shortDate(credential.expiresAt)}</time></div>
					<details className="credential-details">
						<summary>Access details</summary>
						{credential.customName && <p>Original name: {originalName(credential)}</p>}
						{credential.kind === "mcp_grant" && <>
							<p>Client ID: <code>{credential.clientId}</code></p>
							<p>App names are supplied by the connected app.</p>
							<p>Permissions: {credential.scopes.map((scope) => permissions[scope]).join(", ") || "None"}</p>
						</>}
						<p>Access ID: <code>{credential.id}</code></p>
						<p>{info.created}: {new Date(credential.createdAt).toLocaleString()}</p>
						<p>Expires: {new Date(credential.expiresAt).toLocaleString()}</p>
					</details>
					{editing?.id === credential.id ? <form className="credential-name-form" onSubmit={(event) => { event.preventDefault(); void rename(); }}>
						<label htmlFor={`credential-name-${credential.id}`}>Name for this access</label>
						<input className="input" id={`credential-name-${credential.id}`} maxLength={120} disabled={busy} autoFocus
							onChange={(event) => setEditing({ id: credential.id, name: event.target.value })} value={editing.name} />
						<p className="help">For example, Work laptop. Leave blank to use the original name.</p>
						<div className="actions">
							<button className="btn" disabled={busy} type="submit">Save name</button>
							<button className="btn ghost" disabled={busy} onClick={() => setEditing(null)} type="button">Cancel</button>
						</div>
					</form> : <div className="actions">
						<button className="btn ghost" disabled={busy} onClick={() => setEditing({ id: credential.id, name: credential.customName ?? "" })} type="button">Rename</button>
						<button className="btn ghost danger" disabled={busy} onClick={() => setSelection({ kind: "credential", credential })} type="button">{info.action}</button>
					</div>}
				</article>;
			})}
			{page?.credentials.length === 0 && <p>{cursor ? "No active access on this page." : "No active access to show."}</p>}
		</div>
		<div className="actions">
			<button className="btn ghost" disabled={busy} onClick={() => { setEditing(null); void load(); }} type="button">{cursor ? "First page" : "Refresh access"}</button>
			{page?.nextCursor && <button className="btn ghost" disabled={busy} onClick={() => { setEditing(null); void load(page.nextCursor!); }} type="button">Next page</button>}
			<button className="btn danger" disabled={busy} onClick={() => setSelection({ kind: "all" })} type="button">Revoke all access</button>
		</div>
		<Confirm open={selection !== null} title={selected ? `${selected.action}?` : "Revoke all account access?"}
			body={selected ? <><p>{selection?.kind === "credential" && (selection.credential.customName || originalName(selection.credential))}</p><p>{selected.consequence}</p></>
				: "This signs you out on every device and disconnects all apps. You can sign in again."}
			confirmText={selected?.action ?? "Revoke"} danger onClose={() => setSelection(null)} onConfirm={() => { if (selection && !busy) void revoke(selection); }} />
	</section>;
}
