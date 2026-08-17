import { decodeCrossDomain } from '@testa-soft/experiment-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CROSS_DOMAIN_PARAM,
  type CrossDomainExperiment,
  applyInboundCrossDomain,
  eligibleCrossDomainExperiments,
  encodeCrossDomainData,
  installCrossDomainLinkTagging,
  isDifferentDomain,
  tagUrl,
} from '../cross-domain.ts';

// The encode/decode WIRE FORMAT is tested in experiment-core (shared with the
// middleware). Here we test the pixel's browser-side pieces: tagging, eligibility,
// inbound apply, link scanning.
const HERE = 'https://shop.example.com/product';

describe('isDifferentDomain', () => {
  it('is true for another host, false for same host and relative links', () => {
    expect(isDifferentDomain('https://other.com/x', HERE)).toBe(true);
    expect(isDifferentDomain('https://shop.example.com/y', HERE)).toBe(false);
    expect(isDifferentDomain('/relative', HERE)).toBe(false);
  });

  it('is false on unparseable input', () => {
    expect(isDifferentDomain('::::', HERE)).toBe(false);
  });
});

describe('tagUrl', () => {
  const exps: CrossDomainExperiment[] = [{ experimentId: 5, variationId: 2 }];

  it('adds _testa_cd to a cross-domain URL', () => {
    const out = tagUrl('https://other.com/landing', HERE, exps, 'uuid-1');
    const param = new URL(out).searchParams.get(CROSS_DOMAIN_PARAM);
    expect(param).not.toBeNull();
    expect(decodeCrossDomain(param as string)).toEqual({
      uuid: 'uuid-1',
      assignments: [{ experimentId: 5, variationId: 2 }],
    });
  });

  it('leaves same-domain URLs untouched', () => {
    expect(tagUrl('https://shop.example.com/x', HERE, exps, 'uuid-1')).toBe(
      'https://shop.example.com/x',
    );
  });

  it('is a no-op with no experiments or no uuid', () => {
    expect(tagUrl('https://other.com/x', HERE, [], 'uuid-1')).toBe('https://other.com/x');
    expect(tagUrl('https://other.com/x', HERE, exps, '')).toBe('https://other.com/x');
  });
});

describe('eligibleCrossDomainExperiments', () => {
  const experiments = [
    { experiment_id: 1, cross_domain: true },
    { experiment_id: 2, cross_domain: true },
    { experiment_id: 3, cross_domain: false },
    { experiment_id: 4 },
  ];

  it('keeps only flagged, assigned, in-session experiments', () => {
    const assignments: Record<number, number | null> = { 1: 9, 2: 8, 3: 7, 4: 6 };
    const sessions: Record<number, boolean> = { 1: true, 2: false, 3: true, 4: true };
    const out = eligibleCrossDomainExperiments(experiments, {
      getAssignment: (id) => assignments[id as number] ?? null,
      isSessionActive: (id) => sessions[id as number] ?? false,
    });
    expect(out).toEqual([{ experimentId: 1, variationId: 9 }]);
  });

  it('excludes flagged experiments with no assignment', () => {
    const out = eligibleCrossDomainExperiments([{ experiment_id: 1, cross_domain: true }], {
      getAssignment: () => null,
      isSessionActive: () => true,
    });
    expect(out).toEqual([]);
  });
});

describe('applyInboundCrossDomain', () => {
  it('applies each carried assignment and returns the cleaned URL', () => {
    const encoded = encodeCrossDomainData(
      [
        { experimentId: 1, variationId: 4 },
        { experimentId: 2, variationId: 5 },
      ],
      'uuid-in',
    );
    const setAssignment = vi.fn();
    const bumpSession = vi.fn();
    const onUuid = vi.fn();

    const result = applyInboundCrossDomain(
      { search: `?utm=1&${CROSS_DOMAIN_PARAM}=${encoded}`, pathname: '/land', hash: '#a' },
      { setAssignment, bumpSession, onUuid },
    );

    expect(result.applied).toBe(2);
    expect(onUuid).toHaveBeenCalledWith('uuid-in');
    expect(setAssignment).toHaveBeenCalledWith(1, 4);
    expect(setAssignment).toHaveBeenCalledWith(2, 5);
    expect(bumpSession).toHaveBeenCalledWith(1);
    expect(bumpSession).toHaveBeenCalledWith(2);
    // param stripped, other params preserved
    expect(result.cleanedUrl).toBe('/land?utm=1#a');
  });

  it('is a no-op when the param is absent', () => {
    const setAssignment = vi.fn();
    const result = applyInboundCrossDomain(
      { search: '?foo=bar', pathname: '/p', hash: '' },
      { setAssignment, bumpSession: vi.fn(), onUuid: vi.fn() },
    );
    expect(result).toEqual({ applied: 0, cleanedUrl: null });
    expect(setAssignment).not.toHaveBeenCalled();
  });

  it('strips a malformed param without applying anything', () => {
    const setAssignment = vi.fn();
    const result = applyInboundCrossDomain(
      { search: `?${CROSS_DOMAIN_PARAM}=%%%garbage%%%`, pathname: '/p', hash: '' },
      { setAssignment, bumpSession: vi.fn(), onUuid: vi.fn() },
    );
    expect(result.applied).toBe(0);
    expect(result.cleanedUrl).toBe('/p');
    expect(setAssignment).not.toHaveBeenCalled();
  });

  it('skips entries whose variation id is not numeric', () => {
    const encoded = encodeCrossDomainData([{ experimentId: 1, variationId: 'not-a-number' }], 'u');
    const setAssignment = vi.fn();
    const result = applyInboundCrossDomain(
      { search: `?${CROSS_DOMAIN_PARAM}=${encoded}`, pathname: '/p', hash: '' },
      { setAssignment, bumpSession: vi.fn(), onUuid: vi.fn() },
    );
    expect(result.applied).toBe(0);
    expect(setAssignment).not.toHaveBeenCalled();
  });
});

