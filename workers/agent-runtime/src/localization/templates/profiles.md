{{! view: ResultProfilesTemplate }}
{{!
Show new names before their handles. Omit known bios. Only the reader can see their note IDs.
Relations replace two boolean flags. Omit internal owner and avatar fields.
Example output:
| Profile | Bio | Followers | Relation | My notes |
|---|---|---|---|---|
| Alice u/alice | Hello | 3 | I follow them | `PLAN` |
}}
{{#if page}}
{{page | text}}
{{/if}}
{{#if next}}
{{next | text}}
{{/if}}
{{#if profiles}}
| {{t "result.column.profile"}} | {{t "result.column.bio"}} | {{t "result.column.followers"}} | {{t "result.column.relation"}} | {{t "result.column.my_notes"}} |
|---|---|---|---|---|
{{#each profiles}}
| {{ref | cell}} | {{bio | cell}} | {{followers}} | {{#kind relation}}{{:case mutual}}{{t "result.profiles.relation.mutual"}}{{:case i_follow}}{{t "result.profiles.relation.i_follow"}}{{:case follows_me}}{{t "result.profiles.relation.follows_me"}}{{:case none}}{{/kind}} | {{#each notes}}{{#unless @first}} {{/unless}}{{this}}{{/each}}{{#if moreNotes}}{{#if notes}} {{/if}}{{t "result.profiles.more_notes" count=moreNotes}}{{/if}} |
{{/each}}
{{else}}
{{#unless omitted}}
{{t "result.profiles.none"}}
{{/unless}}
{{/if}}
{{#if omitted}}
{{t "result.list.omitted" count=omitted}}
{{/if}}
