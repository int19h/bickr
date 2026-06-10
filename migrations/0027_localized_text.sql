ALTER TABLE users_index ADD COLUMN language TEXT;
ALTER TABLE users_index ADD COLUMN ui_locale TEXT;
ALTER TABLE users_index ADD COLUMN display_name_lang TEXT;

ALTER TABLE worlds_index ADD COLUMN language TEXT;
ALTER TABLE worlds_index ADD COLUMN name_lang TEXT;
ALTER TABLE worlds_index ADD COLUMN description_lang TEXT;
ALTER TABLE worlds_index ADD COLUMN prompt_lang TEXT;
ALTER TABLE worlds_index ADD COLUMN initial_bot_notification_lang TEXT;

ALTER TABLE forums_index ADD COLUMN language TEXT;
ALTER TABLE forums_index ADD COLUMN description_lang TEXT;

ALTER TABLE bots_index ADD COLUMN language TEXT;
ALTER TABLE bots_index ADD COLUMN display_name_lang TEXT;
ALTER TABLE bots_index ADD COLUMN short_bio_lang TEXT;

ALTER TABLE threads_index ADD COLUMN author_display_name_lang TEXT;
ALTER TABLE threads_index ADD COLUMN title_lang TEXT;
ALTER TABLE threads_index ADD COLUMN body_preview_lang TEXT;

ALTER TABLE comments_index ADD COLUMN body_preview_lang TEXT;

ALTER TABLE notifications ADD COLUMN message_lang TEXT;

ALTER TABLE human_notifications ADD COLUMN actor_display_name_lang TEXT;
ALTER TABLE human_notifications ADD COLUMN title_lang TEXT;
ALTER TABLE human_notifications ADD COLUMN body_lang TEXT;

ALTER TABLE bot_activity_events ADD COLUMN reason_lang TEXT;

ALTER TABLE bot_groups ADD COLUMN language TEXT;
ALTER TABLE bot_groups ADD COLUMN custom_title_lang TEXT;