describe('installCrossDomainLinkTagging', () => {
  let teardown: (() => void) | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });

  afterEach(() => {
    teardown?.();
    teardown = null;
    vi.useRealTimers();
  });

  const eligible = (): CrossDomainExperiment[] => [{ experimentId: 5, variationId: 2 }];

  it('tags a cross-domain link on click', () => {
    document.body.innerHTML = '<a id="ext" href="https://other.com/landing">go</a>';
    teardown = installCrossDomainLinkTagging({
      doc: document,
      eligible,
      getUuid: () => 'uuid-1',
      currentHref: () => 'https://shop.example.com/product',
    });

    const link = document.getElementById('ext') as HTMLAnchorElement;
    link.dispatchEvent(new Event('click', { bubbles: true }));

    const param = new URL(link.href).searchParams.get(CROSS_DOMAIN_PARAM);
    expect(decodeCrossDomain(param as string)).toEqual({
      uuid: 'uuid-1',
      assignments: [{ experimentId: 5, variationId: 2 }],
    });
  });

  it('does not tag same-domain, anchor, or mailto links', () => {
    document.body.innerHTML = `
      <a id="same" href="https://shop.example.com/other">a</a>
      <a id="anchor" href="#foo">b</a>
      <a id="mail" href="mailto:x@y.com">c</a>`;
    teardown = installCrossDomainLinkTagging({
      doc: document,
      eligible,
      getUuid: () => 'uuid-1',
      currentHref: () => 'https://shop.example.com/product',
    });

    for (const id of ['same', 'anchor', 'mail']) {
      const link = document.getElementById(id) as HTMLAnchorElement;
      link.dispatchEvent(new Event('click', { bubbles: true }));
      expect(link.href).not.toContain(CROSS_DOMAIN_PARAM);
    }
  });

  it('picks up links added after install via the scan interval', () => {
    teardown = installCrossDomainLinkTagging({
      doc: document,
      eligible,
      getUuid: () => 'uuid-1',
      currentHref: () => 'https://shop.example.com/product',
      intervalMs: 1000,
    });

    document.body.innerHTML = '<a id="late" href="https://other.com/late">go</a>';
    vi.advanceTimersByTime(1000);

    const link = document.getElementById('late') as HTMLAnchorElement;
    link.dispatchEvent(new Event('click', { bubbles: true }));
    expect(link.href).toContain(CROSS_DOMAIN_PARAM);
  });

  it('stops scanning after teardown', () => {
    const eligibleSpy = vi.fn(eligible);
    teardown = installCrossDomainLinkTagging({
      doc: document,
      eligible: eligibleSpy,
      getUuid: () => 'uuid-1',
      currentHref: () => 'https://shop.example.com/product',
      intervalMs: 1000,
    });
    const callsAtInstall = eligibleSpy.mock.calls.length;
    teardown();
    teardown = null;
    vi.advanceTimersByTime(5000);
    expect(eligibleSpy.mock.calls.length).toBe(callsAtInstall);
  });

  it('does nothing when there are no eligible experiments', () => {
    document.body.innerHTML = '<a id="ext" href="https://other.com/landing">go</a>';
    teardown = installCrossDomainLinkTagging({
      doc: document,
      eligible: () => [],
      getUuid: () => 'uuid-1',
      currentHref: () => 'https://shop.example.com/product',
    });
    const link = document.getElementById('ext') as HTMLAnchorElement;
    link.dispatchEvent(new Event('click', { bubbles: true }));
    expect(link.href).not.toContain(CROSS_DOMAIN_PARAM);
  });
});
