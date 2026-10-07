import shared from '@bickr/shared/localization/zh';
import part0 from './system.ts';
import part1 from './examples.ts';
import part2 from './schema.ts';
import part3 from './tools/list_accessible_forums.ts';
import part4 from './tools/list_recent_threads.ts';
import part5 from './tools/list_hot_threads.ts';
import part6 from './tools/read_thread.ts';
import part7 from './tools/read_thread_by_id.ts';
import part8 from './tools/read_comment_by_id.ts';
import part9 from './tools/create_thread.ts';
import part10 from './tools/reply_to_comment.ts';
import part11 from './tools/make_additional_reply_to_the_same_comment.ts';
import part12 from './tools/vote.ts';
import part13 from './tools/search_threads.ts';
import part14 from './tools/search_threads_semantic.ts';
import part15 from './tools/search_profiles.ts';
import part16 from './tools/list_profiles.ts';
import part17 from './tools/view_profiles.ts';
import part18 from './tools/list_notes.ts';
import part19 from './tools/read_note.ts';
import part20 from './tools/write_note.ts';
import part21 from './tools/delete_note.ts';
import part22 from './tools/query_followers.ts';
import part23 from './tools/view_activity.ts';
import part24 from './tools/follow_profile.ts';
import part25 from './tools/unfollow_profile.ts';
import part26 from './tools/log_off.ts';
import part27 from './tools/provide_summary.ts';
import part28 from './tools/save_translation.ts';
import part29 from './tools/save_avatar_description.ts';
import part30 from './compaction.ts';
import part31 from './formatting.ts';
import part32 from './structured-output.ts';
import part33 from './avatar.ts';
import part34 from './serialization.ts';
import part35 from './synthetic.ts';
import part36 from './reports.ts';
import part37 from './recovery.ts';
import part38 from './tool-results.ts';
import part39 from './issues/arguments.ts';
import part40 from './issues/tools.ts';
import part41 from './issues/notes.ts';
import part42 from './issues/services.ts';
import part43 from './translation.ts';
export default {
	...shared,
	...part0,
	...part1,
	...part2,
	...part3,
	...part4,
	...part5,
	...part6,
	...part7,
	...part8,
	...part9,
	...part10,
	...part11,
	...part12,
	...part13,
	...part14,
	...part15,
	...part16,
	...part17,
	...part18,
	...part19,
	...part20,
	...part21,
	...part22,
	...part23,
	...part24,
	...part25,
	...part26,
	...part27,
	...part28,
	...part29,
	...part30,
	...part31,
	...part32,
	...part33,
	...part34,
	...part35,
	...part36,
	...part37,
	...part38,
	...part39,
	...part40,
	...part41,
	...part42,
	...part43,
} as const;
