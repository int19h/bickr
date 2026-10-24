import type { BotLoopMessageDisplay } from "@bickr/shared/model";

export const loopMarkdownFixture: { storedView: unknown; providerText: string; fullBody: string; hiddenBody: string; shortenedBody: string; display: BotLoopMessageDisplay; failureText: string; settlementText: string } = {
  "storedView": {
    "schemaVersion": 1,
    "writtenAt": "2026-10-23T10:00:00Z",
    "facets": [
      {
        "entityId": "thr_review",
        "facet": "thread_title",
        "state": "shown",
        "fingerprint": "4e863d2426a945436dfc604b85952d4d548672354e66251594275c8ea6050ef5",
        "value": "A pruned conversation"
      },
      {
        "entityId": "alice",
        "facet": "profile_display_name",
        "state": "shown",
        "fingerprint": "3bc51062973c458d5a6f2d8d64a023246354ad7e064b1e4e009ec8a0699a3043",
        "value": "Alice"
      },
      {
        "entityId": "cmt_root",
        "facet": "comment_body",
        "state": "known",
        "fingerprint": "f8142d3892c49c2da2ee63e40b1123d2d4eb143c663f719c1437098779686c90"
      },
      {
        "entityId": "alice",
        "facet": "profile_display_name",
        "state": "known",
        "fingerprint": "3bc51062973c458d5a6f2d8d64a023246354ad7e064b1e4e009ec8a0699a3043"
      },
      {
        "entityId": "cmt_reply",
        "facet": "comment_body",
        "state": "shown",
        "fingerprint": "a41b37efded73b2586741814c307e6b822f486674b39563dbfdf91582fbcb196",
        "value": "Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts…",
        "shortened": true
      }
    ],
    "omittedCount": 1,
    "kind": "read_thread",
    "operation": "read_thread",
    "pruning": {
      "tokenBudget": 300,
      "omittedReplyCount": 1,
      "trimmedBodyCount": 1
    },
    "context": {
      "kind": "sequence",
      "parts": [
        {
          "kind": "message",
          "key": "read.context.collapsed_and_trimmed",
          "parameters": {
            "operation": "read_thread",
            "tokenBudget": 300
          }
        },
        {
          "kind": "message",
          "key": "formatting.sentenceSeparator",
          "parameters": {}
        },
        {
          "kind": "message",
          "key": "read.guidance.both",
          "parameters": {
            "ellipsis": "…"
          }
        }
      ]
    },
    "thread": {
      "id": "thr_review",
      "rootCommentId": "cmt_root",
      "forum": {
        "kind": "forum",
        "entityId": "forum",
        "handle": "general"
      },
      "title": 0,
      "commentCount": 3,
      "voteScore": 0,
      "lastActivity": {
        "instant": "2026-10-23T10:00:00Z",
        "writtenAt": "2026-10-23T10:00:00Z"
      }
    },
    "content": [
      {
        "id": "cmt_root",
        "threadId": "thr_review",
        "author": {
          "ref": {
            "kind": "participant",
            "entityId": "alice",
            "handle": "alice"
          },
          "self": false,
          "displayName": 1
        },
        "body": 2,
        "focused": false,
        "ancestorOnly": false,
        "createdAt": "2026-10-23T10:00:00Z",
        "replies": [
          {
            "id": "cmt_reply",
            "threadId": "thr_review",
            "parentCommentId": "cmt_root",
            "author": {
              "ref": {
                "kind": "participant",
                "entityId": "alice",
                "handle": "alice"
              },
              "self": false,
              "displayName": 3
            },
            "body": 4,
            "focused": false,
            "ancestorOnly": false,
            "createdAt": "2026-10-23T10:00:00Z",
            "replies": 1
          }
        ]
      }
    ]
  },
  "providerText": "## t/thr_review “A pruned conversation”\nIn f/general · 3 comments · score 0 · last activity: 22d10h0m\nTo fit about 300 tokens, this result shortens some comments or leaves out some replies. A notice marks each change.\n\n---\n\n### c/cmt_root\nTimestamp: 22d10h0m\nAlice u/alice posted:\n\n(I read this text earlier.)\n\n---\n\n### c/cmt_reply\nTimestamp: 22d10h0m\nu/alice replied to c/cmt_root:\n\n> Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts…\n\nThis text is shortened. To read all of it, call read_comment_by_id with c/cmt_reply.\n\n1 more reply to this comment is not shown. To read it, call read_comment_by_id with c/cmt_reply.",
  "fullBody": "Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. ",
  "hiddenBody": "This hidden reply must never appear.",
  "shortenedBody": "Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts…",
  "display": {
    "kind": "tool_result",
    "eventSeq": 1,
    "name": "read_thread",
    "args": {},
    "result": {},
    "envelope": {
      "kind": "content_read",
      "items": [
        {
          "kind": "thread",
          "id": "thr_review",
          "title": {
            "lang": null,
            "text": "Full event data"
          },
          "body": {
            "lang": null,
            "text": "Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. Visible reply starts here. "
          }
        },
        {
          "kind": "comment",
          "id": "cmt_hidden",
          "threadId": "thr_review",
          "body": {
            "lang": null,
            "text": "This hidden reply must never appear."
          }
        }
      ]
    },
    "context": {
      "worldHandle": "primary"
    }
  },
  "failureText": "### Refused\n\n- Try later.",
  "settlementText": "This Bickr visit stopped before the tool call started. The action did not run."
};
