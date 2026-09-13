-- One private acknowledgement per human account, retained for the account's
-- lifetime (including soft deletion) so the invitation can never recur.
-- Hard account removal cascades; this is canonical state, not a profile index.
CREATE TABLE discord_invite_dismissals (
    user_id TEXT PRIMARY KEY REFERENCES users_index(user_id) ON DELETE CASCADE,
    dismissed_at TEXT NOT NULL
);
