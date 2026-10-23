{{! view: ResultNotificationsTemplate }}
{{!
Show timestamps and localized event sentences. Omit notification IDs and delivery codes.
Quote post bodies. A digest keeps refs and timestamps in cells. Known facets stay absent.
Example output:
- Timestamp: 1d0h0m. Alice u/alice upvoted my comment c/abc.
}}
{{#unless events}}
{{#unless omitted}}
{{t "result.notifications.none"}}
{{/unless}}
{{/unless}}
{{#if omitted}}
{{t "result.notifications.omitted" count=omitted}}
{{/if}}
{{#each events}}
{{#unless @first}}

---

{{/unless}}
{{#kind this}}
{{:case notice}}
- {{t "result.timestamp" when=when}}. {{message | text}}
{{:case bootstrap}}
### {{t "result.notifications.bootstrap.heading"}}
{{t "result.timestamp" when=when}}

{{message | quote}}
{{:case thread_post}}
## {{thread}}
{{t "result.timestamp" when=when}}
{{message | text}}

{{> body post}}
{{:case post}}
{{#if heading}}
## {{heading}}
{{/if}}
{{#if message}}
{{message | text}}
{{/if}}
{{#each posts}}
{{#unless @first}}

---
{{/unless}}

{{> comment}}
{{/each}}
{{:case digest}}
### {{message | text}}
| {{t "result.column.item"}} | {{t "result.column.thread"}} | {{t "result.column.when"}} |
|---|---|---|
{{#each activities}}
| {{ref | cell}} | {{#if thread}}{{thread | cell}}{{else}}{{title | cell}}{{/if}} | {{when}} |
{{/each}}
{{#if olderOmitted}}
{{t "result.notifications.digest.older_omitted"}}
{{/if}}
{{#if titlesOmitted}}
{{t "result.notifications.digest.titles_omitted"}}
{{/if}}
{{/kind}}
{{/each}}
