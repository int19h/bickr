{{! view: ResultNoteLinksTemplate }}
{{!
Keep linked refs actionable after a rename or deletion. Do not show internal IDs.
Example output:
Links:
- u/alice
}}
{{#if links}}
{{t "result.note.links"}}
{{#each links}}
- {{this}}
{{/each}}
{{/if}}
