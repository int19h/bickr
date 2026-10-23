{{! view: ResultBodyTemplate }}
{{!
Quote all post bodies. A known body needs an explanation. No internal fields reach this partial.
A blank line separates every notice from the quote. Without it, Markdown continues the quote into the notice.
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
