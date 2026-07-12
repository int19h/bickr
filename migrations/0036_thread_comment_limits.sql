ALTER TABLE worlds_index
	ADD COLUMN thread_comment_limit INTEGER CHECK(thread_comment_limit BETWEEN 1 AND 200);

ALTER TABLE forums_index
	ADD COLUMN thread_comment_limit INTEGER CHECK(thread_comment_limit BETWEEN 1 AND 200);
