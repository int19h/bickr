{{! view: ResultListNotesTemplate }}
{{!
Keep note IDs and the next cursor in code spans. The cursor sentence replaces nextCursor.
Example output:
1 of 1 note:
- `PLAN`
}}
{{#if ids}}
{{t "result.notes.listed" shown=shown total=total}}
{{#each ids}}
- {{this}}
{{/each}}
{{else}}
{{t "result.notes.none"}}
{{/if}}
{{#if cursor}}
{{t "result.notes.next_cursor" cursor=cursor}}
{{/if}}
{{#if unknownFilters}}
{{t "result.notes.unknown_filters"}}
{{#each unknownFilters}}
- {{this | line}}
{{/each}}
{{/if}}
{{#if omitted}}
{{t "result.list.omitted" count=omitted}}
{{/if}}
