# Crobot master baseline (for the Analytics V2 packages)

Measured by session c25b049f (CA) on 2026-10-16, in a clean detached worktree of
**master `19f6e8c72700a4aae61c699f062495dd23f1816a`** (`~/projects/crobot/.worktrees/cabase`, own `composer install`).

**Crobot gate from now on:** no new failing tests and no new phpstan errors versus this baseline.

## TL;DR

| | Count | Notes |
|---|---|---|
| Tests | 705 run, **68 failing** with the stock `.env` (35 errors, 33 failures, 2 skipped) | **61** genuine on master; **7** caused by `.env` leaks (recipe below) |
| phpstan (level 6) | **810 errors** = 809 file errors + 1 "ignored pattern not matched" | `phpstan-baseline.neon` is **not used anywhere**: `phpstan.neon` has no `includes:`. The same holds on master, so this isn't a worktree issue. |
| `npm run build` | green | chunk-size warnings only |

Result is deterministic: identical failing set across 3 runs (shared DB, isolated DB, and run concurrently with another suite).

## ⚠️ Correction to PRD §10a / CLAUDE.md: tests do NOT use SQLite

`phpunit.xml` sets `DB_CONNECTION=mysql`, `DB_DATABASE=test_crobot` (on `crb-mysql`). Every worktree shares that one DB by default. Parallel packages running `RefreshDatabase` suites at the same time will clobber each other.
(The dev DB `laravel` is not touched.)

