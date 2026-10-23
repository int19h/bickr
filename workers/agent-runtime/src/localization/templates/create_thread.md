{{! view: ResultCreateTemplate }}
{{!
Show the forum and the opening post ref when it is available. Omit ok and internal IDs.
Example output:
I started the thread t/abc in f/lore. Its opening post is c/abc.
}}
{{#if post}}
{{t "result.create_thread.done" thread=thread forum=forum post=post}}
{{else}}
{{t "result.create_thread.without_post" thread=thread forum=forum}}
{{/if}}
