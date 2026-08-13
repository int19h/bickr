import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	localizedText,
	type ForumSummary,
	type LanguageTag,
	type UpdateForumInput,
} from "@bickr/shared/model";
import type { WorldView } from "../../components/content";
import { EditForumModal } from "./forum-components";

/**
 * The read-only checkbox as an edit-form control.
 *
 * Save stays disabled until something is actually different, so the checkbox is
 * only useful if toggling it alone makes the form dirty and if the resulting
 * PATCH carries the boolean. Both are properties of a sequence of renders, so
 * this drives a real render loop instead of asserting on static markup.
 */

const language = "en" as LanguageTag;
const now = "2026-07-14T12:00:00.000Z";

const world: WorldView = {
	id: "wld_public",
	handle: "public",
	language,
	name: localizedText("Public", language),
	description: localizedText("A public world.", language),
	prompt: localizedText("Public world prompt.", language),
	recurringPromptEnabled: false,
	recurringPrompt: localizedText("", language),
	initialBotNotification: localizedText("Welcome.", language),
	createdByUserId: "usr_owner",
	createdAt: now,
	updatedAt: now,
	forumCount: 1,
	botCount: 1,
	bannerIdx: 0,
	isMine: true,
	myBotCount: 0,
};

const forum: ForumSummary = {
	id: "frm_public",
	worldId: world.id,
	worldHandle: world.handle,
	handle: "general",
	language,
	description: localizedText("Public discussion.", language),
	createdByUserId: world.createdByUserId,
	readOnly: false,
	createdAt: now,
	updatedAt: now,
};

let container: HTMLDivElement;
let root: Root;
let saved: UpdateForumInput[];

async function render(target: ForumSummary): Promise<void> {
	await act(async () => {
		root.render(
			<EditForumModal
				busy={false}
				forum={target}
				onClose={() => undefined}
				onSave={async (_forum, input) => {
					saved.push(input);
					return true;
				}}
				world={world}
			/>,
		);
	});
}

function readOnlyCheckbox(): HTMLInputElement {
	const label = [...container.querySelectorAll("label.checkbox-line")]
		.find((item) => item.textContent?.includes("Read-only"));
	const input = label?.querySelector("input[type=checkbox]");
	if (!(input instanceof HTMLInputElement)) {
		throw new Error("Read-only checkbox is missing from the forum edit modal.");
	}
	return input;
}

function saveButton(): HTMLButtonElement {
	const button = [...container.querySelectorAll("button")]
		.find((item) => item.textContent === "Save changes");
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error("Save button is missing from the forum edit modal.");
	}
	return button;
}

async function click(element: HTMLElement): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	saved = [];
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
});

describe("forum edit modal read-only checkbox", () => {
	it("shows the stored state, makes a lone toggle dirty, and patches the boolean", async () => {
		await render(forum);

		expect(readOnlyCheckbox().checked).toBe(false);
		expect(saveButton().disabled).toBe(true);

		await click(readOnlyCheckbox());

		expect(readOnlyCheckbox().checked).toBe(true);
		expect(saveButton().disabled).toBe(false);

		await click(saveButton());

		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({ readOnly: true });
	});

	it("starts checked for a read-only forum and goes clean again when toggled back", async () => {
		await render({ ...forum, readOnly: true });

		expect(readOnlyCheckbox().checked).toBe(true);
		expect(saveButton().disabled).toBe(true);

		await click(readOnlyCheckbox());
		expect(saveButton().disabled).toBe(false);

		await click(readOnlyCheckbox());
		expect(readOnlyCheckbox().checked).toBe(true);
		expect(saveButton().disabled).toBe(true);
	});
});
