# Known Issues

- The extension and helper are scaffolds only.
- Native Messaging is not implemented.
- CDP capture is not implemented.
- Offline rewriting and validation are not implemented.
- Internal package declaration files are not generated because TypeScript 6 and the current tsup
  declaration pipeline disagree on deprecated `baseUrl` behavior. Workspace consumers use source
  types; runtime builds are valid.
