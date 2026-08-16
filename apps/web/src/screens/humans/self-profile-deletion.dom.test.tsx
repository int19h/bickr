import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localizedText, type HumanProfile, type PublicUser } from "@bickr/shared/model";
import { ToastContext, type ToastHandle } from "../../ui";
import { HumanProfileScreen } from "./public-profile";

/**
 * Self-profile deletion as a parent-owned mutation.
 *
 * `App` reports the typed outcome of this deletion, which is *not* always
 * "deleted": a cascade that is only accepted reports as pending. A screen-local
 * confirmation would both double-report and, in the pending case, contradict
 * the real outcome — so the screen must stay silent and let the parent speak.
 */

const currentUser: PublicUser = {
	id: "usr_self",
	handle: "self",
	language: null,
	displayName: localizedText("Self", null),
	profileComplete: true,
};

const profile: HumanProfile = {
	user: currentUser,
	worlds: [],
	forumsByWorld: [],
	botsByWorld: [],
	totals: { worlds: 0, forums: 0, bots: 0 },
	isSelf: true,
	deleteEligibility: { canDelete: true, blockers: [] },
};

let container: HTMLDivElement;
let root: Root;
let pushed: unknown[];
let deletions: number;

/** The danger-zone button and the final confirm share a label, so scope matters. */
function clickButton(label: string, selector = ""): void {
	const button = Array.from(container.querySelectorAll(`${selector} button`.trim())).find(
		(candidate) => candidate.textContent?.trim() === label,
	);
	expect(button, `no button labelled ${label}`).toBeDefined();
	act(() => {
		(button as HTMLButtonElement).click();
	});
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	pushed = [];
	deletions = 0;
	vi.stubGlobal("fetch", () =>
		Promise.resolve(new Response(JSON.stringify({ ok: true, data: { profile } }), { status: 200 })),
	);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);

	const toast: ToastHandle = { push: (message) => pushed.push(message) };
	await act(async () => {
		root.render(
			<ToastContext.Provider value={toast}>
				<HumanProfileScreen
					busy={false}
					currentUser={currentUser}
					handle="self"
					onDeleteProfile={() => {
						deletions += 1;
						return Promise.resolve(true);
					}}
				/>
			</ToastContext.Provider>,
		);
	});
});

afterEach(() => {
	act(() => {
		root.unmount();
	});
	container.remove();
	vi.unstubAllGlobals();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("self-profile deletion", () => {
	it("hands the confirmed deletion to the parent without reporting it itself", async () => {
		clickButton("Delete profile", ".danger-zone");
		clickButton("Review deletion", ".modal-foot");
		clickButton("Delete profile", ".modal-foot");
		await act(async () => {
			await Promise.resolve();
		});

		expect(deletions).toBe(1);
		expect(pushed).toEqual([]);
	});
});
