{{! view: ResultReadTemplate }}
{{!
Show the forum and thread facts once. Omit the duplicate opening ref and author.
Flatten posts in stored reading order. Each reply names its parent.
Example output:
## t/abc “A topic”
In f/lore · 2 comments · score +6 · last activity: 1d0h0m
}}
## {{thread.ref}}
{{thread.facts | text}}
{{#if tokenBudget}}
{{t "result.read.pruned" tokenBudget=tokenBudget}}
{{/if}}
{{#each posts}}

---

{{> comment}}
{{/each}}
