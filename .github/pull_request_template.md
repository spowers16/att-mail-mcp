## Summary

<!-- What changes, and why. -->

## Checklist

- [ ] `npm run check` and `npm run scan` pass locally
- [ ] No credentials, real email content, personal paths or generated files are included
- [ ] New or changed tools are classified in `server/src/operation-policy.ts` and tested in each operation mode
- [ ] Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) are accurate
- [ ] Documentation and `CHANGELOG.md` are updated for user-visible changes
- [ ] Any testing against a real mailbox was separately authorized, as described in `docs/ACCEPTANCE.md`
