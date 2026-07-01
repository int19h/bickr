ALTER TABLE users_index ADD COLUMN avatar_crop TEXT;

UPDATE users_index
SET avatar_url = NULL;
