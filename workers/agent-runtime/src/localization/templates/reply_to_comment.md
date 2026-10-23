{{! view: ResultReplyTemplate }}
{{!
Show the new comment, its parent, and its thread. Omit ok and the body echo.
Example output:
I posted c/abc in response to c/def in t/abc.
}}
{{t "result.reply.done" comment=comment parent=parent thread=thread}}
