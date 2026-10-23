{{! view: ResultBodyTemplate }}
{{!
Quote all post bodies. A known body needs an explanation. No internal fields reach this partial.
Example output:
> A post.
}}
{{#kind body}}
{{:case shown}}
{{body.value | quote}}
{{#if body.trimmed}}
{{t "result.comment.trimmed" ref=ref}}
{{/if}}
{{:case known}}
{{t "result.comment.seen_earlier"}}
{{:case absent}}
{{/kind}}
