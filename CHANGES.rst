v19.6.1
=======

* Fixed: the Docker image now deploys on Runlayer Deploy - the runtime stage is named
  (``build.target: runtime`` is required for multi-stage Dockerfiles) and the image has no
  ``ENTRYPOINT`` (Runlayer starts an init helper from the same image with ``sh -c``, which a
  binary entrypoint swallowed and left the server never starting). Run the CLI from the image
  as ``docker run <image> okta-cli users list``
* ``runlayer.yaml.example`` ships ``OKTA_MCP_INCLUDE`` on by default; README explains why a
  hosted connector should trim the ~780-tool catalog
* ``runlayer.yaml`` is gitignored (tenant-specific)

v19.6.0
=======

* New: ``okta-cli mcp`` exposes every CLI command as an MCP tool (spec 2025-11-25) - a
  streamable HTTP server (``mcp serve``) and a stdio transport (``mcp stdio``); the tool
  catalog is generated from the command tree at startup, one tool per leaf command
  (``users_list``, ``governance_entitlement_bundles_get``, ...), and each call runs through
  the same ``runCli`` path as the command line (auth, pagination, ``--json`` formatting,
  error mapping)
* ``mcp tools`` lists the generated catalog; ``--include``/``--exclude`` globs (also
  ``OKTA_MCP_INCLUDE``/``OKTA_MCP_EXCLUDE``) filter it by tool name
* ``--read-only``/``OKTA_MCP_READ_ONLY=1`` restricts the served catalog to read-only tools and
  independently refuses every non-``GET`` request at the Okta client, regardless of which tool
  was invoked
* ``FILE:`` body prefixes and other local-file options are rejected in MCP mode
* New multi-stage ``Dockerfile`` (compiled binary, non-root, defaults to ``mcp serve``) and
  ``runlayer.yaml.example`` for deploying the server to Runlayer Deploy

v19.5.0
=======

* New: ``governance``/``gov`` command group covering the Okta Identity Governance (OIG) API
  (``/governance/api/v1`` and ``/governance/api/v2``): campaigns + reviews; entitlements,
  entitlement values, entitlement bundles, grants; principal access/entitlements/settings;
  collections (+ assignments, catalog users, resources); labels, resource labels, resource
  owners; request types and access requests (v1 + v2, plus the request catalog); resource
  request conditions/sequences/settings, entitlement settings, revoke principal access;
  tasks; security access reviews; org governance settings, integrations, risk rules;
  delegates, teams, operations
* ``--limit`` on governance list commands is a client-side cap; the CLI never sends a
  ``limit`` query parameter (per-endpoint server maxima differ, and some endpoints reject it
  outright)
* ``-f/--filter`` is a required option (no default) on the 11 governance operations that 400
  without it
