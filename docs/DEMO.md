# Demo video script (about 8 minutes)

Record at 1080p, browser zoom 110%, two windows side by side where noted (left: dashboard, right: terminal / Claude Code). Have `.demo/credentials.txt` open off-screen. Run `make up && make demo` beforehand, and have the LLM key set.

| # | Time | Show | Say |
|---|---|---|---|
| 1 | 0:00 | The architecture diagram from the README | "A WooCommerce store, a WooCommerce MCP server I wrote, and a gateway that is the only door. Every tool, every person, one endpoint, one audit trail." |
| 2 | 0:30 | `kubectl get pods -A`, then `helm list` | "One Helm chart, two namespaces. Local is k3d, the same chart runs on my k3s VPS." |
| 3 | 1:00 | Storefront: add *Filter coffee powder*, check out (cash on delivery) | "I'm placing an order as a customer." |
| 4 | 1:40 | Dashboard as **admin** → Assistant: "What orders came in today?" Expand the tool-call card | "The assistant acts as me. You can see the exact tool call, its arguments and the result." Ask: "Mark that order as completed." Switch to wp-admin to show the status changed |
| 5 | 2:50 | Servers page | "Four servers, live status, tools per server. `fx/search` and `tickets/search` both exist: names are prefixed, so nothing collides." |
| 6 | 3:20 | Terminal: Claude Code with the **member** key → list tools → "show today's orders" → "mark order N as shipped" | "The member sees read-only tools only. The write tool isn't even listed." |
| 7 | 4:10 | Admin → Servers → woo → Tools → set `update_order_status` for Members to *Always allow* → repeat step 6 in Claude Code | "One click, no restart, no new key. The next call works." |
| 8 | 4:50 | Member → API keys → Revoke; repeat a call in Claude Code (401); admin → Audit log filtered by member | "Revocation is immediate, and the rejected attempt is recorded against the right person." |
| 9 | 5:30 | `kubectl -n platform scale deploy/fx-mcp --replicas=0`; refresh Servers (Unreachable + reason); call a woo tool in the assistant (fast) | "A dead server doesn't slow or break the rest. The dashboard says why it's down." Scale back up; it recovers |
| 10 | 6:20 | Add server → `evil-mcp` URL + token (`make evil-token`) → show the quarantined tool and the reasons | "This server is malicious on purpose. Its description tries to make the model exfiltrate customer emails. It's caught and held until I approve that exact version, and if a server changes its mind later, the change is caught too." |
| 11 | 7:10 | `make verify` | "And these claims aren't just words: here are 12 checks against the live cluster." |
| 12 | 7:40 | `docs/STAND-OUTS.md` | "Beyond the brief: tool permissions, supply-chain defences, hardened cluster, VPS deploy with upgrade and rollback, metrics, and a search-then-call mode for large tool sets." |

Tips: keep the audit log open in a second tab to cut to it after each action; if the LLM is slow, trim the pause in editing rather than re-recording.
