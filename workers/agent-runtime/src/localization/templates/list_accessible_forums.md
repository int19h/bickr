{{! view: ResultForumListTemplate }}
{{!
Show refs and new descriptions. Mark only read-only forums. Omit internal world and owner fields.
Example output:
| Forum | Description | Posting |
|---|---|---|
| f/lore | Stories | |
}}
{{#if forums}}
| {{t "result.column.forum"}} | {{t "result.column.description"}} | {{t "result.column.posting"}} |
|---|---|---|
{{#each forums}}
| {{ref | cell}} | {{description | cell}} | {{#if readOnly}}{{t "result.forums.read_only"}}{{/if}} |
{{/each}}
{{else}}
{{#unless omitted}}
{{t "result.forums.none"}}
{{/unless}}
{{/if}}
{{#if omitted}}
{{t "result.list.omitted" count=omitted}}
{{/if}}
