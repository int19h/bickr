{{! view: ResultPostTemplate }}
{{!
Show the ref, timestamp, author, and parent so that each post stands alone.
The thread heading supplies the title. Known names stay absent.
Example output:
### c/abc
Timestamp: 1d0h0m
I posted:

> Hello.
}}
### {{ref}}{{#if focused}} {{t "result.comment.focus_marker"}}{{/if}}
{{t "result.timestamp" when=when}}
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