**Recipe (per package):** an isolated test DB, passed via env (phpunit's `<env>` does not override a real env var):
```bash
# once, root creds come from the container env
docker exec crb-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "CREATE DATABASE IF NOT EXISTS test_crobot_<pkg>; GRANT ALL PRIVILEGES ON test_crobot_<pkg>.* TO \`app\`@\`%\`;"'
# every run
docker exec -u www-data -e HOME=/tmp -e XDEBUG_MODE=off -e DB_DATABASE=test_crobot_<pkg> -w /var/www/html/.worktrees/<pkg> crb-php bash -lc '...'
```
Existing: `test_crobot_cb` (CB), `test_crobot_ca` (CA), `test_crobot_base` (this baseline).

## Env-caused failures (7) and fix recipe

`.env` (copied into each worktree) is loaded under phpunit. Its local-dev `CRO_AUDIT_*` values override the config defaults the tests assume:
`CRO_AUDIT_PRICE_CENTS=6500` (tests expect default 4900), `CRO_AUDIT_PRICE_CURRENCY=eur`, `CRO_AUDIT_V2=true`, `CRO_AUDIT_DAILY_WEBSITE_CAP=0`, `CRO_AUDIT_ENABLED=true`.

**Fix (env only, no code change):** add to the docker exec
`-e CRO_AUDIT_PRICE_CENTS=4900 -e CRO_AUDIT_PRICE_CURRENCY=usd -e CRO_AUDIT_V2=false -e CRO_AUDIT_DAILY_WEBSITE_CAP=10 -e CRO_AUDIT_ENABLED=false`
→ 61 failing, 0 new. Don't use a minimal `.env.testing`: 3 Google SSO tests then fail for lack of `GOOGLE_*` values.

These 7 pass with the recipe:
```
Tests\Feature\Domain\Audit\Http\AuditResultControllerTest::testCreateCheckoutChargesFullPriceForControlLandingLead
Tests\Feature\Domain\Audit\Http\AuditResultControllerTest::testCreateCheckoutReturnsSessionUrlForLockedAudit
Tests\Feature\Domain\Audit\Http\AuditResultControllerTest::testGenerateRoadmapAllowsRegenerationFromReady
Tests\Feature\Domain\Audit\Http\AuditResultControllerTest::testGenerateRoadmapHappyPath
Tests\Feature\Domain\Audit\Http\AuditResultControllerTest::testGenerateRoadmapMapsUpstreamErrorsTo502
Tests\Feature\Marketing\MarketingLeadAuditTest::testAuditQuizWithWebsiteReturnsAuditHashAndCreatesWorkflow
Tests\Feature\Marketing\MarketingLeadAuditTest::testEleventhDistinctWebsiteFromSameIpReturnsTooManyRequests
```

## Worktree-setup gotchas (not test failures, but they break the gate)

1. A fresh worktree lacks the git-ignored `bootstrap/cache` and `storage/framework/*`, so `composer install` dies in `package:discover`. Fix: `mkdir -p bootstrap/cache storage/framework/{cache/data,sessions,views,testing} storage/app/public storage/logs` before `composer install`.
2. Never symlink or copy `vendor/` from another worktree. Composer's autoload resolves `app/` to the *source* worktree, so you silently test the wrong code. Run `composer install` in each worktree (fast from cache).
3. Docker Desktop mount desync: if a path is created or deleted on the host and then touched from the container (or vice versa) in quick succession, the container can see a stale state ("vendor does not exist and could not be created"). Create `vendor/` / `node_modules/` from inside the container only.
4. Use `-e HOME=/tmp` (composer/npm cache) and `-e XDEBUG_MODE=off` (removes the Xdebug connect noise and speeds up runs).

## Genuinely failing on master (61), same with any env

Causes by group (from the error text; none fixed, all outside the Analytics V2 paths):
- `InvitationTest` (21), `BulkUpdateExperimentStatusTest` (11): `projects.version_id` FK violation. The tests create projects without seeding `versions`.
- `RegexUrlConsistencyTest` (14): API returns 400 (`CreateExperimentAdapter` needs a `rules` key) and script-resource escaping mismatch.
- `BillingAddressTest` (6): routes return 404.
- Audit / CRO-audit (`AuditResultControllerTest` 1, `AuditPresenterTest`, `DispatchAuditPurchasedEventTest`, `SendAuditPurchasedEventJobTest` 3, `RequestAuditAnalysisJobTest`): stale expectations (Klaviyo template `Purchase` vs `audit_purchased`, payload keys, agent args).
- `HandleStripeSubscriptionUpdatedTest` (1): quota 100 vs 1000.
- `Unit\LeadServiceTest` (1): writes `projects.user_id`, which no longer exists.

```
Tests\Feature\BillingAddressTest::it_allows_null_email
Tests\Feature\BillingAddressTest::it_can_create_billing_address_with_email
Tests\Feature\BillingAddressTest::it_can_retrieve_billing_address
Tests\Feature\BillingAddressTest::it_can_update_billing_address_email
Tests\Feature\BillingAddressTest::it_returns_error_when_no_billing_address
Tests\Feature\BillingAddressTest::it_validates_email_format
Tests\Feature\BulkUpdateExperimentStatusTest::test_can_bulk_update_multiple_experiments_to_active
Tests\Feature\BulkUpdateExperimentStatusTest::test_can_bulk_update_multiple_experiments_to_inactive
Tests\Feature\BulkUpdateExperimentStatusTest::test_cannot_update_archived_experiments
Tests\Feature\BulkUpdateExperimentStatusTest::test_handles_mix_of_valid_and_invalid_experiments
Tests\Feature\BulkUpdateExperimentStatusTest::test_only_updates_experiments_belonging_to_user_client
Tests\Feature\BulkUpdateExperimentStatusTest::test_requires_authentication
Tests\Feature\BulkUpdateExperimentStatusTest::test_validates_identifiers_array_must_not_be_empty
Tests\Feature\BulkUpdateExperimentStatusTest::test_validates_identifiers_must_be_array
Tests\Feature\BulkUpdateExperimentStatusTest::test_validates_identifiers_must_contain_integers
Tests\Feature\BulkUpdateExperimentStatusTest::test_validates_required_fields
Tests\Feature\BulkUpdateExperimentStatusTest::test_validates_status_must_be_valid_enum_value
Tests\Feature\Domain\Account\Jobs\HandleStripeSubscriptionUpdatedTest::test_updates_quota_immediately_on_upgrade
Tests\Feature\Domain\Audit\Http\AuditResultControllerTest::testGenerateRoadmapReturns402WhenLocked
Tests\Feature\Domain\Audit\Listeners\DispatchAuditPurchasedEventTest::testDispatchesKlaviyoEventWithExpectedFields
Tests\Feature\Domain\Workflow\CroAudit\RequestAuditAnalysisJobTest::testHandleTransitionsToAnalysisCompletedOnSuccess
Tests\Feature\Domain\Workflow\CroAudit\SendAuditPurchasedEventJobTest::testDegradesGracefullyWhenRoadmapReportMissing
Tests\Feature\Domain\Workflow\CroAudit\SendAuditPurchasedEventJobTest::testIgnoresMalformedCompetitorEntries
Tests\Feature\Domain\Workflow\CroAudit\SendAuditPurchasedEventJobTest::testSendsPurchasedEventWithCompetitorsObjectiveAndWebsite
Tests\Feature\InvitationTest::test_can_create_invitation_with_projects
Tests\Feature\InvitationTest::test_can_create_invitation_with_single_project
Tests\Feature\InvitationTest::test_can_create_invitation_without_projects
Tests\Feature\InvitationTest::test_can_filter_invitations_by_project_id
Tests\Feature\InvitationTest::test_can_list_all_invitations
Tests\Feature\InvitationTest::test_does_not_list_expired_invitations
Tests\Feature\InvitationTest::test_does_not_list_used_invitations
Tests\Feature\InvitationTest::test_filter_by_project_returns_empty_when_no_invitations_match
Tests\Feature\InvitationTest::test_ignores_invalid_project_ids
Tests\Feature\InvitationTest::test_invitation_response_includes_project_details
Tests\Feature\InvitationTest::test_requires_authentication_to_create_invitation
Tests\Feature\InvitationTest::test_requires_authentication_to_list_invitations
Tests\Feature\InvitationTest::test_updating_existing_invitation_replaces_projects
Tests\Feature\InvitationTest::test_validates_email_format
Tests\Feature\InvitationTest::test_validates_email_is_required
Tests\Feature\InvitationTest::test_validates_email_must_be_unique
Tests\Feature\InvitationTest::test_validates_project_ids_must_be_array
Tests\Feature\InvitationTest::test_validates_project_ids_must_be_integers
Tests\Feature\InvitationTest::test_validates_project_ids_must_exist
Tests\Feature\InvitationTest::test_validates_role_is_required
Tests\Feature\InvitationTest::test_validates_role_must_be_valid
Tests\Feature\RegexUrlConsistencyTest::goal_action_regex_survives_create_and_read
Tests\Feature\RegexUrlConsistencyTest::regex_url_in_generated_script_matches_db_value with data set "character class"
Tests\Feature\RegexUrlConsistencyTest::regex_url_in_generated_script_matches_db_value with data set "complex pattern"
Tests\Feature\RegexUrlConsistencyTest::regex_url_in_generated_script_matches_db_value with data set "double backslash"
Tests\Feature\RegexUrlConsistencyTest::regex_url_in_generated_script_matches_db_value with data set "escaped dot"
Tests\Feature\RegexUrlConsistencyTest::regex_url_in_generated_script_matches_db_value with data set "escaped forward slash"
Tests\Feature\RegexUrlConsistencyTest::regex_url_in_generated_script_matches_db_value with data set "escaped question mark"
Tests\Feature\RegexUrlConsistencyTest::regex_url_survives_full_create_read_update_cycle with data set "character class"
Tests\Feature\RegexUrlConsistencyTest::regex_url_survives_full_create_read_update_cycle with data set "complex pattern"
Tests\Feature\RegexUrlConsistencyTest::regex_url_survives_full_create_read_update_cycle with data set "double backslash"
Tests\Feature\RegexUrlConsistencyTest::regex_url_survives_full_create_read_update_cycle with data set "escaped dot"
Tests\Feature\RegexUrlConsistencyTest::regex_url_survives_full_create_read_update_cycle with data set "escaped forward slash"
Tests\Feature\RegexUrlConsistencyTest::regex_url_survives_full_create_read_update_cycle with data set "escaped question mark"
Tests\Feature\RegexUrlConsistencyTest::regex_url_survives_full_create_read_update_cycle with data set "no backslashes"
Tests\Unit\Domain\Audit\Http\Controllers\AuditPresenterTest::testPayloadKeysMatchContract
Unit\LeadServiceTest::testLeadCreate
```

## phpstan detail

- 810 errors on master, the same in a worktree. `phpstan-baseline.neon` (9 entries, last touched in 869fec0) is not referenced by `phpstan.neon`, so it never applies anywhere.
- Compare as a multiset of `(file, message)` from `--error-format=raw` (line numbers shift when you edit a file, so ignore them):
```bash
vendor/bin/phpstan analyse --no-progress --error-format=raw > /tmp/<pkg>-phpstan.txt
python3 -c 'import re,collections,sys
ms=lambda f:collections.Counter((m[1],m[2]) for l in open(f) if (m:=re.match(r"/var/www/html/.worktrees/[^/]+/(.+?):\d+:(.*)",l.strip())))
print(ms(sys.argv[2])-ms(sys.argv[1]))' /tmp/ca-base-phpstan.txt /tmp/<pkg>-phpstan.txt   # must print Counter()
```
- Raw baseline output is in the `crb-php` container at `/tmp/ca-base-phpstan.txt`; the junit baselines are at `/tmp/base2-junit.xml` (stock env) and `/tmp/base3-junit.xml` (with the env recipe). These are container `/tmp` files and vanish on container restart.

## Commands used

```bash
cd ~/projects/crobot && git worktree add --detach .worktrees/cabase 19f6e8c && cp .worktrees/ca/.env .worktrees/cabase/
docker exec -u www-data -e HOME=/tmp -e XDEBUG_MODE=off -w /var/www/html/.worktrees/cabase crb-php bash -lc \
  'mkdir -p bootstrap/cache storage/framework/{cache/data,sessions,views,testing} storage/logs && composer install -q'
# tests (stock env → 68; add the CRO_AUDIT_* -e flags → 61)
docker exec -u www-data -e HOME=/tmp -e XDEBUG_MODE=off -e DB_DATABASE=test_crobot_base -w /var/www/html/.worktrees/cabase crb-php \
  bash -lc 'php -d memory_limit=-1 vendor/bin/phpunit --log-junit /tmp/base2-junit.xml'
# phpstan
docker exec -u www-data -e HOME=/tmp -e XDEBUG_MODE=off -w /var/www/html/.worktrees/cabase crb-php \
  bash -lc 'php -d memory_limit=-1 vendor/bin/phpstan analyse --no-progress --error-format=raw > /tmp/ca-base-phpstan.txt'
# failing-set diff: parse <testcase> with <failure>/<error> from both junit files, compare sets
```
The main checkout was not touched (it's on `staging`, not master). The `cabase` worktree is kept for re-baselining. Remove it with `git worktree remove .worktrees/cabase`.
