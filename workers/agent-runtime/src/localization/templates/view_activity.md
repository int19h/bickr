{{! view: ResultActivityTemplate }}
{{!
Keep feed order and timestamps. Put previews and public reasons on one quoted line.
Omit internal activity IDs and attribution.
Example output:
Recent activity of u/alice:
- Timestamp: 1d0h0m. started to follow u/bob.
}}
{{t "result.activity.heading" profile=profile}}
{{#if activities}}
{{#each activities}}
- {{t "result.timestamp" when=when}}. {{message | text}}{{#if preview}} {{preview | line}}{{/if}}{{#if reason}} {{t "result.activity.reason"}} {{reason | line}}{{/if}}
{{#if parentPreview}}
  - {{t "result.activity.parent_preview"}} {{parentPreview | line}}
{{/if}}
{{#if targetPreview}}
  - {{#if targetAuthor}}{{t "result.activity.target_preview" author=targetAuthor}}{{/if}} {{targetPreview | line}}
{{/if}}
{{/each}}
{{else}}
{{#unless omitted}}
{{t "result.activity.none"}}
{{/unless}}
{{/if}}
{{#if omitted}}
{{t "result.list.omitted" count=omitted}}
{{/if}}
