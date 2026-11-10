# DSH Workbench 0.3.1

A local Cordis plugin that adds a task workbench to the native DeepSeek Harness web client. It provides a native Superagent panel and a standalone /workbench dashboard for task records, follow-ups, reports, and registered artifacts.

## Requirements and setup

Requires Node.js 24.9 or newer and a compatible DSH 0.2.2-rc.1 profile.

1. Configure project roots in config/projects.json.
2. Run `npm ci`, then `npm run build:client` and `npm start` to start the dedicated local host. On first start, its launcher initializes a dedicated DSH profile with this plugin enabled.
3. Open the native sidebar entry or /workbench. The standalone dashboard uses a local operator token; native DSH authentication remains separate.

The standalone dashboard follows the browser language on first use (English or Simplified Chinese) and provides a language selector. The native panel follows the DSH language setting. Task content, reports, artifact names, project names, and identifiers are shown as provided.

Optional inbound webhook configuration belongs in a local config/ingress.json, which is ignored by Git. Runtime data and secrets stay under .dsh-home/ and .workbench/ in the working copy. Do not publish those files.

## Features and boundaries

The dashboard supports task search and state filters, project views, persistent follow-up drafts, stop confirmation, public work records, and verified artifact preview/download. Project bindings are fixed when a task is created. The project settings view is read-only; explicitly register roots and unique IDs in config/projects.json, then restart the host. The interface does not scan the disk.

Operator authentication is local and separate from model credentials. The task inspector reports known model routing without claiming that credentials or inference were verified. Inputs are retained when a model is unavailable. Actual model-driven autonomous reasoning and team execution have not been verified.

Only bounded public text, tool names, structured reports, and operator input are shown. Reasoning, system context, and raw tool arguments are not exposed. Native tool permissions are managed by the DSH Profile. A project binding or write-scope hint is not an operating-system sandbox. Artifact preview is limited to supported plain-text files up to 64 KiB. Instant messaging is paused; external messages are not sent automatically.

## Local checks

- npm test runs the unit, native, profile, and security regression tests.
- npm run check checks JavaScript syntax.
- npm run build:client builds the native client bundle.
- npm run test:host runs the local host end-to-end suite and may require host socket permissions.
- npm run test:superagent:host runs the Superagent host suite.
- Set `CHROME_BIN` when host tests need a non-default Chrome or Chromium executable.

## Attribution and license

MIT, AyahaShirane. This project integrates DeepSeek Harness and preserves upstream notices. Its task/outbox approach was informed by the separately licensed DSH Superagent research prototype; see NOTICE. Dependencies retain their own licenses.
