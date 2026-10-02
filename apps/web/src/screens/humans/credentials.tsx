import type { AccountCredential } from "@bickr/shared/auth-credentials";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { useRequestIdentity } from "../../use-request-identity";
import { Confirm } from "../../ui";

type CredentialPage = { credentials: AccountCredential[]; nextCursor: string | null; legacyMigrationComplete: boolean };
type Selection = { kind: "credential"; id: string } | { kind: "all" };

export function AccountCredentials(props: { userId: string; onSessionRevoked: () => void }) {
	return <CredentialPanel key={props.userId} onSessionRevoked={props.onSessionRevoked} />;
}

function CredentialPanel({ onSessionRevoked }: { onSessionRevoked: () => void }) {
	const requests = useRequestIdentity();
	const [page, setPage] = useState<CredentialPage | null>(null);
	const [cursor, setCursor] = useState("");
	const [busy, setBusy] = useState(true);
	const [error, setError] = useState("");
	const [selection, setSelection] = useState<Selection | null>(null);

	async function load(after = "") {
		const current = requests.begin();
		setBusy(true);
		setError("");
		const result = await api<CredentialPage>(`/api/me/auth/credentials?after=${encodeURIComponent(after)}`, { timeoutMs: 15_000 });
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
		const result = await api<{ revoked: boolean }>("/api/me/auth/credentials", {
			method: "DELETE", body: target, timeoutMs: 15_000,
		});
		if (!current()) return;
		if (!result.ok) {
			setError(result.message);
			setBusy(false);
			return;
		}
		if (target.kind === "all") onSessionRevoked();
		else await load(cursor);
	}

	return <section className="section">
		<div className="section-head"><h2>Account access</h2></div>
		<p className="help">Review browser sessions, CLI tokens, and connected apps. Revoking access prevents future requests with that credential.</p>
		{page && !page.legacyMigrationComplete && <p className="help">Some older credentials are not listed yet. Revoke all access also covers them.</p>}
		{error && <p className="runtime-message" role="alert">{error}</p>}
		<div className="field-stack" aria-busy={busy}>
			{page?.credentials.map((credential) => <div className="card" key={credential.id}>
				<div>{credential.label}</div>
				<div className="meta">{credential.kind === "session" ? "Browser session" : credential.kind === "cli_token" ? "CLI token" : "Connected app"}</div>
				<div className="meta">Expires {new Date(credential.expiresAt).toLocaleString()}</div>
				{credential.revokedAt ? <span>Revoked</span> : <button className="btn ghost danger" disabled={busy}
					onClick={() => setSelection({ kind: "credential", id: credential.id })} type="button">Revoke access</button>}
			</div>)}
			{page?.credentials.length === 0 && <p>No credentials on this page.</p>}
		</div>
		<div className="actions">
			<button className="btn ghost" disabled={busy} onClick={() => void load()} type="button">{cursor ? "First page" : "Refresh access"}</button>
			{page?.nextCursor && <button className="btn ghost" disabled={busy} onClick={() => void load(page.nextCursor!)} type="button">Next page</button>}
			<button className="btn danger" disabled={busy} onClick={() => setSelection({ kind: "all" })} type="button">Revoke all access</button>
		</div>
		<Confirm open={selection !== null} title={selection?.kind === "all" ? "Revoke all account access?" : "Revoke this access?"}
			body={selection?.kind === "all" ? "This signs you out on every device and disconnects all apps. You can sign in again." : "Requests that use this credential will fail. Revoking this browser session signs you out."}
			confirmText="Revoke" danger onClose={() => setSelection(null)} onConfirm={() => { if (selection && !busy) void revoke(selection); }} />
	</section>;
}
