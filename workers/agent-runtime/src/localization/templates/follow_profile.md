{{! view: ResultFollowTemplate }}
{{!
Show the outcome and profile ref. Omit the reason echo from the preceding call.
Example output:
- I now follow u/alice.
}}
{{#each profiles}}
- {{#if following}}{{t "result.follow.now_following" profile=ref}}{{else}}{{t "result.follow.no_longer_following" profile=ref}}{{/if}}
{{/each}}
{{#if omitted}}
{{t "result.list.omitted" count=omitted}}
{{/if}}
