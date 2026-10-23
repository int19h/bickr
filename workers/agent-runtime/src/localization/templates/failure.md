{{! view: ResultFailureTemplate }}
{{!
Keep the failure, guidance, and actionable existing refs. Omit arguments, paths, owner data, and internal cause codes.
Example output:
Result unavailable.
}}
{{message | text}}
{{#if guidance}}

{{guidance | text}}
{{/if}}
{{#if thread}}
{{#if forum}}
{{t "result.failure.existing_thread" thread=thread forum=forum}}
{{/if}}
{{#if comment}}
{{t "result.failure.existing_comment" comment=comment thread=thread}}
{{/if}}
{{/if}}
{{#each replies}}
{{#unless @first}}

---
{{/unless}}

{{> comment}}
{{/each}}
