/**
 * admin-v2 goal library (CONTRACT "Goal library"): list shape, add,
 * duplicate_rule, rule change mints a new code, delete retires the code, and
 * the 30-goal cap (409 library_full). The cap check fills the library and then
 * deletes its fillers again, so it runs last among the library checks.
 */

import { type CheckDef, Diff, fail } from '../../lib/check.ts';
import { type HttpResponse, field } from '../../lib/http.ts';
import { api, dataOf, projectPath, str } from './support.ts';

const OWNER = 'admin-v2 Library';
const CAP = 30;
const ITEM_KEYS = [
  'code',
  'title',
  'type',
  'action',
  'match_type',
  'in_library',
  'used_in',
  'created_at',
].sort();

const goalsPath = (ctx: Parameters<CheckDef['run']>[0], rest = ''): string =>
  projectPath(ctx, `/goals${rest}`);

async function addGoal(
  ctx: Parameters<CheckDef['run']>[0],
  body: Record<string, unknown>,
): Promise<HttpResponse> {
  return api(ctx, 'POST', goalsPath(ctx), body);
}

const codeOf = (res: HttpResponse): string => String(field(dataOf(res), 'code') ?? '');

const listCodes = (res: HttpResponse): string[] =>
  ((field(res.json, 'data') ?? []) as Record<string, unknown>[]).map((g) => String(g.code));

