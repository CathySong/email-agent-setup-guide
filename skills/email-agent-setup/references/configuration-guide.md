# Email Agent configuration reference

## Recommended domain layout

Keep the root domain's MX records for the human mailbox provider. Put agent sending on `mail.example.com` and inbound replies on `in.example.com`. A useful address pattern is `reply+<thread-id>@in.example.com`, with Message-ID headers as a fallback for thread association.

Typical provider records include:

- Return-Path MX and SPF under a provider-selected sending hostname.
- DKIM public key under `<selector>._domainkey.<sending-domain>`.
- DMARC at `_dmarc.<sending-domain>`, initially monitoring with `p=none`.
- One inbound MX record on the inbound subdomain.

Always use exact values shown by the provider. New provider setups may use CNAME records instead of older MX/TXT patterns. A CNAME cannot coexist with other records at the same hostname.

## DNS checks

Use:

```bash
dig MX example.com +short
dig MX in.example.com +short
dig MX send.mail.example.com +short
dig TXT send.mail.example.com +short
dig TXT selector._domainkey.mail.example.com +short
dig TXT _dmarc.mail.example.com +short
```

Common failures:

- DNS console appends the zone twice: enter only the relative label when required.
- Multiple SPF records produce PermError: merge into one policy.
- SPF exceeds ten DNS lookups: reduce includes or isolate providers by subdomain.
- Long DKIM text is truncated: follow the DNS provider's string-splitting syntax.
- Proxied mail CNAMEs do not resolve correctly: use DNS-only mode.
- A strict root DMARC policy applies to subdomains: add an explicit subdomain record or plan `sp=`.
- DNS changes are tested before TTL expiry.

## Outbound requirements

Persist the provider email ID, internal thread ID, recipient, and idempotency key. A successful API response means accepted for processing, not inbox placement.

Handle:

- 401/403: credential, permission, or unverified domain.
- 422: invalid request.
- 429: exponential backoff.
- delivered: recipient server accepted.
- delayed: provider normally retries.
- bounced: suppress invalid address.
- complained: stop sending immediately.
- suppressed: do not retry.

Use one-click unsubscribe headers for applicable bulk mail. Disable open/click tracking for ordinary one-to-one Agent mail when possible. Warm new domains gradually.

## Inbound webhook contract

A provider normally sends an event containing metadata and an email ID, while the handler fetches the body separately.

The endpoint must:

1. Read the raw body.
2. Verify signature using the provider's signing secret and required headers.
3. Deduplicate with durable storage.
4. Save the raw event for audit.
5. Enqueue processing.
6. Return 2xx immediately.

Do not call the model inside the webhook request. Provider retries plus missing deduplication cause duplicate replies.

## Loop prevention

Do not reply when headers indicate automatic or bulk mail, including `Auto-Submitted` other than `no`, `Precedence: bulk|junk|list`, `List-Id`, or common auto-reply headers. Ignore mailer-daemon, postmaster, noreply, no-reply, and the Agent's own sending domains.

Mark fully automated replies `Auto-Submitted: auto-replied`. Cap replies per thread, for example three per hour and ten per day, and add a global send-volume circuit breaker.

Never forward inbound mail to an address whose MX routes back to the same inbound service.

## Security

Email content is untrusted. Pass it to the model as quoted data and provide a strict tool allowlist. Authentication results can be spoofed inside the message body; rely on provider-computed results or trusted headers.

Do not execute attachments. Enforce size and type limits, malware scanning where available, per-thread context isolation, and human approval for payments, refunds, legal statements, contracts, security changes, or unusual commitments.

## Threading

Use the inbound `message_id`, not the provider's internal email ID:

```text
Subject: Re: <original subject>
In-Reply-To: <incoming message-id>
References: <prior message-ids> <incoming message-id>
Auto-Submitted: auto-replied
```

## Launch checklist

- Root MX remains unchanged.
- Sending SPF/DKIM verify; DMARC includes aggregate reporting.
- Inbound subdomain has only intended MX and provider shows verified.
- Webhook signature, raw-body handling, durable deduplication, queue, and audit log work.
- Auto-mail filters, thread limits, sensitive-intent approval, and global kill switch work.
- Bounce, complaint, suppression, delayed, failed, and received events are monitored.
- Tests cover delivery, bounce, complaint, duplicate webhook, spoofing, loops, and rate limits.
- Applicable consent and anti-spam obligations are documented.
