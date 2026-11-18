# Accessibility

## Our commitment

Velvarr must work for every household member, also with a keyboard, a screen reader, or reduced motion. When a part of the app blocks you, we treat that as a bug.

## Supported environments

- Current desktop versions of Chromium-based browsers, Firefox, and Safari. These are the default browser targets of Next.js, which builds the app.
- Phones and tablets in the browser, or as an app that you add to the home screen ([phone access](docs/install.md#phone-access)).
- The automated browser tests run only in Chromium with a desktop viewport. Other browsers get no automated check.

## What is in place

- A skip link moves the keyboard focus to the main content.
- Keyboard focus shows a visible ring (`:focus-visible`).
- Sheets and modals use the native `<dialog>` element.
- A form field with an error has `aria-invalid` and points to its error text with `aria-describedby`.
- The `prefers-reduced-motion` setting makes all animations and transitions almost instant.
- On touch screens, most buttons, inputs, and navigation items have a minimum target size of 44 px.
- The color tokens have measured contrast ratios. [`src/app/globals.css`](src/app/globals.css) lists them. These ratios are design targets. No automated test measures them.
- The settings browser tests check that the keyboard focus goes to the correct field after some actions.

## Known limits

- No accessibility audit was done. No automated test checks conformance to WCAG. Thus, Velvarr claims no WCAG conformance level.
- No test was done with a screen reader.
- Posters and photos come from TPDB and StashDB. Their text alternative is only the title or the name.
- Velvarr has only a dark theme.
- Video playback occurs in Jellyfin. Velvarr has no control over the accessibility of the player.
- On touch screens, checkboxes and radio buttons do not get the 44 px minimum target size. Some checkbox rows, for example the account permission rows, are smaller than 44 px.

## Report a barrier

[Open an issue](https://github.com/Skare69/velvarr/issues/new?template=bug_report.yml&labels=accessibility) with the `accessibility` label. Write these items:

- The page and the task that you tried to do.
- What blocked you.
- Your browser, your device, and your assistive technology, if you use one.

For a security problem, use [private vulnerability reporting](SECURITY.md) and not an issue.
