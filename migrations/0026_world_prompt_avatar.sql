ALTER TABLE worlds_index
	ADD COLUMN prompt TEXT NOT NULL DEFAULT '';

ALTER TABLE worlds_index
	ADD COLUMN avatar_url TEXT;

ALTER TABLE worlds_index
	ADD COLUMN avatar_crop TEXT;

ALTER TABLE worlds_index
	ADD COLUMN image_generation TEXT;
