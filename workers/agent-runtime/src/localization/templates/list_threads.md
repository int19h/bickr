{{! view: ResultThreadListTemplate }}
{{!
Omit opening-post refs. Show new titles and names once. Counts include the lock reason.
Forum cells stay empty when the call already names the forum.
Example output:
| Thread | Title | Author | Comments | Score | Last activity |
|---|---|---|---|---|---|
| t/abc | A topic | Alice u/alice | 200 (locked: limit) | +6 | 1d0h0m |
}}
{{#if threads}}
| {{t "result.column.thread"}} | {{t "result.column.title"}} | {{t "result.column.author"}} | {{t "result.column.comments"}} | {{t "result.column.score"}} | {{t "result.column.last_activity"}} |{{#if includeForum}} {{t "result.column.forum"}} |{{/if}}
|---|---|---|---|---|---|{{#if includeForum}}---|{{/if}}
{{#each threads}}
| {{ref | cell}} | {{title | cell}} | {{author | cell}} | {{#if lockedComments}}{{lockedComments | text}}{{else}}{{comments}}{{/if}} | {{score}} | {{lastActivity}} |{{#if listForum}} {{listForum | cell}} |{{/if}}
{{/each}}
{{else}}
{{t "result.threads.none"}}
{{/if}}
{{#if omitted}}
{{t "result.list.omitted" count=omitted}}
{{/if}}
