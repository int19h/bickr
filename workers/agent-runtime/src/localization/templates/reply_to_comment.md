{{! view: ResultReplyTemplate }}
{{!
Show the new comment, its known parent, and its thread. Omit ok and the body echo.
Example output:
I posted c/abc in response to c/def in t/abc.
}}
{{#if parent}}
{{t "result.reply.done" comment=comment parent=parent thread=thread}}
{{else}}
{{t "result.reply.without_parent" comment=comment thread=thread}}
{{/if}}
