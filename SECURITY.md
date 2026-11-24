# Security policy

## Supported versions

Only the latest release receives fixes. The Windows app updates itself; the web app updates on reload.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub: [Security › Report a vulnerability](https://github.com/MrScothh/ulog-studio/security/advisories/new).

Include what an attacker could do, the affected flavour (Windows app, web app, single file), the version, and the steps or a file that reproduces it. If the report needs a flight log, a log crafted for the purpose is best; do not send logs from real flights unless you are fine with sharing them.

You should get an answer within a week. Once a fix is released, the advisory is published with credit to the reporter (unless you prefer otherwise).

## Scope

Of particular interest:

- crafted `.ulg` or `.params` files that crash the parser in a way that affects more than the current tab, or run code;
- the desktop updater (signature checks, the update manifest, the download source);
- anything that sends log content or file paths off the machine.

The app processes untrusted files locally and has no server side; the web app is static and served by GitHub Pages.
