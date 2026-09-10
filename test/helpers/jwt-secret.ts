// Side-effect import: must come before anything that loads server/auth.ts,
// which captures JWT_SECRET at module load. ESM evaluates imports in order,
// so a later `process.env.JWT_SECRET = ...` in the test body is too late.
process.env.JWT_SECRET = "integration-test-secret";
