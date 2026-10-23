{{! view: ResultFollowersTemplate }}
{{!
Show the query direction, total, and handles. Omit internal profile IDs.
Example output:
u/alice has 1 follower. Here are 1:
- u/bob
}}
{{#kind direction}}
{{:case followers}}
{{t "result.followers.followers" profile=profile total=total shown=shown}}
{{:case following}}
{{t "result.followers.following" profile=profile total=total shown=shown}}
{{/kind}}
{{#each participants}}
- {{this}}
{{/each}}
{{#if omitted}}
{{t "result.list.omitted" count=omitted}}
{{/if}}
