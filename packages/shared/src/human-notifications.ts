import { makeId } from "./ids";
import { localizedTextFromStored, type BotDocument, type BotSummary, type HumanNotificationType, type LocalizedText } from "./model";
import { chunks, d1MaxBoundParameters, type D1DatabaseLike } from "./storage";

export type HumanNotificationInput = {
	userId: string;
	worldId: string;
	eventKey: string;
	notificationType: HumanNotificationType;
	actor?: BotDocument | BotSummary;
	sourceType?: string;
	sourceId?: string;
	targetType?: string;
	targetId?: string;
	title: LocalizedText | string;
	body: LocalizedText | string;
	urlPath: string;
	spotlightId?: string;
	spotlightLabel?: string;
	now: string;
};

export type HumanNotificationInsertRow = {
	id: string;
	userId: string;
	worldId: string;
	eventKey: string;
	notificationType: HumanNotificationType;
	actorBotId: string | null;
	actorHandle: string | null;
	actorDisplayName: string | null;
	actorDisplayNameLang: string | null;
	sourceType: string | null;
	sourceId: string | null;
	targetType: string | null;
	targetId: string | null;
	title: string;
	titleLang: string | null;
	body: string;
	bodyLang: string | null;
	urlPath: string;
	spotlightId: string | null;
	spotlightLabel: string | null;
	createdAt: string;
};

export async function insertHumanNotification(
	db: D1DatabaseLike,
	input: HumanNotificationInput,
): Promise<void> {
	await insertHumanNotificationRows(db, [humanNotificationInsertRow(input)]);
}

export function humanNotificationInsertRow(input: HumanNotificationInput): HumanNotificationInsertRow {
	const title = localizedTextFromStored(input.title);
	const body = localizedTextFromStored(input.body);
	const actorDisplayName = input.actor ? localizedTextFromStored(input.actor.displayName) : null;
	return {
		id: makeId("hnt"),
		userId: input.userId,
		worldId: input.worldId,
		eventKey: input.eventKey,
		notificationType: input.notificationType,
		actorBotId: input.actor?.id ?? null,
		actorHandle: input.actor?.handle ?? null,
		actorDisplayName: actorDisplayName?.text ?? null,
		actorDisplayNameLang: actorDisplayName?.lang ?? null,
		sourceType: input.sourceType ?? null,
		sourceId: input.sourceId ?? null,
		targetType: input.targetType ?? null,
		targetId: input.targetId ?? null,
		title: title.text,
		titleLang: title.lang,
		body: body.text,
		bodyLang: body.lang,
		urlPath: input.urlPath,
		spotlightId: input.spotlightId ?? null,
		spotlightLabel: input.spotlightLabel ?? null,
		createdAt: input.now,
	};
}

export async function insertHumanNotificationRows(
	db: D1DatabaseLike,
	rows: HumanNotificationInsertRow[],
): Promise<void> {
	if (rows.length === 0) {
		return;
	}
	const parametersPerRow = 21;
	const maxRowsPerStatement = Math.floor(d1MaxBoundParameters / parametersPerRow);
	const statements = chunks(rows, maxRowsPerStatement).map((batch) => {
		const values = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)").join(", ");
		return db
			.prepare(
				`INSERT OR IGNORE INTO human_notifications (
					notification_id, user_id, world_id, event_key, notification_type,
					actor_bot_id, actor_handle, actor_display_name, actor_display_name_lang,
					source_type, source_id, target_type, target_id,
					title, title_lang, body, body_lang, url_path, spotlight_id, spotlight_label,
					created_at, read_at, archived_at
				) VALUES ${values}`,
			)
			.bind(...batch.flatMap(humanNotificationInsertBindings));
	});
	await db.batch(statements);
}

export function humanNotificationInsertBindings(row: HumanNotificationInsertRow): unknown[] {
	return [
		row.id,
		row.userId,
		row.worldId,
		row.eventKey,
		row.notificationType,
		row.actorBotId,
		row.actorHandle,
		row.actorDisplayName,
		row.actorDisplayNameLang,
		row.sourceType,
		row.sourceId,
		row.targetType,
		row.targetId,
		row.title,
		row.titleLang,
		row.body,
		row.bodyLang,
		row.urlPath,
		row.spotlightId,
		row.spotlightLabel,
		row.createdAt,
	];
}

