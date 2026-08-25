/**
 * A DELIBERATELY SLOW config endpoint, so the anti-flicker shield is something
 * you can actually watch.
 *
 * The shield's whole job is invisible when it works: the page is hidden from
 * before first paint until the variant is applied, and with an inline config
 * that window is a couple of milliseconds. Point the SDK at this route instead
 * (`pnpm dev:slow`) and the same window becomes 2 seconds — you see the page
 * held blank, then the variant, and never the control.
 *
 * It serves the demo's own config, so this stays zero-infra: same shape crobot
 * publishes, same URL contract as the real config API
 * (`{host}/api/v1/config/{projectId}`) — the SDK can't tell the difference.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { DEMO_DELAY_MS, demoConfig } from '../../../../testa.config.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  // `?delay=` overrides the env default, so you can try 5s without a restart.
  const requested = Number(req.query.delay);
  const delayMs = Number.isFinite(requested) && requested >= 0 ? requested : DEMO_DELAY_MS;
  await sleep(delayMs);
  // No caching — every reload should pay the delay, that's the point.
  res.setHeader('cache-control', 'no-store');
  res.status(200).json(demoConfig);
}
