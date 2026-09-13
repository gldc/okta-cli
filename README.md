# Okta-CLI

This is a CLI tool for Okta, written in TypeScript and run on [Bun](https://bun.sh).
**It is not made or maintained by or in any way affiliated with anyone working at Okta.**

It is a CLI wrapper around the [Okta REST API](https://developer.okta.com/docs/reference/).

**NOTE:** This is _not_ the same as Okta's own [`okta`](https://cli.okta.com/) CLI interface.
The latter is apparently used for setting up the source for development projects.

Starting with 19.0.0 this is a full rewrite of the previous Python tool (see
[CHANGES.rst](CHANGES.rst)). The command surface is drop-in compatible with 18.1.2, plus a
large set of new command groups (see Quickstart below). Python is no longer required.

## Installation

### Release binaries

Prebuilt single-file binaries (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`) are
published for every tagged version on the
[GitHub Releases](https://github.com/gldc/okta-cli/releases) page:

```bash
# macOS (Apple silicon); swap the target for darwin-x64, linux-x64 or linux-arm64
curl -fsSL -o okta-cli https://github.com/gldc/okta-cli/releases/latest/download/okta-cli-bun-darwin-arm64
chmod +x okta-cli && sudo mv okta-cli /usr/local/bin/
okta-cli version
```

### Via Bun

```bash
bun install -g github:gldc/okta-cli
okta-cli config new
```

or run without installing:

```bash
bunx github:gldc/okta-cli config new
```

## Quickstart

Every more complex function should have help texts available: `okta-cli users add -h`, or
maybe `okta-cli users update -h` or maybe `okta-cli apps add -h` ... those are probably the
most interesting ones.

```bash
$ okta-cli config new \                               # create a new okta profile
           -n my-profile \
           -u https://my.okta.url \
           -t API_TOKEN

$ okta-cli -h                                         # get help

$ okta-cli apps -h                                    # get help
$ okta-cli apps adduser \                             # assign an app to a user
           -a my_app_name -u 0109121 \
           -f profile.employeeId

$ okta-cli users -h                                   # get help
$ okta-cli users list --csv                           # list all users as csv
$ okta-cli users list \                               # search users with a query
           -f 'profile.email eq "my@email.com"'
$ okta-cli users update id012345678 \                 # update a field of a user record
           --set profile.email=my@other.email.com
$ okta-cli groups adduser -g my_group -u my_user      # add a user to a group
$ okta-cli users get my-login -vvvvv                  # see http debug output
$ okta-cli users bulk-add add-list.csv                # Bulk-ADD users
$ okta-cli users bulk-update update-list.xlsx         # Bulk-UPDATE users

$ okta-cli features -h                                # get help
$ okta-cli features list                              # list okta server-side features
$ okta-cli features enable "Recent Activity"          # enable an Okta feature

# new in 19.0.0
$ okta-cli logs list --since 2026-09-01T00:00:00.000Z # tail the system log since a timestamp
$ okta-cli policies list -t PASSWORD                  # list policies of a given type
$ okta-cli schemas user add-property \                # add a custom property to the user schema
           -n employeeLevel -t integer
$ okta-cli users roles some-login                     # list a user's admin role assignments
$ okta-cli inlinehooks list                           # list inline hooks

# new in 19.1.0
$ okta-cli auth-servers scopes default                # list a custom authorization server's scopes
$ okta-cli devices list --search 'status eq "ACTIVE"' # list active devices
$ okta-cli mappings list --source-id <id>             # list profile mappings for a source

# new in 19.2.0
$ okta-cli brands themes runlayer                     # list a brand's themes (brand name or id)
$ okta-cli ssf stream-status --stream-id <id>         # check an SSF stream's status
$ okta-cli agent-pools list                           # list on-prem agent pools
$ okta-cli pam service-accounts list                  # list privileged access service accounts
$ okta-cli oin api-services                           # list OIN API service integration instances

# new in 19.3.0
$ okta-cli apps secrets my-oidc-app                   # list an OIDC app's client secrets
$ okta-cli users factor-enroll my-login \             # enroll an SMS factor for a user
           -s factorType=sms -s provider=OKTA \
           -s profile.phoneNumber=+15555550100
$ okta-cli users role-targets my-login <assignmentId> # list a role assignment's group/app targets
$ okta-cli idps signing-keys my-idp                   # list an IdP's signing key credentials

$ okta-cli version                                    # print version and exit
```

## Configuration

Running `config new` (see above) stores a JSON configuration file in an OS-specific
directory:

- macOS: `~/Library/Application Support/okta-cli/config.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/okta-cli/config.json`
- Windows: `%LOCALAPPDATA%\okta-cli\okta-cli\config.json`

`OKTA_CLI_CONFIG` overrides the config file path entirely. `OKTA_URL` and `OKTA_TOKEN`, set
together, bypass the config file and profile system altogether.

## CSV / Excel file formats

The commands `bulk-add` and `bulk-update` can read from CSV or Excel. Consider this:

**CSV:**

* the first line _MUST_ be a header line (yes, also in Excel).
* for the command `bulk-add` there _MUST_ be a `profile.login` column, and there _MUST NOT_ be an `id` column.
* for the command `bulk-update` there _MUST_ be either a `profile.login` or an `id` column, the latter has preference.
* all other will most probably refer to profile fields, and map to the add/update API call.
  * most probably you will want to have `profile.FIELD` columns (e.g. `profile.firstName`, `profile.zipCode`, ...).
  * you can see the valid standard field names here: https://developer.okta.com/docs/reference/api/schemas/#user-profile-base-subschema.
* all columns which do not contain a "." are _ignored_.

**Excel:**

* There _MUST NOT_ be any formulas.
* Behavior with more than one sheet is undefined.
* Apart from that, be aware of number formatting, which is _most probably_ not respected by `okta-cli`.
* Otherwise, the same restrictions as for csv files apply.

**Remarks:**

* Some fields have value limitations on the Okta side
  * e.g. `profile.preferredLanguage` must be a valid two-letter country code

**Example:**

In this example, the columns "country" and "gender" are ignored – their name does not contain a ".".

```csv
profile.login,profile.firstName,profile.lastName,profile.email,gender,profile.streetAddress,profile.zipCode,profile.city,country,profile.countryCode
ibrabben0@prlog.org,Iosep,Brabben,ibrabben0@prlog.org,Male,7931 Division Point,86983 CEDEX,Futuroscope,France,FR
```

(those fields are not part of Okta's standard field set, and this is an easy way to exclude columns from being used)

### CSV files with only one column

If for any reason you want to create a CSV file with only one column, do it like this:

```csv
profile.login,
my@email.com,
```

Note the trailing comma.

Reasoning: `okta-cli` tries to determine the column separator, and without one ... determination is tricky, and `okta-cli` will shamelessly crash.

## Output formats

Commands that return an object or a list support `-j/--json` (indented, sorted keys),
`-y/--yaml`, `--csv` (`--csv-dialect excel|excel-tab|unix`, sorted dotted keys) and, for
commands with default fields, a table (`--output-fields <csv>` to override, `--colwidth <n>`
to truncate cells). Commands that print a plain confirmation string (e.g. `users
sessions-revoke`, `tokens revoke`, `users unlink`) only take `-v`.

With no output flag: commands that have default table fields print a table if the result is
non-empty, otherwise JSON; commands without default table fields always print JSON.

## Exit codes

- `0`: success
- `1`: CLI usage error (bad flags/arguments)
- `253`: Okta API error (`OKTA_API_ERROR: <code>: <summary>` on stdout, one `errorSummary:`
  line per cause)
- `254`: unexpected/internal error (stack trace + `CRITICAL_ERROR` banner on stderr)
- `255`: `ERROR:`/`COMMUNICATION_ERROR:` (stderr)

## Development

```bash
bun install
bun run check       # typecheck + bun test
bun run gen:types    # regenerate src/okta/schema.d.ts and spec-paths.json from the pinned spec
bun run build        # bun build --compile -> dist/okta-cli
```

Types are generated from the Okta management OpenAPI spec, pinned to version `2026.08.4`
(see `scripts/gen-types.ts`). Bumping the pin requires re-running `gen:types` and `check`.

## Compatibility notes

19.0.0 is drop-in compatible with 18.1.2's command surface (arguments, flags, default table
fields, message strings and exit codes), with these intentional deviations:

Bug fixes carried over from Python (behavior differs from 18.1.2, matches what 18.1.2 should
have done):

- `eventhooks activate` actually activates instead of erroring.
- `groups clear` deletes the resolved group's id from the URL path instead of the raw
  argument.
- `config current-context` prints `No profile set.` instead of silently printing nothing.
- `groups list -a` is a flag (`--all`) instead of erroring because it expected a value.

Other intentional deviations, all judgment calls where 18.1.2's behavior wasn't worth
matching exactly:

- `groups rules list` uses `--search <text>` with no `-s` short form, because `-s` is taken
  by `--set` on the shared option set.

- Sorting uses locale-aware string comparison (JavaScript's default `Array.sort`/
  `localeCompare`), not Python's code-point `sorted()`.
- `dump`'s default output directory name uses a UTC timestamp, not local time.
- CLI usage errors (bad flags/arguments) exit `1`; 18.1.2's Click-based CLI exited `2`.
- Commands whose 18.1.2 default table fields were empty (`users activate`,
  `users reactivate`, `apps addgroup`, `apps groups`, `raw`) print JSON by default instead of
  an empty table.
- `users get` with an id-shaped argument (starts with `0`, 20 characters) that 404s falls
  back to a login/search lookup instead of exiting with the Okta API error.
- JSON output is UTF-8 and does not escape non-ASCII characters; 18.1.2 escaped them by
  default when no `-j` flag was given.
- A `429` is retried up to 10 times, sleeping until `X-Rate-Limit-Reset`, then fails with
  `COMMUNICATION_ERROR`; 18.1.2 retried forever. On rate-limited orgs, pass a lower
  `-w`/`--workers` to `bulk-add`/`bulk-update`/`dump`.
- `-f`/`--user-lookup-field` values other than `login` still probe `GET /users/{value}`
  first before falling back to a profile-field search, same as 18.1.2.

As of 19.3.0, the CLI covers every path family of the pinned spec that has documented
operations, except end-user-facing flows and group-rules-by-user
(`/groups/{groupId}/users/{userId}/group-rules`, declared in the spec with no operations).

## References

This project uses a few nice other projects:

- [Bun](https://bun.sh)
- [Commander.js](https://github.com/tj/commander.js)
- [openapi-typescript](https://openapi-ts.dev/)
