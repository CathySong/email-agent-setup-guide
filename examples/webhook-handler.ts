/**
 * 邮件 Agent 入站 webhook 示例（Resend + Express）
 *
 * 要点：
 *  1. 校验签名（svix-id / svix-timestamp / svix-signature）
 *  2. 按 svix-id 去重
 *  3. 先入队、立即返回 2xx，不要在请求里调用 LLM
 *  4. 处理时先做防循环过滤，再交给 Agent
 *
 * 依赖：npm i express resend svix
 * 环境变量：RESEND_API_KEY, RESEND_WEBHOOK_SECRET
 *
 * 注意：示例里的 Set 和 setImmediate 只是演示。生产环境请换成
 * 数据库或 Redis 去重，以及真正的任务队列（SQS、BullMQ 等）。
 */
import express from 'express';
import { Resend } from 'resend';
import { Webhook } from 'svix';

const resend = new Resend(process.env.RESEND_API_KEY);
const app = express();

const OWN_DOMAINS = ['mail.example.com', 'in.example.com'];
const seen = new Set<string>(); // 演示用；生产环境换成持久化存储

app.post('/webhooks/email', express.raw({ type: 'application/json' }), (req, res) => {
  const headers = {
    'svix-id': req.header('svix-id') ?? '',
    'svix-timestamp': req.header('svix-timestamp') ?? '',
    'svix-signature': req.header('svix-signature') ?? '',
  };

  // 1. 校验签名
  let event: any;
  try {
    event = new Webhook(process.env.RESEND_WEBHOOK_SECRET!).verify(req.body.toString(), headers);
  } catch {
    return res.status(400).send('invalid signature');
  }

  // 2. 去重：同一事件重试时 svix-id 不变
  if (seen.has(headers['svix-id'])) return res.sendStatus(200);
  seen.add(headers['svix-id']);

  // 3. 先入队、立即返回
  setImmediate(() => handleEvent(event).catch((err) => console.error('handleEvent failed', err)));
  res.sendStatus(200);
});

async function handleEvent(event: any) {
  switch (event.type) {
    case 'email.received':
      return handleInbound(event.data);
    case 'email.bounced':
    case 'email.complained':
    case 'email.suppressed':
      return markContactUnsendable(event.data, event.type);
    default:
      return; // 其他事件只记录
  }
}

async function handleInbound(meta: { email_id: string; message_id: string; from: string; to: string[]; subject: string }) {
  // webhook 只带元数据，正文要另外取
  const { data: email, error } = await resend.emails.receiving.get(meta.email_id);
  if (error || !email) throw new Error(`fetch failed: ${error?.message}`);

  const h = (name: string) => readHeader(email, name);
  const from = meta.from.toLowerCase();

  // 4. 防循环过滤
  const autoSubmitted = h('auto-submitted');
  const precedence = h('precedence');
  const isAuto =
    (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') ||
    /^(bulk|junk|list)$/i.test(precedence ?? '') ||
    !!h('list-id') ||
    !!h('x-autoreply') ||
    !!h('x-autorespond');
  const isSystem = /(mailer-daemon|postmaster|no-?reply)@/.test(from);
  const isSelf = OWN_DOMAINS.some((d) => from.endsWith(`@${d}>`) || from.endsWith(`@${d}`));
  if (isAuto || isSystem || isSelf) {
    return log('skipped automated or self mail', meta);
  }

  // 识别会话：优先用 reply+<threadId>@in.example.com，其次用 In-Reply-To
  const threadId =
    meta.to.map((addr) => addr.match(/reply\+([A-Za-z0-9_-]+)@/)?.[1]).find(Boolean) ??
    (await findThreadByMessageId(h('in-reply-to')));

  if (!threadId) return routeToHuman(meta, 'unknown thread');
  if (!(await withinRateLimit(threadId))) return routeToHuman(meta, 'thread rate limit');

  // 邮件正文是外部输入：只作为数据交给模型，不当作指令
  const body = (email as any).text ?? '';
  const decision = await agentDecide({ threadId, subject: meta.subject, body });

  if (decision.kind === 'unsubscribe') return unsubscribe(from);
  if (decision.kind === 'needs_human') return routeToHuman(meta, decision.reason);

  const thread = await loadThread(threadId);
  await resend.emails.send(
    {
      from: 'Acme Assistant <agent@mail.example.com>',
      to: [meta.from],
      replyTo: `reply+${threadId}@in.example.com`,
      subject: /^re:/i.test(meta.subject) ? meta.subject : `Re: ${meta.subject}`,
      text: decision.reply,
      headers: {
        'In-Reply-To': meta.message_id,
        References: [...thread.messageIds, meta.message_id].join(' '),
        'Auto-Submitted': 'auto-replied',
      },
    },
    { idempotencyKey: `reply-${meta.email_id}` },
  );
}

/** 兼容邮件头以对象或数组两种形式返回 */
function readHeader(email: any, name: string): string | undefined {
  const headers = email?.headers;
  if (!headers) return undefined;
  const key = name.toLowerCase();
  if (Array.isArray(headers)) {
    return headers.find((x: any) => String(x.name ?? x.key).toLowerCase() === key)?.value;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === key) return Array.isArray(v) ? String(v[0]) : String(v);
  }
  return undefined;
}

// ---- 以下函数需按你的系统实现 ----
declare function findThreadByMessageId(messageId?: string): Promise<string | undefined>;
declare function withinRateLimit(threadId: string): Promise<boolean>;
declare function agentDecide(input: { threadId: string; subject: string; body: string }): Promise<
  | { kind: 'reply'; reply: string }
  | { kind: 'unsubscribe' }
  | { kind: 'needs_human'; reason: string }
>;
declare function loadThread(threadId: string): Promise<{ messageIds: string[] }>;
declare function routeToHuman(meta: unknown, reason: string): Promise<void>;
declare function unsubscribe(address: string): Promise<void>;
declare function markContactUnsendable(data: unknown, reason: string): Promise<void>;
declare function log(message: string, meta: unknown): void;

app.listen(3000);
