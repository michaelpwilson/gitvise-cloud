import { Hono } from 'hono';
import type { AppEnv } from '../app-env';
import { readJson } from '../http';
import { enqueueFlow, enqueueJob, parseFlowTree } from '../queues/api-jobs';
import { invalid, objectBody, optionalIntField, stringField } from './validate';

/**
 * `/internal/queues/send` and `/internal/queues/flow`: how apps/api enqueues work the gateway delivers back to it.
 *
 *   POST /internal/queues/send   { queue, jobName, jobId?, data, delayMs?, attempts? } -> 202 { id } | 409
 *   POST /internal/queues/flow   a CiFlowNode tree                                      -> 202 { id } | 409
 *
 * 409 means the jobId was already submitted, so the caller's duplicate handling applies. BullMQ's `priority` and
 * `backoff` options have no Cloudflare Queues equivalent, and are ignored here. Retries use the consumer's policy.
 */

const QUEUE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;

export const queueRoutes = new Hono<AppEnv>();

queueRoutes.post('/queues/send', async (c) => {
  const body = objectBody(await readJson<unknown>(c.req.raw));
  const queue = stringField(body['queue'], 'queue', 128);
  if (!QUEUE_NAME.test(queue)) throw invalid('queue names are lowercase letters, digits, and dashes');
  const outcome = await enqueueJob(c.env, {
    queue,
    jobName: stringField(body['jobName'], 'jobName', 128),
    jobId: body['jobId'] === undefined ? undefined : stringField(body['jobId'], 'jobId', 256),
    data: body['data'],
    delayMs: optionalIntField(body['delayMs'], 'delayMs', 0, Number.MAX_SAFE_INTEGER),
    attempts: optionalIntField(body['attempts'], 'attempts', 1, 100),
  });
  if (!outcome.created) {
    return c.json({ code: 'CONFLICT', message: `job ${outcome.id} already exists` }, 409);
  }
  return c.json({ id: outcome.id }, 202);
});

queueRoutes.post('/queues/flow', async (c) => {
  const root = parseFlowTree(await readJson<unknown>(c.req.raw));
  const outcome = await enqueueFlow(c.env, root);
  if (!outcome.created) {
    return c.json({ code: 'CONFLICT', message: `flow ${outcome.id} already exists` }, 409);
  }
  return c.json({ id: outcome.id }, 202);
});