export const adminV2LibraryChecks: readonly CheckDef[] = [
  {
    id: 'admin-v2.library.list-add',
    layer: 'admin-v2',
    title: 'GET /projects/{uuid}/goals {data[],cap:30,count}; POST → 201 with a fresh G code',
    owner: OWNER,
    dod: ['admin-v2 CONTRACT Goal library'],
    needs: ['infra.crobot-db'],
    async run(ctx) {
      const before = await api(ctx, 'GET', goalsPath(ctx));
      const added = await addGoal(ctx, {
        title: 'AV2 pricing page',
        type: 'page_view',
        action: '/pricing',
        match_type: 'exact',
      });
      const after = await api(ctx, 'GET', goalsPath(ctx));
      const code = codeOf(added);
      const item = ((field(after.json, 'data') ?? []) as Record<string, unknown>[]).find(
        (g) => g.code === code,
      );
      const all = await api(ctx, 'GET', goalsPath(ctx, '?scope=all'));
      ctx.facts.set('admin-v2.library.code', code);
      return new Diff()
        .eq('GET status', 200, before.status)
        .eq('cap', CAP, field(before.json, 'cap'))
        .eq('POST status', 201, added.status)
        .truthy('code is G<n>', /^G\d+$/.test(code), `got ${code}`)
        .eq('count +1', Number(field(before.json, 'count')) + 1, field(after.json, 'count'))
        .eq('item keys', ITEM_KEYS, item ? Object.keys(item).sort() : null)
        .eq(
          'item',
          {
            title: 'AV2 pricing page',
            type: 'page_view',
            action: '/pricing',
            match_type: 'exact',
            in_library: true,
            used_in: 0,
          },
          item
            ? {
                title: item.title,
                type: item.type,
                action: item.action,
                match_type: item.match_type,
                in_library: item.in_library,
                used_in: item.used_in,
              }
            : null,
        )
        .eq('scope=all status', 200, all.status)
        .outcome(`added ${code}; count ${str(field(after.json, 'count'))}`);
    },
  },
  {
    id: 'admin-v2.library.duplicate',
    layer: 'admin-v2',
    title: 'POST the same rule again (whitespace differs) → 409 duplicate_rule + existing code',
    owner: OWNER,
    dod: ['admin-v2 CONTRACT Goal library 409 duplicate_rule'],
    needs: ['admin-v2.library.list-add'],
    async run(ctx) {
      const code = String(ctx.facts.get('admin-v2.library.code'));
      const res = await addGoal(ctx, {
        title: 'Pricing again',
        type: 'page_view',
        action: ' /pricing ',
        match_type: 'exact',
      });
      return new Diff()
        .eq(
          'response',
          { status: 409, error: 'duplicate_rule', code },
          { status: res.status, error: field(res.json, 'error'), code: field(res.json, 'code') },
        )
        .outcome(`409 duplicate_rule → ${code}`);
    },
  },
  {
    id: 'admin-v2.library.rule-change',
    layer: 'admin-v2',
    title: 'PATCH rename keeps the code; PATCH rule change → new code, replaces = old code',
    owner: OWNER,
    dod: ['admin-v2 CONTRACT PATCH /goals/{code}', 'decision: rule change = new code'],
    needs: ['admin-v2.library.list-add'],
    async run(ctx) {
      const code = String(ctx.facts.get('admin-v2.library.code'));
      const renamed = await api(ctx, 'PATCH', goalsPath(ctx, `/${code}`), {
        title: 'AV2 pricing (renamed)',
      });
      const changed = await api(ctx, 'PATCH', goalsPath(ctx, `/${code}`), {
        action: '/pricing/',
        match_type: 'starts_with',
      });
      const newCode = codeOf(changed);
      const lst = await api(ctx, 'GET', goalsPath(ctx));
      ctx.facts.set('admin-v2.library.changed-code', newCode);
      return new Diff()
        .eq(
          'rename',
          { status: 200, code, title: 'AV2 pricing (renamed)' },
          { status: renamed.status, code: codeOf(renamed), title: field(dataOf(renamed), 'title') },
        )
        .eq('rule change status', 200, changed.status)
        .eq('replaces', code, field(changed.json, 'replaces'))
        .truthy('new code differs', /^G\d+$/.test(newCode) && newCode !== code, `got ${newCode}`)
        .eq(
          'new rule',
          { action: '/pricing/', match_type: 'starts_with', title: 'AV2 pricing (renamed)' },
          {
            action: field(dataOf(changed), 'action'),
            match_type: field(dataOf(changed), 'match_type'),
            title: field(dataOf(changed), 'title'),
          },
        )
        .truthy(
          'library lists the new code, not the old',
          listCodes(lst).includes(newCode) && !listCodes(lst).includes(code),
          str(listCodes(lst)),
        )
        .outcome(`${code} → ${newCode}`);
    },
  },
  {
    id: 'admin-v2.library.delete-retires',
    layer: 'admin-v2',
    title:
      'DELETE → 204; gone from scope=all; PATCH/DELETE 404; re-adding the rule gets a NEW code',
    owner: OWNER,
    dod: ['admin-v2 CONTRACT DELETE /goals/{code}', 'codes never reused'],
    needs: ['admin-v2.library.rule-change'],
    async run(ctx) {
      const code = String(ctx.facts.get('admin-v2.library.changed-code'));
      const del = await api(ctx, 'DELETE', goalsPath(ctx, `/${code}`));
      const all = await api(ctx, 'GET', goalsPath(ctx, '?scope=all'));
      const patch = await api(ctx, 'PATCH', goalsPath(ctx, `/${code}`), { title: 'x' });
      const again = await api(ctx, 'DELETE', goalsPath(ctx, `/${code}`));
      const readd = await addGoal(ctx, {
        title: 'AV2 pricing back',
        type: 'page_view',
        action: '/pricing/',
        match_type: 'starts_with',
      });
      const readdCode = codeOf(readd);
      if (readd.status === 201) await api(ctx, 'DELETE', goalsPath(ctx, `/${readdCode}`));
      return new Diff()
        .eq('DELETE', 204, del.status)
        .truthy('not in scope=all', !listCodes(all).includes(code), str(listCodes(all)))
        .eq('PATCH deleted', 404, patch.status)
        .eq('DELETE again', 404, again.status)
        .eq('re-add status', 201, readd.status)
        .truthy(
          're-added rule gets a new code',
          readdCode !== code && /^G\d+$/.test(readdCode),
          `deleted ${code}, re-added as ${readdCode}`,
        )
        .outcome(`${code} retired; same rule re-added as ${readdCode}`);
    },
  },
  {
    id: 'admin-v2.library.cap',
    layer: 'admin-v2',
    title:
      'fill the library to 30 → next POST 409 library_full {cap:30,count:30}; fillers deleted after',
    owner: OWNER,
    dod: ['admin-v2 CONTRACT 409 library_full', 'decision 7'],
    needs: ['admin-v2.library.list-add'],
    async run(ctx) {
      const start = Number(field((await api(ctx, 'GET', goalsPath(ctx))).json, 'count'));
      if (!(start < CAP))
        return fail(`library already holds ${start} goals; cannot test the cap from below`);
      const fillers: string[] = [];
      try {
        for (let i = start; i < CAP; i++) {
          const res = await addGoal(ctx, {
            title: `AV2 filler ${i}`,
            type: 'custom',
            action: `av2_filler_${i}`,
          });
          if (res.status !== 201)
            return fail(`filler ${i} → ${res.status}: ${res.text.slice(0, 200)}`);
          fillers.push(codeOf(res));
        }
        const full = await addGoal(ctx, {
          title: 'AV2 one too many',
          type: 'click',
          action: '.av2-too-many',
        });
        return new Diff()
          .eq(
            '31st add',
            { status: 409, error: 'library_full', cap: CAP, count: CAP },
            {
              status: full.status,
              error: field(full.json, 'error'),
              cap: field(dataOf(full), 'cap'),
              count: field(dataOf(full), 'count'),
            },
          )
          .outcome(`409 library_full at ${CAP} (${fillers.length} fillers)`);
      } finally {
        for (const code of fillers) await api(ctx, 'DELETE', goalsPath(ctx, `/${code}`));
      }
    },
  },
];