* End-user ``/my/**`` governance paths are intentionally out of scope

v19.4.0
=======

* New: OAuth 2.0 service-app authentication (client credentials, ``private_key_jwt``,
  optional DPoP) as an alternative to an SSWS API token - ``config new --client-id
  --private-key-file --scopes`` creates an OAuth profile; ``config test`` checks that the
  current profile (config file or ``OKTA_*`` env override) can authenticate
* New: ``OKTA_CLIENT_ID``/``OKTA_PRIVATE_KEY``/``OKTA_PRIVATE_KEY_FILE``/``OKTA_SCOPES``/
  ``OKTA_KID``/``OKTA_DPOP`` environment overrides, alongside the existing
  ``OKTA_URL``/``OKTA_TOKEN`` pair; OAuth access tokens are cached on disk next to the config
  file (``OKTA_CLI_NO_TOKEN_CACHE=1`` to disable)

v19.3.0
=======

* New: apps credentials/claims/provisioning: jwks, secrets, csrs (+ certificate publish),
  keys/key-clone, federated-claims, group-push mappings, connection (+ jwks/lifecycle),
  cwo-connections, interclient-allowed/-targets, logo upload, assign-policy, feature-set
* New: users credential and factor flows: change-password, forgot-password,
  change-recovery-question, expire-password-temp, factor-enroll/-activate/-verify/-resend/
  -transaction, factors-questions, authenticator-enrollments (+ phone/tac enrollment), risk,
  classification, client-tokens, idp-tokens, webauthn-enrollment-delete
* New: admin role targets and governance for users/groups/oauth-clients (role-targets,
  role-target-add/-delete, role-governance, role-targets-all), resource-set bindings and
  binding members, resource-set resources, role/user subscriptions
* New: idps keys/csrs/signing-keys (+ clone/generate), authenticators methods/aaguids/
  verify-rp-id, auth-servers associated servers/resource keys/rule lifecycle, domains
  certificate, org yubikeys, log-streams schemas, telephony-providers, devices os-accounts,
  policies mapping/mapping-delete, identity-sources group management
* Changed: oauth-clients role-targets now prints ``{ groups, apps }`` (was a group table);
  role-target-add/-delete accept ``--app-name``/``--app-id``

v19.2.0
=======

* New: brands (+ domains, themes/theme-logo/theme-favicon/theme-background, email templates
  and customizations, sign-in/error/sign-out pages, well-known URIs)
* New: security-events-providers, ssf (streams + status + verification), security-events send,
  threats, bot-protection, attack-protection (authenticator/lockout settings), push-providers,
  device-integrations, device-posture-checks, email-servers, dr (status/failover/failback)
* New: agent-pools (+ updates, update-settings), identity-sources (+ sessions, bulk-*,
  user/group single-item gets, group-members), oauth-clients (role assignments + targets),
  roles governance-bundles/opt-in/opt-out, ui-schemas, first-party-app get/set, org
  preferences/footer/third-party-admin/communication/aerial/support-cases/email-bounces-remove/
  admin-app-assignment/client-privileges, directories
* New: pam (service-accounts, okta-service-accounts), oin (api-services), well-known
  (org/webauthn/ssf/app-authenticator/apple-app-site-association/assetlinks),
  personal-settings, webauthn-registration (+ users webauthn-enrollments)
* New: `OktaClient.upload` for multipart uploads (theme logo/favicon/background); `raw
  --base-path` still covers any endpoint outside these, including a few paths the pinned
  spec (2026.08.4) declares with no HTTP operations (PAM resources/containers, OIN
  submissions)

v19.1.0
=======

* New: auth-servers (+ scopes, claims, policies/rules, clients/tokens, keys/rotate-keys)
* New: devices (+ suspend/unsuspend, users), device-assurances, users devices
* New: mappings (+ update, properties), email-domains (+ verify, dns), behaviors, sms-templates,
  realms, realm-assignments, captchas, rate-limits (settings, per-client, principals)
* New: groups owners, apps grants/tokens/keys/generate-key/features/saml-metadata,
  users clients/grants/subscriptions, roles permissions/subscriptions/resource-set-bindings/resource-set-resources

v19.0.0
=======

* Rewrite in TypeScript on Bun; single-binary releases; Python no longer required
* Drop-in compatible command surface with 18.1.2 (see README "Compatibility notes" for 4 bug fixes)
* New: logs, tokens, roles (+ users/groups role assignment), org, trusted-origins, domains, zones, log-streams
* New: inlinehooks, hook-keys, schemas (user/group/app, add/remove custom properties), linked-objects, groups rules, user-types
* New: policies (+ rules, mappings, clone), authenticators, sessions, idps, users factors/blocks/sessions-revoke/unsuspend/idps
* New: users update --from-json, users replace, users profile, users schema-check
* New: OKTA_CLI_CONFIG, OKTA_URL/OKTA_TOKEN environment overrides
* Types generated from Okta management OpenAPI spec 2026.08.4

v18.1.2
=======

* Update docs of README.md, no code changes.

v18.1.1
=======

* Internally switch to src/ file layout
* Fix broken installation script from 18.1.0

v18.1.0
=======

* Add "users bulk-add" command
* Add progress bars to "bulk-*" commands
* Fix #21 (1) - "config delete" doesn't dump any more on wrong config name
* Fix #21 (2) - "config list" shows the default now

v18.0.5
=======

* merge a patch which corrects a typo in the CLI help
* INTERNAL: switch to pyproject.toml project management
* INTERNAL: pin dependency versions now

v18.0.4
=======

* update installation docs, also for pypi

v18.0.3
=======

* add missing "six" dependency

v18.0.2
=======

* also build source distribution for pypi
* update my email :)
* internal "build system" fixes

v18.0.1
=======

* fix missing dotted library in published pypi lib (thanks to @sanitybit for pointing it out)

v18.0.0
=======

* Require Python >= 3.7 (mainly because of responses package)
* Inline dotted library, make compatible with Python 3.10
  (original library is no longer maintained it seems)

v17.3.1
=======

* make 'https://' mandatory for Okta URLs
* fix 'config COMMAND' crashes on wrongly or unconfigured default contexts

v17.3.0
=======

* add command 'groups apps' (PR by bousquf)
* add command 'user reactivate' (PR by josephbreihan)

v17.2.0
=======

* add parameter "-A" (array update) for "users update"

v17.1.0
=======

* Added logging basics. use "-vvvvv" for detailed http dumps

v17.0.0
=======

* [BREAKING] check for 'id' before profile.login when mass-updating profiles. enables update-possibility of the login field
  * Thanks @techjutsu-mikeb

v16.0.0
=======

* [BREAKING] expire passwords from 'pw set' by default
* update cli help texts
* print more error information on okta API errors

v15.1.0
=======

* fix commands 'user pw {reset,expire}'
* update text output of 'apps users'
* add command 'apps groups'
* add command 'apps removegroup'
* add command 'apps addgroup'
* add nicer error handling and output, especially for okta api errors
* add user STATUS field to default output for "users {get,list}"
* fix broken fuzzy lookup

v15.0.0
=======

* unify behavior of 'users groups'
* add command 'users apps'
* add command 'features list'
* add command 'features enable'
* add command 'features disable'
* add command 'features dependents'
* add command 'features dependencies'
* add "--colwidth" parameter to table output
* use sorted output now for functions returning lists
* various output changes
* various fixes, some breaking functionality

v14.3.0
=======

* add command 'users activate'

v14.2.1
=======

* remove debug output

v14.2.0
=======

* perform case-insensitive user searches for 'users list'
* update 'users list', add "-q", "-d" parameters

v14.1.0
=======

* (MINOR) adjust (and enhance) 'groups list' command to behave like 'apps list', specifically in regards to the partial name filtering
* unify case-insensitive filtering

v14.0.1
=======

* fix several internal bugs which broke 'pw reset', 'pw expire' and 'users add'

v14.0.0
=======

* [BREAKING] update 'apps list' command
* add command 'apps get'

v13.0.0
=======

* [BREAKING] update 'raw' command

v12.0.0
=======

* [BREAKING] update 'apps users' semantics to match the rest of the commands
* add command 'apps adduser'
* add command 'apps getuser'
* add command 'apps removeuser'

v11.4.1
=======

* fixed that 'groups delete' would find non-"OKTA_GROUP" groups

v11.4.0
=======

* internal code cleanup
* change and unify text output of a couple of methods
* probably removed some bugs

v11.3.0
=======

* same as 11.1.0

v11.2.0
=======

* same as 11.1.0

v11.1.0
=======

* 'apps list' - add '-m' parameter to match a specific field
* 'apps list' - add '-q' parameter to pass query parameter to okta API
* fix ugly bug breaking a bunch of methods
* fix 'groups adduser' output
* fix 'users add' command
* fix some docs

v11.0.0
=======

* many commands are now "smart" and filter things (groups, apps) by name and users by field

v10.0.1
=======

* fix help output for 'groups adduser' (PR from @dhutty-numo, thanks)

v10.0.0
=======

* change and clarify 'users add' semantics (docs & help, remove read from csv file)

v9.0.1
======

* internal updates

v9.0.0
======

* 'users get' - removed -i parameter
* 'users get' - make it work with any profile field

v8.0.0
======

* 'groups list' - will now only print OKTA_GROUPs, unless -a is specified
* 'groups list' - output is now sorted
* 'groups get' - parameter '-i' removed

v7.7.0
======

* add apps {add,activate,deactivate,delete} commands

v7.6.0
======

* add group {add,delete} commands

v7.5.0
======

* make 'dump' include DEPROVISIONED users
* update cli help texts
* fix 'okta-cli version'

v7.4.0
======

* add command "config delete" (delete a config)
* add command "config file" (print location of config file)
* move default profile check to where it's needed, fix a bug by doing this

v7.3.1
======

* fix inclusion of word file database

v7.3.0
======

* add "pw set -g" and "pw set -p" commands. "-g" auto-generated a password based on word lists

v7.2.1
======

* make "users list" a bit faster

v7.2.0
======

* add 'dump' command which dumps users, and apps / groups with their users
* internal cleanups

v7.1.0
======

* parallelize user bulk-update calls to be much faster

v7.0.2
======

* (invisible) some internal updates
* bulk-update prints final number of upd. users at the end

v7.0.1
======

* (invisible) update internal communications path for querying okta

v7.0.0
======

* write output of bulk-update to log files instead of stdout

v6.0.0
======

* rename "users update-csv" to "users bulk-update"

v5.2.0
======

* add excel file reading for 'users update-csv'

v5.1.0
======

* add 'groups removeuser' command
* add 'users groups' command

v5.0.1
======

* add missing changes docs for 5.0.0 (everything below is 5.0.0)
* add 'groups adduser' command
* remove filter expression convenience optimizer (major bump)
* various internal fixes

v4.0.1
======

* fix bug in CSV output (was "" for all nested fields, e.g. "profile.login")

v4.0.0
======

* add CSV output
* rename --text-fields parameter to --output-fields

v3.0.1
======

* internal change in handling "--json/--text-fields" parameters
* fix missing import (which shouldn't be there)

3.0.0
======

* add table output to some commands and make it default
* fix wrongly named "--yaml" parameter (now "--json")
* add command 'users unlock'
* fix bug in tabular output for non-existing / unfilled fields

v2.3.1
======

* make -h work everywhere
* fix users delete / deactivate commands

v2.3.0
======

* add 'groups users' command
* add 'groups clear' command

v2.2.0
======

* add 'users get' command (lists ONE user by login or Okta ID)
* add 'users deactivate' command
* add 'users suspend' command
* add 'users delete' command
* add 'pw expire' command which expires a password of a user

v2.1.0
======

* add 'users update-csv' command
* add 'groups list' command
* add 'apps list' command
* add 'apps users' command

v2.0.0
======

* 'users update' can now update all fields, including security question and
  password (BREAKING CHANGE)
* add 'pw reset' command

v1.0.2
======

* update quickstart docs (did still say "pip install" would not work,
  it does now :)

v2.3.1
======

* make -h work everywhere
* fix users delete / deactivate commands

v2.3.0
======

* add 'groups users' command
* add 'groups clear' command

v2.2.0
======

* add 'users get' command (lists ONE user by login or Okta ID)
* add 'users deactivate' command
* add 'users suspend' command
* add 'users delete' command
* add 'pw expire' command which expires a password of a user

v2.1.0
======

* add 'users update-csv' command
* add 'groups list' command
* add 'apps list' command
* add 'apps users' command

v2.0.0
======

* 'users update' can now update all fields, including security question and
  password (BREAKING CHANGE)
* add 'pw reset' command

v1.0.2
======

* update quickstart docs (did still say "pip install" would not work,
  it does now :)

v1.0.1
======

* add help texts in setup.py
