{{! view: ResultPostTemplate }}
{{!
Show the ref and timestamp in the heading, then the focus marker if present.
Show the author and parent on the next line so that each post stands alone.
The thread heading supplies the title. Known names stay absent.
Example output:
### c/abc [timestamp: 1d0h0m]
I posted:

> Hello.
}}
### {{ref}} {{t "result.comment.timestamp_tag" when=when}}{{#if focused}} {{t "result.comment.focus_marker"}}{{/if}}
{{#if parent}}
{{t "result.comment.reply" author=author parent=parent}}
{{else}}
{{t "result.comment.opening" author=author}}
{{/if}}

{{> body}}
{{#if hiddenReplies}}

{{t "result.comment.hidden_replies" count=hiddenReplies ref=ref}}
{{/if}}
{{#if ancestorOnly}}

{{t "result.comment.ancestor_only"}}
{{/if}}
