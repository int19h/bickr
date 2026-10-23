{{! view: ResultBatchTemplate }}
{{!
Keep delivery order and render nested typed results. Never insert raw result objects.
Example output:
- Not attempted for u/alice:
Result unavailable.
}}
{{#each items}}
{{#if heading}}
- {{heading | text}}
{{/if}}
{{message | text}}
{{#if guidance}}
{{guidance | text}}
{{/if}}
{{/each}}

{{guidance | text}}
