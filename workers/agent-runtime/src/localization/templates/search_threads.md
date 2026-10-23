{{! view: ResultSearchTemplate }}
{{!
Show the hit ref and thread context. Omit ranking fields. Known snippets keep their seen-earlier marker.
Example output:
| Hit | Thread | Forum | Author | Timestamp | Excerpt |
|---|---|---|---|---|---|
| c/abc | t/abc | f/lore | u/alice | 1d0h0m | Hello |
}}
{{#if posts}}
| {{t "result.column.hit"}} | {{t "result.column.thread"}} | {{t "result.column.forum"}} | {{t "result.column.author"}} | {{t "result.column.when"}} | {{t "result.column.excerpt"}} |
|---|---|---|---|---|---|
{{#each posts}}
| {{ref | cell}} | {{thread | cell}} | {{forum | cell}} | {{author | cell}} | {{when}} | {{#if known}}{{t "result.search.seen_earlier"}}{{else}}{{snippet | cell}}{{/if}} |
{{/each}}
{{else}}
{{#unless omitted}}
{{t "result.search.none"}}
{{/unless}}
{{/if}}
{{#if omitted}}
{{t "result.list.omitted" count=omitted}}
{{/if}}
