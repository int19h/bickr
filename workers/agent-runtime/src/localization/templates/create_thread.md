{{! view: ResultCreateTemplate }}
{{!
Show the forum and opening post ref for later actions. Omit ok and internal IDs.
Example output:
I started the thread t/abc in f/lore. Its opening post is c/abc.
}}
{{t "result.create_thread.done" thread=thread forum=forum post=post}}
